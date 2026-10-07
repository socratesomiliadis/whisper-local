"use strict";
const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="app-token"]').content;
const headers = { "X-App-Token": token };
const extensions = new Set([
  "mp3",
  "wav",
  "m4a",
  "flac",
  "ogg",
  "opus",
  "webm",
  "aac",
  "mp4",
  "wma",
  "aiff",
  "aif",
]);
let file = null,
  audioURL = null,
  busy = false,
  result = null,
  outputName = "transcript",
  dependenciesReady = false;
let speakerState = { ready: false, installed: false, state: "idle" },
  setupBusy = false,
  speakerNames = {};

function status(message, type = "") {
  $("status").textContent = message;
  $("status").className = `status ${type}`;
}

function setBusy(value) {
  busy = value;
  $("transcribe").disabled =
    value ||
    setupBusy ||
    !file ||
    !dependenciesReady ||
    ($("detect-speakers").checked && !speakerState.ready);
  $("transcribe").textContent = value ? "Transcribing…" : "Transcribe audio";
  [
    "file",
    "model",
    "language",
    "processing",
    "fast-mode",
    "detect-speakers",
  ].forEach((id) => {
    $(id).disabled = value;
  });
  $("speaker-count").disabled = value || !$("detect-speakers").checked;
  $("setup-speakers").disabled = value || setupBusy || !speakerState.installed;
  $("hf-token").disabled = value || setupBusy;
  $("dropzone").classList.toggle("busy", value);
  $("dropzone").setAttribute("aria-disabled", String(value));
  $("dropzone").tabIndex = value ? -1 : 0;
}

function updateSpeakerState(data) {
  speakerState = data;
  setupBusy = data.state === "downloading";
  $("speaker-options").hidden = !$("detect-speakers").checked;
  $("speaker-setup").hidden = data.ready;
  $("speaker-status").textContent = !data.installed
    ? "Run Setup.ps1 and restart the app to install speaker detection."
    : data.ready
      ? "Speaker model ready · Works offline"
      : data.message;
  $("setup-speakers").textContent = setupBusy
    ? "Downloading…"
    : "Download speaker model";
  setBusy(busy);
}
$("detect-speakers").addEventListener("change", () =>
  updateSpeakerState(speakerState),
);
$("fast-mode").addEventListener("click", () => {
  $("model").value = "tiny";
  $("processing").value = "auto";
  $("detect-speakers").checked = false;
  updateSpeakerState(speakerState);
  status(
    "Fast mode: Tiny model, automatic acceleration, and speaker detection off. Accuracy may be lower.",
  );
});

async function pollSpeakerSetup() {
  let failures = 0;
  for (;;) {
    let data;
    try {
      data = await api("/api/speakers/status");
      failures = 0;
    } catch (error) {
      if (++failures >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    updateSpeakerState(data);
    if (data.state !== "downloading") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

$("setup-speakers").addEventListener("click", async () => {
  const downloadToken = $("hf-token").value.trim();
  if (!downloadToken.startsWith("hf_")) {
    $("speaker-status").textContent =
      "Enter a Hugging Face read token starting with hf_.";
    $("hf-token").focus();
    return;
  }
  setupBusy = true;
  setBusy(busy);
  try {
    await api("/api/speakers/setup", {
      method: "POST",
      body: JSON.stringify({ token: downloadToken }),
      headers: { ...headers, "Content-Type": "application/json" },
    });
    $("hf-token").value = "";
    await pollSpeakerSetup();
  } catch (error) {
    $("speaker-status").textContent = error.message;
  } finally {
    $("hf-token").value = "";
    setupBusy = false;
    setBusy(busy);
  }
});

function chooseFile(next) {
  if (busy || !next) return;
  if (!extensions.has(next.name.split(".").pop().toLowerCase())) {
    status("Choose an audio file such as MP3, WAV, M4A, or FLAC.", "error");
    return;
  }
  if (!next.size || next.size > 500 * 1024 * 1024) {
    status("Choose a nonempty audio file smaller than 500 MB.", "error");
    return;
  }
  file = next;
  outputName = next.name.replace(/\.[^.]+$/, "") || "transcript";
  $("file-title").textContent = next.name;
  $("file-detail").textContent =
    `${(next.size / 1024 / 1024).toFixed(1)} MB · Click to change`;
  if (audioURL) URL.revokeObjectURL(audioURL);
  audioURL = URL.createObjectURL(next);
  $("audio-player").src = audioURL;
  $("audio-player").hidden = false;
  $("results").hidden = true;
  $("empty").hidden = false;
  result = null;
  setBusy(false);
  if (dependenciesReady) status("Ready when you are.");
}

$("file").addEventListener("change", (event) =>
  chooseFile(event.target.files[0]),
);
$("dropzone").addEventListener("click", (event) => {
  if (busy) event.preventDefault();
});
$("dropzone").addEventListener("keydown", (event) => {
  if (!busy && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    $("file").click();
  }
});
["dragenter", "dragover"].forEach((name) =>
  $("dropzone").addEventListener(name, (event) => {
    event.preventDefault();
    if (!busy) $("dropzone").classList.add("dragging");
  }),
);
["dragleave", "drop"].forEach((name) =>
  $("dropzone").addEventListener(name, (event) => {
    event.preventDefault();
    $("dropzone").classList.remove("dragging");
  }),
);
$("dropzone").addEventListener("drop", (event) =>
  chooseFile(event.dataTransfer.files[0]),
);
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error || "Something went wrong. Try again.");
  return body;
}

function shortTime(seconds) {
  const value = Math.floor(seconds);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function showResult(data) {
  result = data;
  speakerNames = { ...(data.speakers || {}) };
  $("empty").hidden = true;
  $("results").hidden = false;
  const words = data.text.trim() ? data.text.trim().split(/\s+/u).length : 0;
  const count = Object.keys(speakerNames).filter(
    (id) => id !== "unknown",
  ).length;
  $("result-meta").textContent =
    `${data.language.toUpperCase()} · ${words.toLocaleString()} words${count ? ` · ${count} speaker${count === 1 ? "" : "s"}` : ""}${data.device ? ` · ${data.device === "cuda" ? "GPU" : "CPU"}` : ""}${typeof data.elapsed === "number" ? ` · ${data.elapsed}s` : ""}`;
  $("speaker-names").hidden = !Object.keys(speakerNames).length;
  $("speaker-name-fields").replaceChildren();
  for (const [id, name] of Object.entries(speakerNames)) {
    const label = document.createElement("label");
    label.className = "speaker-name";
    const caption = document.createElement("span");
    caption.textContent = name;
    const input = document.createElement("input");
    input.value = name;
    input.maxLength = 60;
    input.setAttribute("aria-label", `Rename ${name}`);
    input.addEventListener("input", () => {
      speakerNames[id] = input.value.trim() || name;
      refreshTranscript();
    });
    label.append(caption, input);
    $("speaker-name-fields").append(label);
  }
  refreshTranscript();
  view(false);
  status(
    data.warning ||
      (words
        ? "Done. Your transcript is ready to copy or save."
        : "Finished. No speech was detected in this recording."),
    data.warning ? "error" : "success",
  );
}

function transcriptText() {
  if (!result) return "";
  if (!Object.keys(speakerNames).length) return result.text;
  return result.segments
    .map((s) => `${speakerNames[s.speaker] || "Unassigned"}: ${s.text}`)
    .join("\n\n");
}

function refreshTranscript() {
  $("transcript").value = transcriptText();
  $("segments").replaceChildren();
  for (const segment of result.segments) {
    const row = document.createElement("div");
    row.className = "segment";
    const time = document.createElement("button");
    time.textContent = shortTime(segment.start);
    time.setAttribute(
      "aria-label",
      `Play audio at ${shortTime(segment.start)}`,
    );
    time.disabled = !audioURL;
    time.addEventListener("click", () => {
      $("audio-player").currentTime = segment.start;
      $("audio-player")
        .play()
        .catch(() =>
          status(
            "This audio format cannot be previewed in your browser. Your transcript is ready.",
            "success",
          ),
        );
    });
    const text = document.createElement("p");
    if (segment.speaker) {
      const label = document.createElement("strong");
      label.className = "speaker-label";
      label.textContent = speakerNames[segment.speaker] || "Unassigned";
      text.append(label, document.createElement("br"));
    }
    text.append(document.createTextNode(segment.text));
    row.append(time, text);
    $("segments").append(row);
  }
}

function view(timed) {
  $("transcript").hidden = timed;
  $("segments").hidden = !timed;
  $("plain-view").classList.toggle("selected", !timed);
  $("timed-view").classList.toggle("selected", timed);
  $("plain-view").setAttribute("aria-pressed", String(!timed));
  $("timed-view").setAttribute("aria-pressed", String(timed));
}
$("plain-view").addEventListener("click", () => view(false));
$("timed-view").addEventListener("click", () => view(true));

async function poll(jobId) {
  let failures = 0;
  for (;;) {
    let data;
    try {
      data = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      failures = 0;
    } catch (error) {
      if (++failures >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    if (data.state === "complete") {
      showResult(data);
      sessionStorage.removeItem("whisper-job");
      return;
    }
    if (data.state === "error") {
      sessionStorage.removeItem("whisper-job");
      throw new Error(data.message);
    }
    status(data.message, "working");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

$("transcribe").addEventListener("click", async () => {
  if (busy || !file) return;
  if ($("detect-speakers").checked && !$("speaker-count").checkValidity()) {
    $("speaker-count").reportValidity();
    return;
  }
  setBusy(true);
  $("results").hidden = true;
  $("empty").hidden = false;
  status("Reading your audio…", "working");
  try {
    const form = new FormData();
    form.append("audio", file);
    form.append("model", $("model").value);
    form.append("language", $("language").value);
    form.append("processing", $("processing").value);
    form.append("detect_speakers", String($("detect-speakers").checked));
    if ($("detect-speakers").checked)
      form.append("num_speakers", $("speaker-count").value);
    const data = await api("/api/transcribe", { method: "POST", body: form });
    sessionStorage.setItem(
      "whisper-job",
      JSON.stringify({ id: data.job_id, name: outputName }),
    );
    await poll(data.job_id);
  } catch (error) {
    status(error.message, "error");
  } finally {
    setBusy(false);
  }
});

$("copy").addEventListener("click", async () => {
  if (!result) return;
  try {
    await navigator.clipboard.writeText(transcriptText());
    $("copy").textContent = "Copied";
    setTimeout(() => {
      $("copy").textContent = "Copy text";
    }, 1600);
  } catch {
    view(false);
    $("transcript").select();
    status("Press Ctrl+C (or Command+C) to copy the selected transcript.");
  }
});

function save(extension, text) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${outputName}.${extension}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function srtTime(seconds) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const pad = (n, size = 2) => String(n).padStart(size, "0");
  return `${pad(Math.floor(total / 3600000))}:${pad(Math.floor(total / 60000) % 60)}:${pad(Math.floor(total / 1000) % 60)},${pad(total % 1000, 3)}`;
}
function subtitleText() {
  if (!Object.keys(speakerNames).length) return result.srt;
  return (
    result.segments
      .map(
        (s, i) =>
          `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${speakerNames[s.speaker] || "Unassigned"}: ${s.text}`,
      )
      .join("\n\n") + "\n"
  );
}
$("save-txt").addEventListener("click", () => {
  if (result) save("txt", transcriptText() + "\n");
});
$("save-srt").addEventListener("click", () => {
  if (result) save("srt", subtitleText());
});

async function init() {
  try {
    const data = await api("/api/status");
    dependenciesReady = data.whisper;
    $("acceleration").textContent = data.acceleration?.gpu_available
      ? `${data.acceleration.gpu_name || "NVIDIA GPU"} available`
      : "CPU acceleration · GPU unavailable";
    updateSpeakerState(data.speakers || speakerState);
    if (speakerState.state === "downloading") {
      $("detect-speakers").checked = true;
      pollSpeakerSetup().catch((error) => {
        $("speaker-status").textContent = error.message;
        setupBusy = false;
        setBusy(busy);
      });
    }
    if (!dependenciesReady)
      status(
        "Setup is incomplete. Run Setup.ps1, then restart the app.",
        "error",
      );
    const saved = sessionStorage.getItem("whisper-job");
    if (saved) {
      const job = JSON.parse(saved);
      outputName = job.name;
      setBusy(true);
      await poll(job.id);
    }
  } catch (error) {
    status(
      error.message ||
        "Could not connect. Keep the app’s launch window open and refresh.",
      "error",
    );
  } finally {
    setBusy(false);
  }
}
init();
