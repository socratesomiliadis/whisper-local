// Exercise the complete workspace with deterministic jobs and real browser storage.
// Network routing supplies the app and API; this never starts a server or model.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const python = process.env.PYTHON || "python";
const origin = "http://127.0.0.1:8765";
const assets = path.join(root, "src/whisper_local/static");
const artifacts = path.join(root, "test-results");
const html = execFileSync(
  python,
  [
    "-c",
    "from whisper_local.app import app; app.testing=True; print(app.test_client().get('/').data.decode().replace(__import__('whisper_local.app',fromlist=['TOKEN']).TOKEN,'qa-token'))",
  ],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  },
);

function audioFile(name) {
  const dataBytes = 16000 * 2 * 12;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return { name, mimeType: "audio/wav", buffer };
}

function completed(index) {
  return {
    state: "complete",
    language: "en",
    device: "cpu",
    elapsed: 0.5,
    text: `Recording ${index} hello. Thank you.`,
    speakers: { A: "Speaker 1", B: "Speaker 2" },
    segments: [
      {
        start: 1,
        end: 2.5,
        text: `Recording ${index} hello.`,
        speaker: "A",
        words: [
          {
            start: 1,
            end: 2.5,
            word: ` Recording ${index} hello.`,
            aligned: true,
          },
        ],
      },
      {
        start: 2.5,
        end: 6,
        text: "Thank you.",
        speaker: "B",
        words: [{ start: 2.5, end: 6, word: " Thank you.", aligned: true }],
      },
    ],
    range_start: 1,
    range_end: 6,
    duration: 12,
  };
}

async function downloadText(page, id) {
  const ready = page.waitForEvent("download");
  await page.locator(`#${id}`).click();
  const download = await ready;
  return {
    name: download.suggestedFilename(),
    text: fs.readFileSync(await download.path(), "utf8"),
  };
}

async function run() {
  fs.mkdirSync(artifacts, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 1100 },
      acceptDownloads: true,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const errors = [];
    const submissions = [];
    const jobs = new Map();
    let active = null;
    let holdJobs = false;
    await context.route(`${origin}/**`, async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/")
        return route.fulfill({ contentType: "text/html", body: html });
      if (pathname.startsWith("/static/")) {
        const filename = path.basename(pathname);
        return route.fulfill({
          contentType: filename.endsWith(".js")
            ? "text/javascript"
            : filename.endsWith(".css")
              ? "text/css"
              : "image/svg+xml",
          body: fs.readFileSync(path.join(assets, filename)),
        });
      }
      assert.equal(request.headers()["x-app-token"], "qa-token");
      if (pathname === "/api/status")
        return route.fulfill({
          json: {
            whisper: true,
            acceleration: { gpu_available: false },
            speakers: { installed: true, ready: true, state: "complete" },
          },
        });
      if (pathname === "/api/transcribe") {
        assert.equal(
          active,
          null,
          "Queue must submit only after the previous job finishes",
        );
        const body = request.postDataBuffer().toString("utf8");
        const fields = {};
        for (const key of [
          "model",
          "quality",
          "language",
          "processing",
          "detect_speakers",
          "num_speakers",
          "start_time",
          "end_time",
        ]) {
          fields[key] = body.match(
            new RegExp(`name="${key}"\\r\\n\\r\\n([^\\r\\n]*)`),
          )?.[1];
        }
        const filename = body.match(/name="audio"; filename="([^"]+)"/)?.[1];
        submissions.push({ filename, fields });
        const id = `fixture-${submissions.length}`;
        jobs.set(id, {
          index: submissions.length,
          polls: 0,
          hold: holdJobs,
          cancelled: false,
        });
        active = id;
        return route.fulfill({ status: 202, json: { job_id: id } });
      }
      const match = pathname.match(/^\/api\/jobs\/(fixture-\d+)(\/cancel)?$/);
      if (match) {
        const job = jobs.get(match[1]);
        assert(job, "Poll must reference a submitted job");
        if (match[2]) {
          assert.equal(request.method(), "POST");
          job.cancelled = true;
          return route.fulfill({ status: 202, json: { state: "cancelling" } });
        }
        if (job.cancelled) {
          active = null;
          return route.fulfill({
            json: { state: "cancelled", message: "Cancelled." },
          });
        }
        if (++job.polls === 1 || job.hold)
          return route.fulfill({
            json: {
              state: "running",
              stage: "transcribing",
              progress: 0.4,
              message: "Transcribing fixture…",
            },
          });
        active = null;
        return route.fulfill({ json: completed(job.index) });
      }
      throw new Error(
        `Unexpected workspace request: ${request.method()} ${pathname}`,
      );
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(15000);
    await page.goto(origin);
    await page.waitForFunction(() =>
      document.querySelector("#acceleration").textContent.includes("CPU"),
    );
    await page.locator("#quality").selectOption("accurate");
    await page.locator("#language").selectOption("en");
    await page.locator("#advanced-settings").click();
    assert.equal(await page.locator("#model").inputValue(), "small");
    await page.locator("#detect-speakers").check();
    await page.locator("#speaker-count").fill("2");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page
      .locator("summary")
      .filter({ hasText: /^Storage preferences$/ })
      .click();
    await page.locator("#retain-audio").check();
    await page
      .locator("#file")
      .setInputFiles([audioFile("first.wav"), audioFile("δεύτερο.wav")]);
    await page.waitForFunction(
      () => document.querySelector("#audio-player").readyState >= 1,
    );
    await page
      .locator("summary")
      .filter({ hasText: /^Playback and audio range$/ })
      .click();
    await page.locator("#range-start").fill("1");
    await page.locator("#range-start").dispatchEvent("change");
    await page.locator("#range-end").fill("6");
    await page.locator("#range-end").dispatchEvent("change");
    await page.locator("#transcribe").click();
    await page.waitForFunction(
      () => document.querySelector("#progress-percent").textContent === "40%",
    );
    assert.equal(
      await page.locator("#progress-stage").textContent(),
      "Transcribing",
    );
    assert.equal(
      await page.locator("#progress-bar").getAttribute("value"),
      "0.4",
    );
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#queue-list .item-state")].filter(
          (node) => node.textContent === "complete",
        ).length === 2,
    );
    await page.waitForFunction(
      () => !document.querySelector("#transcribe").disabled,
    );
    assert.deepEqual(
      submissions.map((submission) => submission.filename),
      ["first.wav", "δεύτερο.wav"],
    );
    assert.deepEqual(submissions[0].fields, {
      model: "small",
      quality: "accurate",
      language: "en",
      processing: "auto",
      detect_speakers: "true",
      num_speakers: "2",
      start_time: "1",
      end_time: "6",
    });
    assert.equal(
      submissions[1].fields.start_time,
      undefined,
      "Each recording must retain its own range",
    );
    await page.waitForFunction(
      () => document.querySelectorAll("#history-list li").length === 2,
    );

    await page
      .locator("#queue-list .item-open")
      .filter({ hasText: "first.wav" })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector("#transcript")
        .value.includes("Recording 1 hello."),
    );
    const segment = page.getByRole("textbox", {
      name: "Edit segment 1",
      exact: true,
    });
    await segment.fill("Corrected hello. [verified]");
    await segment.press("Control+z");
    assert.equal(await segment.inputValue(), "Recording 1 hello.");
    const undone = await downloadText(page, "save-json");
    assert(JSON.parse(undone.text).segments[0].words);
    await segment.press("Control+Shift+z");
    assert.equal(await segment.inputValue(), "Corrected hello. [verified]");
    await page
      .locator("summary")
      .filter({ hasText: /^Speaker names$/ })
      .click();
    await page
      .getByRole("textbox", { name: "Rename Speaker 1", exact: true })
      .fill("Alex");
    await page
      .locator("summary")
      .filter({ hasText: /^Find and replace$/ })
      .click();
    await page.locator("#search-text").fill("hello");
    await page.locator("#search-next").click();
    assert.equal(await page.locator("#search-count").textContent(), "1 of 1");
    await page.locator("#audio-player").evaluate((audio) => {
      audio.pause();
      audio.currentTime = 3;
      audio.dispatchEvent(new Event("timeupdate"));
    });
    assert.equal(
      await page.locator(".segment.active").getAttribute("data-index"),
      "1",
    );
    await page.locator("#copy").click();
    let plain = await page.locator("#transcript").inputValue();
    await page.locator("#copy").click();
    assert.equal(
      (await page.evaluate(() => navigator.clipboard.readText())).replace(
        /\r\n/g,
        "\n",
      ),
      plain,
    );
    for (const format of ["txt", "srt", "vtt", "json"]) {
      const downloaded = await downloadText(page, `save-${format}`);
      assert.equal(downloaded.name, `first.${format}`);
      assert.match(downloaded.text, /Corrected hello\. \[verified\]/);
      assert(!downloaded.text.includes("Recording 1 hello."));
      if (format === "txt") assert.equal(downloaded.text.trim(), plain);
      if (format === "json") {
        const result = JSON.parse(downloaded.text);
        assert.equal(result.text, plain);
        assert.equal(
          result.segments[0].words,
          undefined,
          "Edited text must clear its original word alignment",
        );
        assert.deepEqual(
          result.segments[1].words,
          completed(1).segments[1].words,
          "Unedited segments must retain word alignment",
        );
      }
      if (format === "vtt") assert(downloaded.text.startsWith("WEBVTT\n"));
    }
    const zipReady = page.waitForEvent("download");
    await page.locator("#download-batch").click();
    const zip = await zipReady;
    assert.equal(zip.suggestedFilename(), "whisper-transcripts.zip");
    const contents = JSON.parse(
      execFileSync(
        python,
        [
          "-c",
          "import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n:z.read(n).decode('utf-8') for n in z.namelist()},ensure_ascii=False))",
          await zip.path(),
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        },
      ),
    );
    assert.equal(Object.keys(contents).length, 8);
    assert.equal(contents["001-first.txt"].trim(), plain);
    assert.match(contents["002-δεύτερο.txt"], /Recording 2 hello/);
    assert.equal(JSON.parse(contents["001-first.json"]).text, plain);

    // Reopen a rendered library row before the save debounce expires. The row's
    // original closure must not overwrite the latest editor snapshot.
    await segment.fill("Corrected hello. [verified] Fresh edit.");
    plain = await page.locator("#transcript").inputValue();
    await page
      .locator("#history-list .item-open")
      .filter({ has: page.locator("strong", { hasText: /^first$/ }) })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector("#status")
        .textContent.startsWith("Saved transcript opened"),
    );
    assert.equal(await page.locator("#transcript").inputValue(), plain);

    await page.reload();
    await page.waitForFunction(
      () => document.querySelectorAll("#history-list li").length === 2,
    );
    assert.equal(await page.locator("#quality").inputValue(), "accurate");
    await page
      .locator("#history-list .item-open")
      .filter({ has: page.locator("strong", { hasText: /^first$/ }) })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#results").hidden,
    );
    assert.equal(await page.locator("#transcript").inputValue(), plain);
    assert(await page.locator("#audio-player").isVisible());
    assert.match(await page.locator("#status").textContent(), /with audio/);
    await page
      .locator("summary")
      .filter({ hasText: /^Storage preferences$/ })
      .click();
    await page.locator("#retain-audio").uncheck();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#history-list li")].some(
        (node) =>
          node.querySelector("strong")?.textContent === "first" &&
          node.textContent.includes("Transcript only"),
      ),
    );
    await page.reload();
    await page.waitForFunction(
      () => document.querySelectorAll("#history-list li").length === 2,
    );
    await page
      .locator("#history-list .item-open")
      .filter({ has: page.locator("strong", { hasText: /^first$/ }) })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#results").hidden,
    );
    assert(await page.locator("#audio-player").isHidden());
    assert.equal(await page.locator("#transcript").inputValue(), plain);
    assert.match(await page.locator("#status").textContent(), /Attach audio/);
    assert.equal(await page.locator("#attach-audio").count(), 1);
    await page.locator("#attach-audio").setInputFiles(audioFile("first.wav"));
    await page.waitForFunction(
      () => !document.querySelector("#audio-player").hidden,
    );
    assert.equal(await page.locator("#transcript").inputValue(), plain);
    await page
      .getByRole("button", {
        name: "Delete saved transcript first",
        exact: true,
      })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll("#history-list li").length === 1,
    );
    await page
      .locator("summary")
      .filter({ hasText: /^Storage preferences$/ })
      .click();
    await page.locator("#save-history").uncheck();
    const remaining = await page.evaluate(async () =>
      (await new LocalLibrary().list()).map((record) => record.id),
    );

    holdJobs = true;
    await page
      .locator("#file")
      .setInputFiles([audioFile("cancel.wav"), audioFile("waiting.wav")]);
    await page.locator("#transcribe").click();
    await page.waitForFunction(
      () => document.querySelector("#progress-percent").textContent === "40%",
    );
    await page.locator("#cancel-job").click();
    await page.waitForFunction(
      () => !document.querySelector("#transcribe").disabled,
    );
    assert.equal(
      submissions.length,
      3,
      "Cancelling must pause remaining queue entries",
    );
    assert.deepEqual(
      await page.locator("#queue-list .item-state").allTextContents(),
      ["cancelled", "queued"],
    );
    assert.deepEqual(
      await page.evaluate(async () =>
        (await new LocalLibrary().list()).map((record) => record.id),
      ),
      remaining,
    );
    holdJobs = false;
    await page.locator("#transcribe").click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#queue-list .item-state")].some(
        (node) => node.textContent === "complete",
      ),
    );
    await page.waitForFunction(
      () => !document.querySelector("#transcribe").disabled,
    );
    assert.equal(submissions.at(-1).filename, "waiting.wav");
    assert.deepEqual(
      await page.evaluate(async () =>
        (await new LocalLibrary().list()).map((record) => record.id),
      ),
      remaining,
      "Disabling autosave must keep existing records without saving new results",
    );
    await page.locator("#clear-history").click();
    await page
      .getByRole("button", { name: "Delete saved transcripts", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll("#history-list li").length === 0,
    );

    for (const viewport of [
      { width: 1400, height: 1100 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `Layout overflows at ${viewport.width}px`,
      );
      await page.screenshot({
        path: path.join(artifacts, `workspace-${viewport.width}.png`),
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    console.log(
      "Workspace browser checks passed: sequential queue, quality/range, progress/cancel, editing/undo/search, playback, copy and four exports, ZIP checksums/Unicode, library reload/audio/delete/autosave, responsive layout.",
    );
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
