// Test real browser waveform and MediaRecorder behavior without a server or model.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");

const origin = "http://localhost:8766";
const fixture = `<!doctype html><html><body>
<audio id="audio-player" controls></audio>
<div id="waveform-panel"><canvas id="waveform" style="width:600px;height:80px"></canvas>
<p id="waveform-status"></p><input id="range-start" type="number"><input id="range-end" type="number">
<button id="range-reset">Reset</button><select id="playback-speed"><option value="1">1</option><option value="1.5">1.5</option></select>
<button id="skip-back">Back</button><button id="skip-forward">Forward</button></div>
<button id="record-start">Record</button><button id="record-pause"><svg></svg><span data-label>Pause</span></button>
<button id="record-stop">Stop</button><button id="record-discard">Discard</button>
<p id="recording-status"></p><span id="recording-time"></span></body></html>`;

async function run() {
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
    const context = await browser.newContext({ permissions: ["microphone"] });
    await context.route(`${origin}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: fixture }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.addScriptTag({
      path: path.resolve(__dirname, "../../src/whisper_local/static/media.js"),
    });
    await page.evaluate(async () => {
      window.recorded = [];
      window.recordingStates = [];
      window.recordingStreams = [];
      window.statusMessages = [];
      window.workspace = new AudioWorkspace({
        onRecorded: (file) => recorded.push(file),
        onRecordingChange: (active) => recordingStates.push(active),
        onRecordingStreamChange: (stream, paused) =>
          recordingStreams.push({ stream: Boolean(stream), paused }),
        onStatus: (message) => statusMessages.push(message),
      });
      // Two seconds of PCM silence: metadata and browser decoding are real.
      const bytes = new ArrayBuffer(64044);
      const view = new DataView(bytes);
      const ascii = (offset, value) =>
        [...value].forEach((character, index) =>
          view.setUint8(offset + index, character.charCodeAt(0)),
        );
      ascii(0, "RIFF");
      view.setUint32(4, 64036, true);
      ascii(8, "WAVEfmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 16000, true);
      view.setUint32(28, 32000, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      ascii(36, "data");
      view.setUint32(40, 64000, true);
      window.audioFile = new File([bytes], "test.wav", { type: "audio/wav" });
      document.getElementById("audio-player").src =
        URL.createObjectURL(audioFile);
      await workspace.load(audioFile);
    });
    assert.equal(await page.evaluate(() => workspace.duration), 2);
    assert.equal(await page.evaluate(() => workspace.peaks.length), 1600);
    await page.locator("#range-start").fill("0.2");
    await page.locator("#range-end").fill("1.5");
    await page.locator("#range-end").blur();
    assert.deepEqual(await page.evaluate(() => workspace.range()), {
      start: 0.2,
      end: 1.5,
    });
    await page.locator("#range-end").fill("0.1");
    await page.locator("#range-end").blur();
    assert.equal(
      await page
        .locator("#range-end")
        .evaluate((input) => input.checkValidity()),
      false,
    );
    assert.deepEqual(await page.evaluate(() => workspace.range()), {
      start: 0.2,
      end: 1.5,
    });
    await page.locator("#range-reset").click();
    assert.equal(await page.evaluate(() => workspace.range()), null);
    assert.equal(
      await page
        .locator("#range-end")
        .evaluate((input) => input.checkValidity()),
      true,
    );
    await page.evaluate(() => workspace.setRange({ start: 0.5, end: null }));
    assert.equal(await page.locator("#range-start").inputValue(), "0.5");
    assert.equal(await page.locator("#range-end").inputValue(), "");
    await page.evaluate(() => workspace.setRange(null));
    const box = await page.locator("#waveform").boundingBox();
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, {
      steps: 3,
    });
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => workspace.range()), {
      start: 0.5,
      end: 1.5,
    });
    await page.locator("#playback-speed").selectOption("1.5");
    assert.equal(await page.evaluate(() => workspace.audio.playbackRate), 1.5);
    await page.evaluate(() => workspace.setBusy(true));
    assert(await page.locator("#record-start").isDisabled());
    assert(await page.locator("#range-start").isDisabled());
    assert(await page.locator("#playback-speed").isEnabled());
    await page.evaluate(() => workspace.setBusy(false));
    await page.locator("#record-start").click();
    await page.waitForFunction(() => workspace.recorder?.state === "recording");
    await page.locator("#record-pause").click();
    assert.equal(await page.evaluate(() => workspace.recorder.state), "paused");
    assert.equal(
      await page.locator("#record-pause [data-label]").textContent(),
      "Resume",
    );
    assert.equal(await page.locator("#record-pause svg").count(), 1);
    await page.locator("#record-pause").click();
    assert.equal(
      await page.evaluate(() => workspace.recorder.state),
      "recording",
    );
    await page.waitForFunction(() => workspace.chunks.length > 0);
    await page.locator("#record-stop").click();
    await page.waitForFunction(
      () => recorded.length === 1 && !workspace.isRecording(),
    );
    const recording = await page.evaluate(() => ({
      size: recorded[0].size,
      name: recorded[0].name,
      type: recorded[0].type,
      released: !workspace.stream,
    }));
    assert(recording.size > 0);
    assert.match(recording.name, /^recording-.*\.(webm|ogg|m4a)$/);
    assert.match(recording.type, /^audio\//);
    assert(recording.released);
    await page.locator("#record-start").click();
    await page.waitForFunction(() => workspace.recorder?.state === "recording");
    await page.locator("#record-discard").click();
    await page.waitForFunction(() => !workspace.isRecording());
    assert.equal(await page.evaluate(() => recorded.length), 1);
    assert.deepEqual(await page.evaluate(() => recordingStates), [
      true,
      false,
      true,
      false,
    ]);
    assert.deepEqual(await page.evaluate(() => recordingStreams), [
      { stream: true, paused: false },
      { stream: true, paused: true },
      { stream: true, paused: false },
      { stream: false, paused: false },
      { stream: true, paused: false },
      { stream: false, paused: false },
    ]);
    // Cancel during a pending permission prompt: late-granted streams must close.
    const pendingCancelled = await page.evaluate(async () => {
      let grant;
      let stopped = false;
      const original = navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia = () =>
        new Promise((resolve) => {
          grant = resolve;
        });
      const pending = workspace.startRecording();
      workspace.stopRecording(true);
      grant({
        getTracks: () => [
          {
            stop: () => {
              stopped = true;
            },
          },
        ],
      });
      await pending;
      navigator.mediaDevices.getUserMedia = original;
      return stopped && !workspace.isRecording();
    });
    assert(pendingCancelled);
    await page.evaluate(async () => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException("Denied", "NotAllowedError"));
      await workspace.startRecording();
    });
    assert.match(
      await page.evaluate(() => statusMessages.at(-1)),
      /access was denied/,
    );
    assert(await page.locator("#record-start").isEnabled());
    await page.evaluate(async () => {
      await workspace.load({
        size: 65 * 1024 * 1024,
        arrayBuffer: () => {
          throw new Error("Large files must not decode");
        },
      });
    });
    assert.match(
      await page.locator("#waveform-status").textContent(),
      /skipped for this large recording/,
    );
    await page.evaluate(async () => {
      await workspace.load(
        new File(["invalid"], "bad.wav", { type: "audio/wav" }),
      );
    });
    assert.match(
      await page.locator("#waveform-status").textContent(),
      /no browser waveform/,
    );
    await page.evaluate(() => {
      workspace.clear();
      workspace.dispose();
    });
    assert(await page.locator("#waveform-panel").isHidden());
    assert.deepEqual(errors, []);
    console.log(
      "Media browser checks passed: waveform, selection, validation, playback, recording, pause/resume, stop/discard, late permissions, and format/size fallbacks.",
    );
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
