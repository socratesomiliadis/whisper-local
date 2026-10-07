// Exercise the real page with deterministic API responses; no server or weights.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const assets = path.join(root, "src/whisper_local/static");
const artifacts = path.join(root, "test-results");
const origin = "http://127.0.0.1:8765";
const html = execFileSync(
  process.env.PYTHON || "python",
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

const fixture = {
  state: "complete",
  text: "Hello there. Yes, let's start.",
  language: "en",
  segments: [
    { start: 0, end: 1.1, text: "Hello there.", speaker: "A" },
    { start: 1.1, end: 3, text: "Yes, let's start.", speaker: "B" },
  ],
  speakers: { A: "Speaker 1", B: "Speaker 2" },
  device: "cuda",
  elapsed: 0.9,
  gpu_fallback: false,
  warning: null,
  srt: "1\n00:00:00,000 --> 00:00:01,100\nSpeaker 1: Hello there.\n\n2\n00:00:01,100 --> 00:00:03,000\nSpeaker 2: Yes, let's start.\n",
};

function wavFixture() {
  const buffer = Buffer.alloc(64044);
  buffer.write("RIFF");
  buffer.writeUInt32LE(64036, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(64000, 40);
  return { name: "example.wav", mimeType: "audio/wav", buffer };
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
      viewport: { width: 1320, height: 1100 },
      acceptDownloads: true,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    let ready = false,
      downloading = false,
      setupPolls = 0,
      detectSpeakers = true;
    const errors = [];
    const speakerStatus = () => ({
      ready,
      installed: true,
      state: downloading ? "downloading" : ready ? "complete" : "idle",
      message: "Speaker setup required.",
    });
    await context.route(`${origin}/**`, async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/")
        return route.fulfill({ contentType: "text/html", body: html });
      if (pathname.startsWith("/static/")) {
        const name = path.basename(pathname);
        return route.fulfill({
          contentType: name.endsWith(".css")
            ? "text/css"
            : name.endsWith(".js")
              ? "text/javascript"
              : "image/svg+xml",
          body: fs.readFileSync(path.join(assets, name)),
        });
      }
      assert.equal(request.headers()["x-app-token"], "qa-token");
      if (pathname === "/api/status")
        return route.fulfill({
          json: {
            whisper: true,
            speakers: speakerStatus(),
            acceleration: { gpu_available: true, gpu_name: "NVIDIA GPU" },
          },
        });
      if (pathname === "/api/speakers/setup") {
        assert.equal(request.postDataJSON().token, "hf_TEST_ONLY");
        downloading = true;
        return route.fulfill({ status: 202, json: { state: "downloading" } });
      }
      if (pathname === "/api/speakers/status") {
        if (++setupPolls >= 2) {
          downloading = false;
          ready = true;
        }
        return route.fulfill({ json: speakerStatus() });
      }
      if (pathname === "/api/transcribe") {
        const body = request.postDataBuffer().toString();
        detectSpeakers = /name="detect_speakers"\r\n\r\ntrue/.test(body);
        assert.match(body, /name="processing"\r\n\r\nauto/);
        return route.fulfill({ status: 202, json: { job_id: "fixture" } });
      }
      if (pathname === "/api/jobs/fixture") {
        return route.fulfill({
          json: detectSpeakers
            ? fixture
            : {
                ...fixture,
                speakers: {},
                segments: fixture.segments.map(({ speaker, ...row }) => row),
                srt: "1\n00:00:00,000 --> 00:00:03,000\nHello there. Yes, let's start.\n",
              },
        });
      }
      return route.fulfill({ status: 404 });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.locator("#advanced-settings").evaluate((element) => {
      element.open = true;
    });
    assert(!(await page.locator("body").textContent()).includes("\uFFFD"));
    assert(await page.locator("#transcribe").isDisabled());
    await page.locator("#fast-mode").click();
    assert.equal(await page.locator("#model").inputValue(), "tiny");
    assert.equal(await page.locator("#processing").inputValue(), "auto");
    assert(!(await page.locator("#detect-speakers").isChecked()));
    await page.locator("#file").setInputFiles(wavFixture());
    await page.locator("#transcribe").click();
    await page.locator("#results").waitFor({ state: "visible" });
    assert.equal(await page.locator("#transcript").inputValue(), fixture.text);

    await page.locator("#model").selectOption("base");
    await page.locator("#detect-speakers").check();
    assert(await page.locator("#transcribe").isDisabled());
    await page.locator("#hf-token").fill("invalid");
    await page.locator("#setup-speakers").click();
    assert.match(
      await page.locator("#speaker-status").textContent(),
      /starting with hf_/,
    );
    await page.locator("#hf-token").fill("hf_TEST_ONLY");
    await page.locator("#setup-speakers").click();
    await page.locator("#speaker-setup").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#hf-token").inputValue(), "");
    await page.locator("#speaker-count").fill("2");
    await page.locator("#transcribe").click();
    await page.locator("#speaker-names").waitFor({ state: "visible" });
    assert.equal(await page.locator("#speaker-name-fields input").count(), 2);
    const rename = page.getByRole("textbox", {
      name: "Rename Speaker 1",
      exact: true,
    });
    await rename.fill("<b>Alex</b>");
    assert.equal(await page.locator("#speaker-names b").count(), 0);
    assert.match(
      await page.locator("#transcript").inputValue(),
      /<b>Alex<\/b>:/,
    );
    await rename.fill("Alex");
    await page.locator("#timed-view").click();
    assert.equal(
      await page.locator(".speaker-label").first().textContent(),
      "Alex",
    );
    await page.locator("#copy").click();
    const transcript = await page.locator("#transcript").inputValue();
    assert.equal(
      (await page.evaluate(() => navigator.clipboard.readText())).replace(
        /\r\n/g,
        "\n",
      ),
      transcript,
    );
    for (const [id, extension] of [
      ["save-txt", "txt"],
      ["save-srt", "srt"],
    ]) {
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.locator(`#${id}`).click(),
      ]);
      assert.equal(download.suggestedFilename(), `example.${extension}`);
      const target = path.join(artifacts, `example.${extension}`);
      await download.saveAs(target);
      const text = fs.readFileSync(target, "utf8");
      assert.match(text, /Alex:/);
      assert.match(text, /Speaker 2:/);
      if (extension === "srt")
        assert.match(text, /00:00:01,100 --> 00:00:03,000/);
    }
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: path.join(artifacts, "desktop.png"),
      fullPage: true,
    });
    if (process.env.UPDATE_SCREENSHOT === "1")
      fs.copyFileSync(
        path.join(artifacts, "desktop.png"),
        path.join(root, "docs/screenshot.png"),
      );
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: path.join(artifacts, "mobile.png"),
      fullPage: true,
    });
    await page.evaluate(() =>
      sessionStorage.setItem(
        "whisper-job",
        JSON.stringify({ id: "fixture", name: "resumed" }),
      ),
    );
    await page.reload();
    await page.locator("#results").waitFor({ state: "visible" });
    assert.match(await page.locator("#transcript").inputValue(), /Speaker 1:/);
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("whisper-job")),
      null,
    );
    assert.deepEqual(errors, []);
    console.log(
      "Browser checks passed: Fast mode, uploads, speaker setup, safe renaming, copy, TXT/SRT, responsive layout, and refresh recovery.",
    );
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
