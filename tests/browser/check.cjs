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
const pageFixture = JSON.parse(
  execFileSync(
    process.env.PYTHON || "python",
    [
      "-c",
      "import json; from whisper_local.app import app, TOKEN; app.testing=True; response=app.test_client().get('/'); print(json.dumps({'html': response.data.decode().replace(TOKEN, 'qa-token'), 'csp': response.headers['Content-Security-Policy']}))",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    },
  ),
);

async function assertStableRecordingHeight(page) {
  const sizes = await page.evaluate(async () => {
    const frame = () => new Promise(requestAnimationFrame);
    await frame();
    await frame();
    const samples = [];
    const end = performance.now() + 1000;
    while (performance.now() < end) {
      samples.push({
        page: document.documentElement.scrollHeight,
        voice: document.querySelector("[data-voice-beam]").clientHeight,
      });
      await frame();
    }
    return samples;
  });
  for (const area of ["page", "voice"]) {
    const heights = sizes.map((sample) => sample[area]);
    assert(
      Math.max(...heights) - Math.min(...heights) <= 1,
      `${area} height grew while recording: ${heights.join(", ")}`,
    );
  }
}

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

async function chooseTheme(page, name) {
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: `Theme: ${name}`, exact: true })
    .waitFor();
}

async function assertTheme(page, expected) {
  await page.waitForFunction(
    (theme) => document.documentElement.dataset.theme === theme,
    expected,
  );
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    ),
    expected,
  );
}

async function assertThemes(page, context) {
  // The saved theme must apply before React mounts, under the production CSP.
  assert.deepEqual(await page.evaluate(() => themeAtStartup), {
    theme: "dark:dark",
    mounted: false,
  });
  await assertTheme(page, "dark");
  await page.screenshot({
    path: path.join(artifacts, "theme-dark.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /^Theme:/ }).click();
  assert.equal(
    await page
      .getByRole("menuitemradio", { name: "Dark", exact: true })
      .getAttribute("aria-checked"),
    "true",
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.waitForFunction(
    () =>
      getComputedStyle(
        document.querySelector('[data-slot="dropdown-menu-content"]'),
      ).opacity === "1",
  );
  await page.screenshot({
    path: path.join(artifacts, "theme-dark-mobile.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1320, height: 1100 });
  await page.locator("#advanced-settings").click();
  await page.getByRole("dialog").waitFor();
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('[data-slot="dialog-content"]'))
        .opacity === "1",
  );
  await page.screenshot({
    path: path.join(artifacts, "theme-dark-settings.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Done", exact: true }).click();

  await chooseTheme(page, "System");
  await assertTheme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await assertTheme(page, "dark");
  await chooseTheme(page, "Light");
  await assertTheme(page, "light");
  await page.emulateMedia({ colorScheme: "light" });
  await chooseTheme(page, "Dark");
  await assertTheme(page, "dark");
  await page.reload();
  await page
    .getByRole("button", { name: "Theme: Dark", exact: true })
    .waitFor();
  await assertTheme(page, "dark");

  // A keyboard user can select Light and regain focus on the trigger.
  const trigger = page.getByRole("button", {
    name: "Theme: Dark",
    exact: true,
  });
  await trigger.focus();
  await trigger.press("Enter");
  await page
    .getByRole("menuitemradio", { name: "Light", exact: true })
    .waitFor();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await assertTheme(page, "light");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "Theme: Light",
  );
  assert(
    await page
      .getByRole("button", { name: "Theme: Light", exact: true })
      .evaluate((el) => document.activeElement === el),
  );

  const other = await context.newPage();
  try {
    await other.goto(origin);
    await other
      .getByRole("button", { name: "Theme: Light", exact: true })
      .waitFor();
    await chooseTheme(page, "Dark");
    await other
      .getByRole("button", { name: "Theme: Dark", exact: true })
      .waitFor();
    await assertTheme(other, "dark");
    await chooseTheme(page, "Light");
    await assertTheme(other, "light");
  } finally {
    await other.close();
  }
}

async function run() {
  fs.mkdirSync(artifacts, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  try {
    const context = await browser.newContext({
      colorScheme: "light",
      storageState: {
        cookies: [],
        origins: [
          { origin, localStorage: [{ name: "whisper-theme", value: "dark" }] },
        ],
      },
      viewport: { width: 1320, height: 1100 },
      acceptDownloads: true,
      permissions: ["clipboard-read", "clipboard-write", "microphone"],
    });
    let ready = false,
      downloading = false,
      releaseSetup = false,
      detectSpeakers = true;
    let holdJob = true;
    let jobStage = "loading";
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
        return route.fulfill({
          contentType: "text/html",
          body: pageFixture.html,
          headers: { "Content-Security-Policy": pageFixture.csp },
        });
      if (pathname.startsWith("/static/")) {
        const name = path.basename(pathname);
        return route.fulfill({
          contentType: name.endsWith(".css")
            ? "text/css"
            : name.endsWith(".js")
              ? "text/javascript"
              : name.endsWith(".woff2")
                ? "font/woff2"
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
        if (releaseSetup) {
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
        if (holdJob)
          return route.fulfill({
            json: { state: "transcribing", stage: jobStage, progress: null },
          });
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
    await page.addInitScript(() => {
      window.addEventListener("whisper-theme-change", () => {
        window.themeAtStartup ??= {
          theme: window.WhisperTheme.getSnapshot(),
          mounted: Boolean(document.getElementById("root")?.childElementCount),
        };
      });
      window.microphoneRequests = 0;
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = (...args) => {
        window.microphoneRequests++;
        return getUserMedia(...args);
      };
    });
    await page.goto(origin);
    await page
      .locator(
        '[data-slot="transcript-avatar"][aria-label="Whisper bot, ready"]',
      )
      .waitFor({ state: "visible" });
    await assertThemes(page, context);
    await page.screenshot({
      path: path.join(artifacts, "effects-idle.png"),
      fullPage: true,
    });
    await page.locator("#advanced-settings").click();
    assert(!(await page.locator("body").textContent()).includes("\uFFFD"));
    assert(await page.locator("#transcribe").isDisabled());
    await page.locator("#fast-mode").click();
    assert.match(await page.locator("#model").textContent(), /Tiny/);
    assert.match(await page.locator("#processing").textContent(), /Automatic/);
    assert(!(await page.locator("#detect-speakers").isChecked()));
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page
      .locator("summary")
      .filter({ hasText: /^Record audio$/ })
      .click();
    await page.locator("#record-start").click();
    await page.waitForFunction(() =>
      document.querySelector("[data-voice-beam][data-active]"),
    );
    assert.equal(await page.evaluate(() => microphoneRequests), 1);
    assert.equal(
      await page.locator("#record-start").getAttribute("aria-pressed"),
      "true",
    );
    await assertStableRecordingHeight(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await assertStableRecordingHeight(page);
    await page.setViewportSize({ width: 1320, height: 1100 });
    await page.locator("#record-pause").click();
    await page.waitForFunction(
      () => !document.querySelector("[data-voice-beam][data-active]"),
    );
    assert.match(
      await page.locator("#recording-status").textContent(),
      /paused/,
    );
    await page.locator("#record-pause").click();
    await page.waitForFunction(() =>
      document.querySelector(
        "[data-voice-beam][data-active]:not([data-paused])",
      ),
    );
    await page.locator("#record-discard").click();
    await page.waitForFunction(
      () => !document.querySelector("[data-voice-beam][data-active]"),
    );
    assert.equal(
      await page.locator("#record-start").getAttribute("aria-pressed"),
      "false",
    );
    await page
      .locator("summary")
      .filter({ hasText: /^Record audio$/ })
      .click();
    await page.locator("#file").setInputFiles(wavFixture());
    await page.locator("#waveform-panel").waitFor({ state: "visible" });
    await page.waitForFunction(() =>
      document.querySelector("#waveform-status").textContent.startsWith("Drag"),
    );
    const waveform = await page
      .locator("#waveform")
      .evaluate((canvas) => canvas.toDataURL());
    await chooseTheme(page, "Dark");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.notEqual(
      await page.locator("#waveform").evaluate((canvas) => canvas.toDataURL()),
      waveform,
    );
    await chooseTheme(page, "Light");
    const idleIcon = await page
      .locator('[data-slot="transcribe-orb"]')
      .boundingBox();
    await page.locator("#transcribe").click();
    assert.equal(
      await page.locator("#transcribe").getAttribute("aria-busy"),
      "true",
    );
    assert.equal(
      await page.locator('[data-slot="transcribe-orb"][data-active]').count(),
      0,
    );
    assert.equal(
      await page
        .locator('[data-slot="transcript-avatar"]')
        .getAttribute("aria-label"),
      "Whisper bot, working",
    );
    await page.waitForFunction(() =>
      document.querySelector('[data-slot="transcribe-orb"][data-active]'),
    );
    assert.equal(
      await page.locator("#transcribe canvas").getAttribute("aria-label"),
      "Working…",
    );
    jobStage = "transcribing";
    await page
      .locator('#transcribe canvas[aria-label="Composing…"]')
      .waitFor({ state: "visible" });
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('[data-slot="transcribe-orb"]'))
          .opacity === "1",
    );
    const workingIcon = await page
      .locator('[data-slot="transcribe-orb"]')
      .boundingBox();
    assert(
      Math.abs(
        idleIcon.x +
          idleIcon.width / 2 -
          (workingIcon.x + workingIcon.width / 2),
      ) <= 1,
      "Button icon shifted when work began",
    );
    assert.equal(
      await page
        .locator('[data-slot="transcribe-orb"]')
        .evaluate((el) => getComputedStyle(el).transitionDuration),
      "0.4s",
    );
    await page.screenshot({
      path: path.join(artifacts, "effects-processing.png"),
      fullPage: true,
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('[data-slot="transcribe-orb"]'))
          .transitionProperty === "none",
    );
    const still = await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const canvases = [
        document.querySelector("#transcribe canvas"),
        document.querySelector('[data-slot="transcript-avatar"]'),
      ];
      const before = canvases.map((canvas) => canvas.toDataURL());
      await new Promise((resolve) => setTimeout(resolve, 200));
      return canvases.map(
        (canvas, index) => canvas.toDataURL() === before[index],
      );
    });
    assert.deepEqual(still, [true, true]);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    holdJob = false;
    await page.locator("#results").waitFor({ state: "visible" });
    assert(await page.locator('[data-slot="transcript-avatar"]').isHidden());
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('[data-slot="transcribe-orb"]'))
          .opacity === "0",
    );
    assert.equal(await page.locator("#transcript").inputValue(), fixture.text);

    await page.locator("#advanced-settings").click();
    await page.locator("#model").click();
    await page
      .getByRole("option", { name: "Base · balanced", exact: true })
      .click();
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
    assert.equal(await page.locator("#setup-speakers canvas").count(), 0);
    await page.locator("#setup-speakers canvas").waitFor({ state: "visible" });
    releaseSetup = true;
    await page.locator("#speaker-setup").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#hf-token").inputValue(), "");
    await page.locator("#speaker-count").fill("2");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.locator("#transcribe").click();
    await page
      .locator("summary")
      .filter({ hasText: /^Speaker names$/ })
      .click();
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
    const speakerSelect = page.getByRole("combobox", {
      name: "Speaker for segment 1",
      exact: true,
    });
    await speakerSelect.click();
    await page.getByRole("option", { name: "Speaker 2", exact: true }).click();
    assert.equal(
      await page.locator(".speaker-label").first().textContent(),
      "Speaker 2",
    );
    await page.locator("#undo-edit").click();
    assert.match(await speakerSelect.textContent(), /Alex/);
    assert.equal(await page.locator("select").count(), 0);
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
    await chooseTheme(page, "Dark");
    await assertTheme(page, "dark");
    await page.evaluate(async () => {
      await document.fonts.ready;
      document.activeElement?.blur();
      scrollTo(0, 0);
    });
    await page.screenshot({
      path: path.join(artifacts, "desktop.png"),
      fullPage: true,
      animations: "disabled",
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
      "Browser checks passed: themes, persistence, system preference, keyboard controls, tab synchronization, waveform recoloring, live voice and stable recording height, pause/resume, button orb transitions, bot avatar, reduced motion, Fast mode, uploads, speaker setup, safe renaming, copy, TXT/SRT, responsive layout, and refresh recovery.",
    );
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
