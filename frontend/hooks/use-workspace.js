import { useEffect, useRef, useState } from "react";
import "../../src/whisper_local/static/editor.js";
import "../../src/whisper_local/static/media.js";
import "../../src/whisper_local/static/library.js";

const defaults = {
  quality: "balanced",
  model: "base",
  language: "",
  processing: "auto",
  "detect-speakers": false,
  "speaker-count": "",
  "save-history": true,
  "retain-audio": false,
  "playback-speed": "1",
  "follow-playback": true,
  "subtitle-line-length": "42",
  "subtitle-duration": "6",
  "subtitle-speakers": true,
};
const choices = {
  quality: ["fast", "balanced", "accurate"],
  model: ["tiny", "base", "small"],
  language: [
    "",
    "en",
    "el",
    "es",
    "fr",
    "de",
    "it",
    "pt",
    "nl",
    "ru",
    "uk",
    "tr",
    "ar",
    "he",
    "hi",
    "zh",
    "ja",
    "ko",
  ],
  processing: ["auto", "cpu"],
  "playback-speed": ["0.5", "0.75", "1", "1.25", "1.5", "2"],
};
function preferences() {
  const result = { ...defaults };
  try {
    const saved = JSON.parse(
      localStorage.getItem("whisper-preferences") || "{}",
    );
    for (const [key, fallback] of Object.entries(defaults)) {
      const value = saved[key];
      if (typeof fallback === "boolean" && typeof value === "boolean")
        result[key] = value;
      else if (choices[key]?.includes(value)) result[key] = value;
      else if (!choices[key] && typeof value === "string") {
        const limits = {
          "speaker-count": [1, 20],
          "subtitle-line-length": [10, 100],
          "subtitle-duration": [1, 30],
        };
        const [min, max] = limits[key] || [0, Infinity];
        if (
          (key === "speaker-count" && value === "") ||
          (Number(value) >= min && Number(value) <= max)
        )
          result[key] = value;
      }
    }
  } catch {
    /* Preferences are optional. */
  }
  return result;
}
const initial = () => ({
  prefs: preferences(),
  busy: false,
  recording: false,
  ready: false,
  setupBusy: false,
  advancedOpen: false,
  speakers: { ready: false, installed: false, state: "idle" },
  speakerMessage: "",
  acceleration: "Checking processing…",
  queue: [],
  records: [],
  selectedId: null,
  file: null,
  result: false,
  resultName: "",
  activeJob: null,
  progress: null,
  message: "Choose a recording to begin.",
  messageType: "",
  historyMessage: "",
  copied: false,
});
const el = (id) => document.getElementById(id);
const extensions = new Set(
  "mp3 wav m4a flac ogg opus webm aac mp4 wma aiff aif".split(" "),
);
const validFile = (file) =>
  extensions.has(file.name.split(".").pop().toLowerCase()) &&
  file.size > 0 &&
  file.size <= 500 * 1024 * 1024;
const baseName = (name) => name.replace(/\.[^.]+$/, "") || "transcript";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const stages = {
  uploading: "Reading file",
  decoding: "Decoding audio",
  downloading: "Downloading model",
  loading: "Loading model",
  transcribing: "Transcribing",
  aligning: "Aligning timestamps",
  diarizing: "Detecting speakers",
  cancelling: "Cancelling",
};
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

// React owns application state; the existing editor and media engines own only
// their isolated editing, waveform, and recording elements.
function createWorkspace(start, update) {
  let state = start,
    disposed = false,
    audioURL = null,
    selected = null,
    record = null;
  let saveTimer = null,
    copyTimer = null,
    stopQueue = false;
  let selecting = false;
  const abort = new AbortController();
  const library = new window.LocalLibrary();
  const patch = (values) => {
    state = { ...state, ...values };
    if (!disposed) update(state);
  };
  const status = (message, messageType = "") => patch({ message, messageType });
  const api = async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      signal: abort.signal,
      headers: {
        "X-App-Token":
          document.querySelector('meta[name="app-token"]')?.content || "",
        ...options.headers,
      },
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
  };
  const editor = new window.TranscriptEditor({
    onChange(data) {
      if (selected?.result) selected.result = data;
      if (record) {
        record.result = data;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveCurrent, 350);
      }
    },
    onSeek(seconds) {
      if (!audioURL) return;
      el("audio-player").currentTime = seconds;
      el("audio-player")
        .play()
        .catch(() =>
          status(
            "This format cannot be previewed in your browser. You can still edit and export.",
          ),
        );
    },
    onStatus: status,
  });
  const media = new window.AudioWorkspace({
    onRecorded: (file) => chooseFiles([file]),
    onRangeChange(range) {
      if (selected) selected.range = range;
    },
    onRecordingChange(recording) {
      patch({ recording });
    },
    onStatus: status,
  });
  const playback = () => editor.setPlaybackTime(el("audio-player").currentTime);
  el("audio-player").addEventListener("timeupdate", playback);
  el("audio-player").playbackRate = Number(state.prefs["playback-speed"]);
  const setBusy = (busy) => {
    patch({ busy });
    media.setBusy(busy);
  };
  const refreshQueue = () =>
    patch({ queue: [...state.queue], selectedId: selected?.id || null });
  async function refreshHistory() {
    try {
      patch({ records: await library.list() });
    } catch {
      patch({
        historyMessage:
          "Browser storage is unavailable. Export transcripts to keep them.",
      });
    }
  }
  async function saveCurrent() {
    editor.flushEdit();
    clearTimeout(saveTimer);
    if (!record || !state.prefs["save-history"]) return;
    const saved = {
      ...record,
      result: structuredClone(record.result),
      updated: Date.now(),
      audio: state.prefs["retain-audio"] ? state.file || record.audio : null,
    };
    // Removing retained audio must also release the in-memory library reference.
    record.audio = saved.audio;
    try {
      await library.put(saved);
      patch({ historyMessage: "Saved locally" });
    } catch {
      if (saved.audio) {
        try {
          await library.put({ ...saved, audio: null });
          patch({
            historyMessage:
              "Transcript saved. Audio could not be retained; storage may be full.",
          });
        } catch {
          patch({
            historyMessage:
              "Local saving unavailable. Export your transcript to keep it.",
          });
        }
      } else
        patch({
          historyMessage:
            "Local saving unavailable. Export your transcript to keep it.",
        });
    }
    await refreshHistory();
  }
  async function preview(file, range = null) {
    if (audioURL) URL.revokeObjectURL(audioURL);
    audioURL = file ? URL.createObjectURL(file) : null;
    patch({ file });
    editor.setAudioAvailable(!!audioURL);
    const audio = el("audio-player");
    if (file) {
      audio.src = audioURL;
      const loading = media.load(file);
      media.setRange(range);
      await loading;
    } else {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      media.clear();
    }
  }
  function showResult(data, entry = null, saved = null) {
    selected = entry;
    record = saved || {
      id: entry?.id || crypto.randomUUID(),
      name: entry?.name || "transcript",
      created: Date.now(),
      updated: Date.now(),
      result: data,
      audio: null,
    };
    editor.load(data);
    editor.setAudioAvailable(!!audioURL);
    record.result = editor.snapshot();
    if (entry) entry.result = record.result;
    patch({
      result: true,
      resultName: record.name,
      selectedId: entry?.id || null,
    });
    status(
      data.warning ||
        (data.text?.trim()
          ? "Done. Review, edit, or export your transcript."
          : "Finished. No speech was detected."),
      data.warning ? "error" : "success",
    );
  }
  async function selectEntry(entry) {
    if (state.recording) return;
    await saveCurrent();
    selected = entry;
    record = null;
    if (entry.result) showResult(entry.result, entry);
    else patch({ result: false, resultName: "" });
    refreshQueue();
    preview(entry.file, entry.range).catch((error) =>
      status(error.message, "error"),
    );
  }
  async function chooseFiles(files) {
    if (state.busy || state.recording || selecting) return;
    const accepted = [],
      rejected = [];
    for (const file of files) {
      if (!validFile(file)) {
        rejected.push(file.name);
        continue;
      }
      accepted.push({
        id: crypto.randomUUID(),
        file,
        name: baseName(file.name),
        state: "queued",
        range: null,
        result: null,
      });
    }
    patch({ queue: [...state.queue, ...accepted] });
    if (accepted.length) {
      selecting = true;
      try {
        await selectEntry(accepted[0]);
      } finally {
        selecting = false;
      }
      status(
        `${accepted.length > 1 ? `${accepted.length} recordings queued.` : "Ready when you are."}${rejected.length ? ` Skipped ${rejected.length} unsupported, empty, or oversized files.` : ""}`,
      );
    } else if (rejected.length)
      status(
        "Choose a nonempty audio file such as MP3, WAV, or M4A, smaller than 500 MB.",
        "error",
      );
  }
  function setPref(key, value) {
    const prefs = { ...state.prefs, [key]: value };
    if (key === "quality") {
      prefs.model = { fast: "tiny", balanced: "base", accurate: "small" }[
        value
      ];
      if (value === "fast") {
        prefs.processing = "auto";
        prefs["detect-speakers"] = false;
      }
    }
    patch({ prefs });
    try {
      localStorage.setItem("whisper-preferences", JSON.stringify(prefs));
    } catch {
      /* Storage is optional. */
    }
    if (key === "save-history" && !value) {
      clearTimeout(saveTimer);
      patch({
        historyMessage: "Autosave off. Existing saved transcripts remain.",
      });
    } else if (["save-history", "retain-audio"].includes(key)) saveCurrent();
  }
  function updateSpeakers(speakers) {
    patch({
      speakers,
      setupBusy: speakers.state === "downloading",
      speakerMessage: !speakers.installed
        ? "Run Setup.ps1 and restart the app to install speaker detection."
        : speakers.ready
          ? "Speaker model ready. Works offline."
          : speakers.message ||
            "Download the speaker model to enable detection.",
    });
  }
  async function pollSpeakers() {
    let failures = 0;
    while (!disposed) {
      try {
        const data = await api("/api/speakers/status");
        failures = 0;
        updateSpeakers(data);
        if (data.state !== "downloading") return;
      } catch (error) {
        if (++failures >= 3 || disposed) throw error;
      }
      await delay(1000);
    }
  }
  async function setupSpeakers() {
    const input = el("hf-token"),
      token = input.value.trim();
    if (!token.startsWith("hf_")) {
      patch({
        speakerMessage: "Enter a Hugging Face read token starting with hf_.",
      });
      input.focus();
      return;
    }
    patch({ setupBusy: true });
    try {
      await api("/api/speakers/setup", {
        method: "POST",
        body: JSON.stringify({ token }),
        headers: { "Content-Type": "application/json" },
      });
      input.value = "";
      await pollSpeakers();
    } catch (error) {
      patch({ speakerMessage: error.message });
    } finally {
      input.value = "";
      patch({ setupBusy: false });
    }
  }
  function progress(data) {
    patch({ progress: data });
    if (!stopQueue)
      status(data.message || "Processing your recording…", "working");
  }
  async function poll(id) {
    let failures = 0;
    while (!disposed) {
      let data;
      try {
        data = await api(`/api/jobs/${encodeURIComponent(id)}`);
        failures = 0;
      } catch (error) {
        if (error.status === 404 || ++failures >= 3 || disposed) throw error;
        await delay(1500);
        continue;
      }
      if (["complete", "error", "cancelled"].includes(data.state)) {
        sessionStorage.removeItem("whisper-job");
        patch({ activeJob: null, progress: null });
        return data;
      }
      progress(data);
      await delay(700);
    }
    throw new Error("Workspace closed.");
  }
  async function transcribe() {
    if (
      state.busy ||
      state.activeJob ||
      state.recording ||
      state.setupBusy ||
      !state.ready ||
      selecting
    )
      return;
    for (const id of [
      "range-start",
      "range-end",
      ...(state.prefs["detect-speakers"] ? ["speaker-count"] : []),
    ]) {
      if (!el(id).checkValidity()) {
        if (id === "speaker-count") patch({ advancedOpen: true });
        requestAnimationFrame(() => el(id)?.reportValidity());
        return;
      }
    }
    if (state.prefs["detect-speakers"] && !state.speakers.ready) {
      patch({ advancedOpen: true });
      status("Complete speaker setup first.", "error");
      return;
    }
    if (!state.queue.some((item) => item.state === "queued")) {
      if (!state.file) return;
      patch({
        queue: [
          ...state.queue,
          {
            id: crypto.randomUUID(),
            file: state.file,
            name: baseName(state.file.name),
            state: "queued",
            range: media.range(),
            result: null,
          },
        ],
      });
    }
    setBusy(true);
    patch({ result: false });
    await saveCurrent();
    const prefs = state.prefs;
    const settings = {
      model: prefs.model,
      quality: prefs.quality,
      language: prefs.language,
      processing: prefs.processing,
      detect_speakers: String(prefs["detect-speakers"]),
      num_speakers: prefs["detect-speakers"] ? prefs["speaker-count"] : "",
    };
    stopQueue = false;
    try {
      for (const entry of state.queue.filter(
        (item) => item.state === "queued",
      )) {
        if (stopQueue || disposed) break;
        await selectEntry(entry);
        entry.state = "running";
        refreshQueue();
        progress({
          state: "uploading",
          message: `Reading ${entry.file.name}…`,
        });
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
          patch({ activeJob: data.job_id });
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
          if (state.activeJob && error.status !== 404)
            status(
              `${error.message} Refresh to reconnect to the current job.`,
              "error",
            );
          else {
            patch({ activeJob: null, progress: null });
            sessionStorage.removeItem("whisper-job");
            status(error.message, "error");
          }
        }
        refreshQueue();
      }
    } finally {
      setBusy(false);
      await refreshHistory();
    }
  }
  async function cancel() {
    if (!state.activeJob) return;
    stopQueue = true;
    try {
      await api(`/api/jobs/${encodeURIComponent(state.activeJob)}/cancel`, {
        method: "POST",
      });
      status(
        "Cancellation requested. Waiting for processing to stop…",
        "working",
      );
    } catch (error) {
      status(error.message, "error");
    }
  }
  async function openRecord(id) {
    if (state.busy || state.recording) return;
    await saveCurrent();
    const saved = await library.get(id);
    if (!saved) return;
    selected = null;
    record = saved;
    await preview(saved.audio || null);
    showResult(saved.result, null, saved);
    status(
      saved.audio
        ? "Saved transcript opened with audio."
        : "Saved transcript opened. Use Attach audio to restore playback.",
    );
  }
  async function deleteRecord(id) {
    if (state.busy) return;
    clearTimeout(saveTimer);
    if (record?.id === id) record = null;
    try {
      await library.delete(id);
      await refreshHistory();
      patch({ historyMessage: "Deleted from local library" });
    } catch {
      patch({ historyMessage: "Could not delete this transcript." });
    }
  }
  async function clearHistory() {
    if (state.busy) return;
    clearTimeout(saveTimer);
    record = null;
    try {
      await library.clear();
      await refreshHistory();
      patch({ historyMessage: "Local library cleared" });
    } catch {
      patch({ historyMessage: "Could not clear local library." });
    }
  }
  async function copy() {
    editor.flushEdit();
    try {
      await navigator.clipboard.writeText(editor.text());
      patch({ copied: true });
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => patch({ copied: false }), 1600);
    } catch {
      editor.view(false);
      el("transcript").select();
      status("Press Ctrl+C (or Command+C) to copy the selected transcript.");
    }
  }
  function exportFile(format) {
    if (!state.result) return;
    editor.flushEdit();
    download(
      `${record?.name || selected?.name || baseName(state.file?.name || "transcript")}.${format}`,
      editor.export(format),
      format === "json"
        ? "application/json;charset=utf-8"
        : format === "vtt"
          ? "text/vtt;charset=utf-8"
          : undefined,
    );
  }
  function exportBatch() {
    editor.flushEdit();
    const files = [],
      names = new Map();
    let index = 0;
    const options = {
      lineLength: Number(state.prefs["subtitle-line-length"]) || 42,
      maxDuration: Number(state.prefs["subtitle-duration"]) || 6,
      includeSpeakers: state.prefs["subtitle-speakers"],
    };
    for (const entry of state.queue.filter((item) => item.result)) {
      const clean =
        entry.name
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
          .replace(/^\.+/, "_") || "transcript";
      const count = (names.get(clean) || 0) + 1;
      names.set(clean, count);
      const name = `${String(++index).padStart(3, "0")}-${clean}${count > 1 ? `-${count}` : ""}`;
      for (const format of ["txt", "srt", "vtt", "json"])
        files.push({
          name: `${name}.${format}`,
          text: window.TranscriptEditor.export(entry.result, format, options),
        });
    }
    if (files.length)
      download("whisper-transcripts.zip", window.transcriptZip(files));
  }
  async function attachAudio(file) {
    if (!file || state.busy || state.recording || !state.result) return;
    if (!validFile(file)) {
      status("Choose the original recording, smaller than 500 MB.", "error");
      return;
    }
    await preview(file);
    await saveCurrent();
    status("Audio attached. Your transcript edits are ready for review.");
  }
  async function init() {
    refreshHistory();
    try {
      const data = await api("/api/status");
      patch({
        ready: !!data.whisper,
        acceleration: data.acceleration?.gpu_available
          ? `${data.acceleration.gpu_name || "NVIDIA GPU"} available`
          : "Using your CPU",
      });
      updateSpeakers(data.speakers || state.speakers);
      if (state.speakers.state === "downloading") {
        setPref("detect-speakers", true);
        patch({ advancedOpen: true });
        pollSpeakers().catch((error) =>
          patch({ speakerMessage: error.message, setupBusy: false }),
        );
      }
      if (!data.whisper)
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
        patch({ activeJob: job.id });
        setBusy(true);
        const completed = await poll(job.id);
        if (completed.state === "complete") {
          showResult(completed, {
            id: job.recordId || crypto.randomUUID(),
            name: job.name || "transcript",
            result: completed,
          });
          selected = null;
          await saveCurrent();
        } else
          status(
            completed.message || "The job was cancelled.",
            completed.state === "error" ? "error" : "",
          );
      }
    } catch (error) {
      if (disposed) return;
      if (error.status === 404) {
        patch({ activeJob: null });
        sessionStorage.removeItem("whisper-job");
      }
      status(
        error.message ||
          "Could not connect. Keep the launch window open and refresh.",
        "error",
      );
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  const visibility = () => {
    if (document.visibilityState === "hidden") saveCurrent();
  };
  const preventDrop = (event) => event.preventDefault();
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("dragover", preventDrop);
  window.addEventListener("drop", preventDrop);
  init();
  return {
    chooseFiles,
    setPref,
    transcribe,
    setupSpeakers,
    cancel,
    copy,
    exportFile,
    exportBatch,
    attachAudio,
    openRecord,
    deleteRecord,
    clearHistory,
    setAdvancedOpen: (advancedOpen) => patch({ advancedOpen }),
    selectEntry: (entry) => {
      if (!state.busy && !state.recording) selectEntry(entry);
    },
    fastMode: () => {
      setPref("quality", "fast");
      status(
        "Fast mode uses Tiny with quick decoding and speaker detection off. Review the draft for accuracy.",
      );
    },
    removeEntry: async (id) => {
      if (state.busy || state.recording) return;
      if (selected?.id === id) {
        await saveCurrent();
        selected = null;
      }
      patch({ queue: state.queue.filter((item) => item.id !== id) });
      refreshQueue();
    },
    clearQueue: () => {
      patch({
        queue: state.queue.filter((item) =>
          ["queued", "running"].includes(item.state),
        ),
      });
    },
    stopQueue: () => {
      stopQueue = true;
      status(
        "The current recording will finish. Remaining files will stay queued.",
        "working",
      );
    },
    dispose() {
      saveCurrent();
      disposed = true;
      abort.abort();
      clearTimeout(saveTimer);
      clearTimeout(copyTimer);
      clearTimeout(editor.timer);
      editor.dispose();
      media.dispose();
      if (audioURL) URL.revokeObjectURL(audioURL);
      el("audio-player")?.removeEventListener("timeupdate", playback);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("dragover", preventDrop);
      window.removeEventListener("drop", preventDrop);
    },
  };
}

export function useWorkspace() {
  const [state, setState] = useState(initial);
  const actions = useRef(null);
  useEffect(() => {
    actions.current = createWorkspace(state, setState);
    return () => actions.current.dispose();
    // Workspace engines mount once, after their DOM elements exist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = (name, ...args) => actions.current?.[name](...args);
  return { ...state, run };
}
