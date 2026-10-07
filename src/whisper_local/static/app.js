"use strict";
const $ = (id) => document.getElementById(id);
const headers = {
  "X-App-Token": document.querySelector('meta[name="app-token"]').content,
};
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
const library = new LocalLibrary();
let file = null,
  audioURL = null,
  busy = false,
  setupBusy = false,
  dependenciesReady = false,
  activeJob = null,
  stopQueue = false,
  selectedEntry = null,
  currentRecord = null,
  saveTimer = null,
  speakerState = { ready: false, installed: false, state: "idle" };
let queue = [];
function status(message, type = "") {
  $("status").textContent = message;
  $("status").className = `status ${type}`;
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      "Could not reach the app. Keep its launch window open, then refresh.",
    );
  }
  if (!response.ok) {
    const error = new Error(body.error || "Something went wrong. Try again.");
    error.status = response.status;
    throw error;
  }
  return body;
}
const editor = new TranscriptEditor({
  onChange(data) {
    if (selectedEntry?.result) selectedEntry.result = data;
    if (currentRecord) {
      currentRecord.result = data;
      currentRecord.updated = Date.now();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveCurrent(), 350);
    }
  },
  onSeek(seconds) {
    if (!audioURL) return;
    $("audio-player").currentTime = seconds;
    $("audio-player")
      .play()
      .catch(() =>
        status(
          "This audio format cannot be previewed in your browser. You can still edit and export the transcript.",
        ),
      );
  },
  onStatus: status,
});
const media = new AudioWorkspace({
  onRecorded: (recording) => chooseFiles([recording]),
  onRangeChange(range) {
    if (selectedEntry) selectedEntry.range = range;
  },
  onRecordingChange() {
    setBusy(busy);
  },
  onStatus: status,
});
$("audio-player").addEventListener("timeupdate", () =>
  editor.setPlaybackTime($("audio-player").currentTime),
);
const preferenceIds = [
  "quality",
  "model",
  "language",
  "processing",
  "detect-speakers",
  "speaker-count",
  "save-history",
  "retain-audio",
  "playback-speed",
  "follow-playback",
  "subtitle-line-length",
  "subtitle-duration",
  "subtitle-speakers",
];
function savePreferences() {
  const values = Object.fromEntries(
    preferenceIds.map((id) => [
      id,
      $(id).type === "checkbox" ? $(id).checked : $(id).value,
    ]),
  );
  try {
    localStorage.setItem("whisper-preferences", JSON.stringify(values));
  } catch {
    /* Storage is optional. */
  }
}
function restorePreferences() {
  try {
    const values = JSON.parse(
      localStorage.getItem("whisper-preferences") || "{}",
    );
    for (const id of preferenceIds) {
      if (values[id] === undefined) continue;
      if ($(id).type === "checkbox") $(id).checked = values[id] === true;
      else {
        const before = $(id).value;
        $(id).value = String(values[id]);
        if (!$(id).value || !$(id).checkValidity()) $(id).value = before;
      }
    }
  } catch {
    /* Ignore invalid preference records. */
  }
  $("playback-speed").dispatchEvent(new Event("change"));
}
function qualityNote() {
  $("quality-note").textContent =
    `${$("model").selectedOptions[0].textContent.split(" · ")[0]} model · ${$("quality").value} decoding${$("detect-speakers").checked ? " · speaker detection" : ""}.`;
}
function preset(quality) {
  $("quality").value = quality;
  $("model").value = { fast: "tiny", balanced: "base", accurate: "small" }[
    quality
  ];
  if (quality === "fast") {
    $("processing").value = "auto";
    $("detect-speakers").checked = false;
  }
  qualityNote();
  updateSpeakerState(speakerState);
  savePreferences();
}
preferenceIds.forEach((id) =>
  $(id).addEventListener("change", () => {
    savePreferences();
    qualityNote();
  }),
);
$("quality").addEventListener("change", () => preset($("quality").value));
$("fast-mode").addEventListener("click", () => {
  preset("fast");
  status(
    "Fast mode uses Tiny with quick decoding and speaker detection off. Review the draft for accuracy.",
  );
});
function setBusy(value) {
  busy = value;
  const recording = media.isRecording();
  const pending = queue.filter((entry) => entry.state === "queued").length;
  $("transcribe").disabled =
    value ||
    recording ||
    setupBusy ||
    (!file && !pending) ||
    !dependenciesReady ||
    !!activeJob ||
    ($("detect-speakers").checked && !speakerState.ready);
  $("transcribe").textContent = value
    ? "Transcribing…"
    : pending > 1
      ? "Transcribe queue"
      : "Transcribe audio";
  [
    "file",
    "model",
    "quality",
    "language",
    "processing",
    "fast-mode",
    "detect-speakers",
  ].forEach((id) => {
    $(id).disabled = value || recording;
  });
  $("speaker-count").disabled = value || !$("detect-speakers").checked;
  $("setup-speakers").disabled = value || setupBusy || !speakerState.installed;
  $("hf-token").disabled = value || setupBusy;
  $("dropzone").classList.toggle("busy", value || recording);
  $("dropzone").setAttribute("aria-disabled", String(value || recording));
  $("dropzone").tabIndex = value || recording ? -1 : 0;
  $("stop-queue").hidden = !value || !pending;
  $("clear-history").disabled = value;
  media.setBusy(value);
  renderQueue();
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
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
async function pollSpeakerSetup() {
  let failures = 0;
  for (;;) {
    let data;
    try {
      data = await api("/api/speakers/status");
      failures = 0;
    } catch (error) {
      if (++failures >= 3) throw error;
      await delay(1500);
      continue;
    }
    updateSpeakerState(data);
    if (data.state !== "downloading") return;
    await delay(1000);
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
      headers: { "Content-Type": "application/json" },
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
function baseName(name) {
  return name.replace(/\.[^.]+$/, "") || "transcript";
}
function chooseFiles(files) {
  if (busy || media.isRecording()) return;
  const accepted = [],
    rejected = [];
  for (const next of files) {
    if (
      !extensions.has(next.name.split(".").pop().toLowerCase()) ||
      !next.size ||
      next.size > 500 * 1024 * 1024
    ) {
      rejected.push(next.name);
      continue;
    }
    const entry = {
      id: crypto.randomUUID(),
      file: next,
      name: baseName(next.name),
      state: "queued",
      range: null,
      result: null,
    };
    queue.push(entry);
    accepted.push(entry);
  }
  if (accepted.length) {
    selectEntry(accepted[0]);
    status(
      `${accepted.length > 1 ? `${accepted.length} recordings queued.` : "Ready when you are."}${rejected.length ? ` Skipped ${rejected.length} unsupported, empty, or oversized files.` : ""}`,
    );
  } else if (rejected.length)
    status(
      "Choose a nonempty audio file such as MP3, WAV, or M4A, smaller than 500 MB.",
      "error",
    );
  setBusy(false);
}
async function preview(next, range = null) {
  file = next;
  if (audioURL) URL.revokeObjectURL(audioURL);
  audioURL = next ? URL.createObjectURL(next) : null;
  editor.setAudioAvailable(!!audioURL);
  if (next) {
    $("audio-player").src = audioURL;
    $("audio-player").hidden = false;
    $("file-title").textContent = next.name;
    $("file-detail").textContent =
      `${(next.size / 1024 / 1024).toFixed(1)} MB · Add more files`;
    const loading = media.load(next);
    media.setRange(range);
    await loading;
  } else {
    $("audio-player").pause();
    $("audio-player").removeAttribute("src");
    $("audio-player").load();
    $("audio-player").hidden = true;
    media.clear();
    $("file-title").textContent = "Drop your recordings here";
    $("file-detail").textContent = "or click to choose files";
  }
  document.body.classList.toggle("has-file", !!next || !!currentRecord);
  $("attach-audio-label").hidden = !!audioURL || $("results").hidden;
}
async function selectEntry(entry) {
  if (media.isRecording()) return;
  clearTimeout(saveTimer);
  await saveCurrent();
  selectedEntry = entry;
  currentRecord = null;
  const range = entry.range;
  if (entry.result) showResult(entry.result, entry);
  else {
    $("results").hidden = true;
    $("empty").hidden = false;
  }
  preview(entry.file, range).catch((error) => status(error.message, "error"));
  setBusy(busy);
}
function renderQueue() {
  $("queue-panel").hidden = !queue.length;
  $("queue-list").replaceChildren();
  for (const entry of queue) {
    const item = document.createElement("li");
    item.className = `library-item ${entry === selectedEntry ? "selected" : ""}`;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "item-open";
    open.textContent = entry.file?.name || entry.name;
    open.disabled = busy || media.isRecording();
    open.addEventListener("click", () => selectEntry(entry));
    const state = document.createElement("span");
    state.className = `item-state ${entry.state}`;
    state.textContent = entry.state;
    if (entry.error) state.title = entry.error;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quiet";
    remove.textContent = "Remove";
    remove.disabled = busy || media.isRecording();
    remove.setAttribute("aria-label", `Remove ${entry.name} from queue`);
    remove.addEventListener("click", async () => {
      queue = queue.filter((value) => value !== entry);
      if (selectedEntry === entry) {
        await saveCurrent();
        selectedEntry = null;
      }
      setBusy(busy);
    });
    item.append(open, state, remove);
    $("queue-list").append(item);
  }
  $("download-batch").disabled = !queue.some((entry) => entry.result);
}
$("file").addEventListener("change", (event) => {
  chooseFiles(event.target.files);
  event.target.value = "";
});
$("dropzone").addEventListener("click", (event) => {
  if (busy || media.isRecording()) event.preventDefault();
});
$("dropzone").addEventListener("keydown", (event) => {
  if (!busy && !media.isRecording() && ["Enter", " "].includes(event.key)) {
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
  chooseFiles(event.dataTransfer.files),
);
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());
$("clear-queue").addEventListener("click", () => {
  queue = queue.filter((entry) => ["queued", "running"].includes(entry.state));
  renderQueue();
});
$("stop-queue").addEventListener("click", () => {
  stopQueue = true;
  $("stop-queue").disabled = true;
  status(
    "The current recording will finish. Remaining files will stay queued.",
    "working",
  );
});
function showResult(data, entry = null, record = null) {
  selectedEntry = entry;
  currentRecord = record || {
    id: entry?.id || crypto.randomUUID(),
    name: entry?.name || "transcript",
    created: Date.now(),
    updated: Date.now(),
    result: data,
    audio: null,
  };
  editor.load(data);
  editor.setAudioAvailable(!!audioURL);
  currentRecord.result = editor.snapshot();
  if (entry) entry.result = currentRecord.result;
  $("empty").hidden = true;
  $("results").hidden = false;
  document.body.classList.add("has-file");
  $("attach-audio-label").hidden = !!audioURL;
  status(
    data.warning ||
      (data.text?.trim()
        ? "Done. Review, edit, or export your transcript."
        : "Finished. No speech was detected."),
    data.warning ? "error" : "success",
  );
}
function progress(data) {
  $("job-progress").hidden = false;
  $("cancel-job").disabled = !activeJob;
  const labels = {
    uploading: "Reading file",
    decoding: "Decoding audio",
    downloading: "Downloading model",
    loading: "Loading model",
    transcribing: "Transcribing",
    diarizing: "Detecting speakers",
    cancelling: "Cancelling",
  };
  $("progress-stage").textContent =
    labels[data.stage || data.state] || "Processing";
  if (typeof data.progress === "number" && Number.isFinite(data.progress)) {
    $("progress-bar").value = data.progress;
    $("progress-percent").textContent = `${Math.round(data.progress * 100)}%`;
  } else {
    $("progress-bar").removeAttribute("value");
    $("progress-percent").textContent = "";
  }
  if (!stopQueue)
    status(data.message || "Processing your recording…", "working");
}
async function poll(jobId) {
  let failures = 0;
  for (;;) {
    let data;
    try {
      data = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      failures = 0;
    } catch (error) {
      if (error.status === 404 || ++failures >= 3) throw error;
      await delay(1500);
      continue;
    }
    if (["complete", "error", "cancelled"].includes(data.state)) {
      sessionStorage.removeItem("whisper-job");
      activeJob = null;
      $("job-progress").hidden = true;
      return data;
    }
    progress(data);
    await delay(700);
  }
}
$("cancel-job").addEventListener("click", async () => {
  if (!activeJob) return;
  stopQueue = true;
  $("cancel-job").disabled = true;
  try {
    await api(`/api/jobs/${encodeURIComponent(activeJob)}/cancel`, {
      method: "POST",
    });
    status(
      "Cancellation requested. Waiting for processing to stop…",
      "working",
    );
  } catch (error) {
    status(error.message, "error");
  } finally {
    $("cancel-job").disabled = false;
  }
});
$("transcribe").addEventListener("click", async () => {
  if (busy || activeJob || media.isRecording() || !dependenciesReady) return;
  for (const id of [
    "range-start",
    "range-end",
    ...($("detect-speakers").checked ? ["speaker-count"] : []),
  ]) {
    if (!$(id).checkValidity()) {
      $(id).reportValidity();
      return;
    }
  }
  if ($("detect-speakers").checked && !speakerState.ready) {
    $("advanced-settings").open = true;
    status("Complete speaker setup first.", "error");
    return;
  }
  if (!queue.some((entry) => entry.state === "queued")) {
    if (!file) return;
    queue.push({
      id: crypto.randomUUID(),
      file,
      name: baseName(file.name),
      state: "queued",
      range: media.range(),
      result: null,
    });
  }
  setBusy(true);
  $("results").hidden = true;
  $("empty").hidden = false;
  clearTimeout(saveTimer);
  await saveCurrent();
  const settings = {
    model: $("model").value,
    quality: $("quality").value,
    language: $("language").value,
    processing: $("processing").value,
    detect_speakers: String($("detect-speakers").checked),
    num_speakers: $("detect-speakers").checked ? $("speaker-count").value : "",
  };
  stopQueue = false;
  $("stop-queue").disabled = false;
  setBusy(true);
  try {
    for (const entry of queue.filter((item) => item.state === "queued")) {
      if (stopQueue) break;
      await selectEntry(entry);
      entry.state = "running";
      renderQueue();
      progress({ state: "uploading", message: `Reading ${entry.file.name}…` });
      try {
        const form = new FormData();
        form.append("audio", entry.file);
        for (const [key, value] of Object.entries(settings))
          form.append(key, value);
        if (entry.range) {
          form.append("start_time", String(entry.range.start));
          if (entry.range.end !== null && entry.range.end !== undefined)
            form.append("end_time", String(entry.range.end));
        }
        const data = await api("/api/transcribe", {
          method: "POST",
          body: form,
        });
        activeJob = data.job_id;
        $("cancel-job").disabled = false;
        sessionStorage.setItem(
          "whisper-job",
          JSON.stringify({
            id: data.job_id,
            name: entry.name,
            recordId: entry.id,
          }),
        );
        const completed = await poll(data.job_id);
        entry.state = completed.state;
        if (completed.state === "complete") {
          showResult(completed, entry);
          await saveCurrent();
        } else if (completed.state === "cancelled") {
          status("Cancelled. Remaining files are still queued.");
          stopQueue = true;
        } else {
          entry.error = completed.message;
          status(`${entry.file.name}: ${completed.message}`, "error");
        }
      } catch (error) {
        entry.state = "error";
        entry.error = error.message;
        stopQueue = true;
        if (activeJob && error.status !== 404)
          status(
            `${error.message} Refresh to reconnect to the current job.`,
            "error",
          );
        else {
          activeJob = null;
          sessionStorage.removeItem("whisper-job");
          $("job-progress").hidden = true;
          status(error.message, "error");
        }
      }
      renderQueue();
    }
  } finally {
    setBusy(false);
    await renderHistory();
  }
});
async function saveCurrent() {
  editor.flushEdit();
  clearTimeout(saveTimer);
  if (!currentRecord || !$("save-history").checked) return;
  const record = {
    ...currentRecord,
    result: structuredClone(currentRecord.result),
    updated: Date.now(),
    audio: $("retain-audio").checked ? file || currentRecord.audio : null,
  };
  try {
    await library.put(record);
    $("history-status").textContent = "Saved locally";
  } catch {
    if (record.audio) {
      try {
        await library.put({ ...record, audio: null });
        $("history-status").textContent =
          "Transcript saved. Audio could not be retained; browser storage may be full.";
      } catch {
        $("history-status").textContent =
          "Local saving unavailable. Export your transcript to keep it.";
      }
    } else
      $("history-status").textContent =
        "Local saving unavailable. Export your transcript to keep it.";
  }
  await renderHistory();
}
async function renderHistory() {
  let records;
  try {
    records = await library.list();
  } catch {
    $("history-status").textContent =
      "Browser storage is unavailable. Export transcripts to keep them.";
    return;
  }
  $("history-list").replaceChildren();
  $("history-empty").hidden = records.length > 0;
  for (const record of records) {
    const item = document.createElement("li");
    item.className = "library-item";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "item-open";
    const name = document.createElement("strong");
    name.textContent = record.name;
    const detail = document.createElement("small");
    detail.textContent = `${new Date(record.updated).toLocaleString()} · ${record.result.language?.toUpperCase() || ""} · ${record.audio ? "Audio retained" : "Transcript only"}`;
    open.append(name, detail);
    open.disabled = busy || media.isRecording();
    open.addEventListener("click", async () => {
      if (busy || media.isRecording()) return;
      await saveCurrent();
      const saved = await library.get(record.id);
      if (!saved) return;
      selectedEntry = null;
      currentRecord = saved;
      await preview(saved.audio || null);
      showResult(saved.result, null, saved);
      status(
        saved.audio
          ? "Saved transcript opened with audio."
          : "Saved transcript opened. Use Attach audio to restore playback.",
      );
      setBusy(false);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quiet";
    remove.textContent = "Delete";
    remove.disabled = busy;
    remove.setAttribute("aria-label", `Delete saved transcript ${record.name}`);
    remove.addEventListener("click", async () => {
      clearTimeout(saveTimer);
      if (currentRecord?.id === record.id) currentRecord = null;
      try {
        await library.delete(record.id);
        await renderHistory();
        $("history-status").textContent = "Deleted from local library";
      } catch {
        $("history-status").textContent = "Could not delete this transcript.";
      }
    });
    item.append(open, remove);
    $("history-list").append(item);
  }
}
$("clear-history").addEventListener("click", async () => {
  clearTimeout(saveTimer);
  currentRecord = null;
  try {
    await library.clear();
    await renderHistory();
    $("history-status").textContent = "Local library cleared";
  } catch {
    $("history-status").textContent = "Could not clear local library.";
  }
});
$("save-history").addEventListener("change", () => {
  if ($("save-history").checked) saveCurrent();
  else {
    clearTimeout(saveTimer);
    $("history-status").textContent =
      "Autosave off. Existing saved transcripts remain.";
  }
});
$("retain-audio").addEventListener("change", () => saveCurrent());
$("attach-audio").addEventListener("change", async (event) => {
  const audio = event.target.files[0];
  event.target.value = "";
  if (!audio || busy || media.isRecording() || $("results").hidden) return;
  if (
    !extensions.has(audio.name.split(".").pop().toLowerCase()) ||
    !audio.size ||
    audio.size > 500 * 1024 * 1024
  ) {
    status("Choose the original recording, smaller than 500 MB.", "error");
    return;
  }
  await preview(audio);
  await saveCurrent();
  status("Audio attached. Your transcript edits are ready for review.");
  setBusy(false);
});
$("attach-audio-label").addEventListener("keydown", (event) => {
  if (["Enter", " "].includes(event.key) && !busy && !media.isRecording()) {
    event.preventDefault();
    $("attach-audio").click();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveCurrent();
});
function download(name, content, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(
    content instanceof Blob ? content : new Blob([content], { type }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(editor.text());
    $("copy").textContent = "Copied";
    setTimeout(() => {
      $("copy").textContent = "Copy text";
    }, 1600);
  } catch {
    $("plain-view").click();
    $("transcript").select();
    status("Press Ctrl+C (or Command+C) to copy the selected transcript.");
  }
});
["txt", "srt", "vtt", "json"].forEach((format) =>
  $("save-" + format).addEventListener("click", () => {
    if ($("results").hidden) return;
    download(
      `${currentRecord?.name || selectedEntry?.name || baseName(file?.name || "transcript")}.${format}`,
      editor.export(format),
      format === "json"
        ? "application/json;charset=utf-8"
        : format === "vtt"
          ? "text/vtt;charset=utf-8"
          : undefined,
    );
  }),
);
$("download-batch").addEventListener("click", () => {
  const files = [],
    names = new Map();
  const options = {
    lineLength: Number($("subtitle-line-length").value) || 42,
    maxDuration: Number($("subtitle-duration").value) || 6,
    includeSpeakers: $("subtitle-speakers").checked,
  };
  let index = 0;
  for (const entry of queue.filter((item) => item.result)) {
    const clean =
      entry.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "_") ||
      "transcript";
    const count = (names.get(clean) || 0) + 1;
    names.set(clean, count);
    const name = `${String(++index).padStart(3, "0")}-${clean}${count > 1 ? `-${count}` : ""}`;
    for (const format of ["txt", "srt", "vtt", "json"])
      files.push({
        name: `${name}.${format}`,
        text: TranscriptEditor.export(entry.result, format, options),
      });
  }
  if (files.length) download("whisper-transcripts.zip", transcriptZip(files));
});
async function init() {
  restorePreferences();
  qualityNote();
  renderHistory();
  try {
    const data = await api("/api/status");
    dependenciesReady = data.whisper;
    $("acceleration").textContent = data.acceleration?.gpu_available
      ? `${data.acceleration.gpu_name || "NVIDIA GPU"} available`
      : "CPU acceleration · GPU unavailable";
    updateSpeakerState(data.speakers || speakerState);
    if (speakerState.state === "downloading") {
      $("detect-speakers").checked = true;
      $("advanced-settings").open = true;
      updateSpeakerState(speakerState);
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
      let job;
      try {
        job = JSON.parse(saved);
        if (typeof job.id !== "string") throw new Error();
      } catch {
        sessionStorage.removeItem("whisper-job");
        return;
      }
      activeJob = job.id;
      setBusy(true);
      const completed = await poll(job.id);
      if (completed.state === "complete") {
        showResult(completed, {
          id: job.recordId || crypto.randomUUID(),
          name: job.name || "transcript",
          result: completed,
        });
        selectedEntry = null;
        await saveCurrent();
      } else
        status(
          completed.message || "The job was cancelled.",
          completed.state === "error" ? "error" : "",
        );
    }
  } catch (error) {
    if (error.status === 404) {
      activeJob = null;
      sessionStorage.removeItem("whisper-job");
    }
    status(
      error.message ||
        "Could not connect. Keep the launch window open and refresh.",
      "error",
    );
  } finally {
    setBusy(false);
  }
}
init();
