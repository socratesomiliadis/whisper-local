const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = { window: {}, document: { getElementById: () => null } };
vm.runInNewContext(
  fs.readFileSync(
    path.resolve(__dirname, "../../src/whisper_local/static/editor.js"),
    "utf8",
  ),
  sandbox,
);
const Editor = sandbox.window.TranscriptEditor;
const fixture = {
  language: "en",
  name: "meeting",
  range_start: 17,
  text: "Stale original text",
  speakers: { A: "Alex", B: "Sam" },
  segments: [
    { start: 0, end: 1.1, text: "Corrected hello.", speaker: "A" },
    { start: 1.1, end: 3, text: "Thank you.", speaker: "B" },
  ],
};
const original = JSON.stringify(fixture);
assert.equal(Editor.text(fixture), "Alex: Corrected hello.\n\nSam: Thank you.");
assert.equal(Editor.export(fixture, "txt"), Editor.text(fixture) + "\n");
assert.match(
  Editor.export(fixture, "srt"),
  /00:00:00,000 --> 00:00:01,100\nAlex: Corrected hello\./,
);
assert.match(
  Editor.export(fixture, "vtt"),
  /^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:01\.100/,
);
assert(
  !Editor.export(fixture, "srt", { includeSpeakers: false }).includes("Alex:"),
);
const json = JSON.parse(Editor.export(fixture, "json"));
assert.equal(json.text, Editor.text(fixture));
assert.equal(json.range_start, 17);
assert.equal(json.name, "meeting");
assert.match(json.srt, /Corrected hello/);
assert.equal(
  JSON.stringify(fixture),
  original,
  "Export must not mutate saved results",
);

const long = {
  speakers: {},
  segments: [
    {
      start: 3600,
      end: 3620,
      text: "These longer sentences contain enough individual words for subtitle splitting and readable line wrapping with sensible timing throughout the entire passage.",
    },
  ],
};
const srt = Editor.export(long, "srt", { lineLength: 20, maxDuration: 3 });
const time = (stamp) => {
  const [hours, minutes, seconds, ms] = stamp.split(/[:,]/).map(Number);
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
};
let lastEnd = 3600;
const cues = srt.trim().split("\n\n");
assert(cues.length > 1);
for (const cue of cues) {
  const [, timing, ...lines] = cue.split("\n");
  const [start, end] = timing.split(" --> ").map(time);
  assert(start >= lastEnd - 0.001);
  assert(end > start && end - start <= 3.001);
  assert(lines.length <= 2);
  assert(lines.every((line) => Array.from(line).length <= 20));
  lastEnd = end;
}
assert.equal(lastEnd, 3620);
assert.equal(
  cues.map((cue) => cue.split("\n").slice(2).join(" ")).join(" "),
  long.segments[0].text,
);
const unicode = Editor.export(
  {
    speakers: {},
    segments: [{ start: 0, end: 2, text: "Αυτήείναιμιαπολύμεγάληλέξη" }],
  },
  "vtt",
  { lineLength: 10 },
);
assert(!unicode.includes("\ufffd"));
assert.throws(() => Editor.export(fixture, "pdf"), /Unsupported export/);
console.log(
  "Editor exports: text, JSON metadata, SRT/VTT timing, wrapping, duration and Unicode passed.",
);
