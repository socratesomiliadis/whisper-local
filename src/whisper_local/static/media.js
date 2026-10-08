"use strict";

// Browser-only recording and playback controls. The application owns audio URLs.
window.AudioWorkspace = class AudioWorkspace {
  constructor(options = {}) {
    this.options = options;
    this.audio = document.getElementById("audio-player");
    this.canvas = document.getElementById("waveform");
    this.panel = document.getElementById("waveform-panel");
    this.startInput = document.getElementById("range-start");
    this.endInput = document.getElementById("range-end");
    this.busy = false;
    this.duration = 0;
    this.peaks = null;
    this.selection = null;
    this.generation = 0;
    this.listeners = [];
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.recordingElapsed = 0;
    this.recordingStarted = 0;
    this.discardRecording = false;
    this.recordingPending = false;
    this.recordingFinishing = false;
    this.reportedRecordingState = false;
    this.recordingGeneration = 0;
    this.recordingTimer = null;
    this.drawFrame = null;
    this.context = null;
    this.disposed = false;

    this.listen(this.startInput, "change", () => this.readRange());
    this.listen(this.endInput, "change", () => this.readRange());
    this.listen(document.getElementById("range-reset"), "click", () =>
      this.resetRange(),
    );
    this.listen(
      document.getElementById("playback-speed"),
      "change",
      (event) => {
        const speed = Number(event.target.value);
        if (this.audio && speed >= 0.25 && speed <= 4)
          this.audio.playbackRate = speed;
      },
    );
    this.listen(document.getElementById("skip-back"), "click", () =>
      this.seek(-10),
    );
    this.listen(document.getElementById("skip-forward"), "click", () =>
      this.seek(10),
    );
    this.listen(document.getElementById("record-start"), "click", () =>
      this.startRecording(),
    );
    this.listen(document.getElementById("record-pause"), "click", () =>
      this.pauseRecording(),
    );
    this.listen(document.getElementById("record-stop"), "click", () =>
      this.stopRecording(false),
    );
    this.listen(document.getElementById("record-discard"), "click", () =>
      this.stopRecording(true),
    );
    this.listen(this.audio, "loadedmetadata", () => {
      if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
        this.duration = this.audio.duration;
        this.updateRangeLimits();
        this.scheduleDraw();
      }
    });
    this.listen(this.audio, "timeupdate", () => this.scheduleDraw());
    this.listen(this.audio, "seeked", () => this.scheduleDraw());
    this.listen(window, "pagehide", () => this.stopRecording(true));
    if (this.canvas) {
      this.canvas.tabIndex = 0;
      this.canvas.setAttribute("role", "group");
      this.canvas.setAttribute(
        "aria-label",
        "Audio waveform. Drag to select a transcription range, or use the start and end time fields. Left and right arrows seek ten seconds.",
      );
      this.canvas.style.touchAction = "none";
      this.listen(this.canvas, "pointerdown", (event) =>
        this.beginSelection(event),
      );
      this.listen(this.canvas, "pointermove", (event) =>
        this.moveSelection(event),
      );
      this.listen(this.canvas, "pointerup", (event) =>
        this.endSelection(event),
      );
      this.listen(this.canvas, "pointercancel", () => {
        if (this.drag) this.selection = this.drag.previous;
        this.drag = null;
        this.scheduleDraw();
      });
      this.listen(this.canvas, "keydown", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          this.seek(event.key === "ArrowLeft" ? -10 : 10);
        }
      });
      if (window.ResizeObserver) {
        this.observer = new ResizeObserver(() => this.scheduleDraw());
        this.observer.observe(this.canvas);
      } else this.listen(window, "resize", () => this.scheduleDraw());
    }
    this.updateRecordingControls();
    this.updateRangeControls();
  }

  listen(element, type, listener) {
    if (!element) return;
    element.addEventListener(type, listener);
    this.listeners.push(() => element.removeEventListener(type, listener));
  }

  report(message, type = "") {
    if (this.options.onStatus) this.options.onStatus(message, type);
  }

  waveformStatus(message) {
    const element = document.getElementById("waveform-status");
    if (element) element.textContent = message;
  }

  async load(file) {
    const generation = ++this.generation;
    this.peaks = null;
    this.duration = 0;
    this.selection = null;
    this.drag = null;
    if (this.startInput) this.startInput.value = "0";
    if (this.endInput) this.endInput.value = "";
    if (this.startInput) this.startInput.setCustomValidity("");
    if (this.endInput) this.endInput.setCustomValidity("");
    if (this.panel) this.panel.hidden = !file;
    this.updateRangeLimits();
    this.updateRangeControls();
    this.scheduleDraw();
    if (!file) return;
    this.waveformStatus(
      "Preparing waveform… You can transcribe without waiting.",
    );
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) {
      this.waveformStatus(
        "Waveform preview is unavailable in this browser. Use the time fields to select a range.",
      );
      return;
    }
    // Decoding expands compressed audio substantially. Long/large files remain
    // usable by the player and server without allocating a full browser buffer.
    await this.waitForMetadata(generation);
    if (generation !== this.generation || this.disposed) return;
    if (
      file.size > 64 * 1024 * 1024 ||
      this.duration > 1800 ||
      (!this.duration && file.size > 16 * 1024 * 1024)
    ) {
      this.waveformStatus(
        "Waveform preview skipped for this large recording. Playback and transcription are available; use the time fields to select a range.",
      );
      this.scheduleDraw();
      return;
    }
    let context;
    try {
      context = new Context();
      this.context = context;
      const data = await file.arrayBuffer();
      if (generation !== this.generation || this.disposed) return;
      const buffer = await context.decodeAudioData(data);
      if (generation !== this.generation || this.disposed) return;
      this.duration = buffer.duration;
      const channel = buffer.getChannelData(0);
      const count = Math.min(1600, channel.length);
      const peaks = new Float32Array(count);
      const stride = channel.length / count;
      // At most 64 sample reads per peak keeps long previews responsive.
      for (let index = 0; index < count; index++) {
        const from = Math.floor(index * stride);
        const to = Math.min(channel.length, Math.floor((index + 1) * stride));
        const step = Math.max(1, Math.floor((to - from) / 64));
        for (let sample = from; sample < to; sample += step) {
          peaks[index] = Math.max(peaks[index], Math.abs(channel[sample]));
        }
      }
      this.peaks = peaks;
      this.updateRangeLimits();
      this.waveformStatus(
        "Drag across the waveform to select a transcription range. Click to seek.",
      );
      this.scheduleDraw();
    } catch (_) {
      if (generation === this.generation && !this.disposed) {
        this.waveformStatus(
          "This format has no browser waveform preview. You can still transcribe it and select a range with the time fields.",
        );
      }
    } finally {
      if (context && context.state !== "closed")
        await context.close().catch(() => {});
      if (this.context === context) this.context = null;
    }
  }

  waitForMetadata(generation) {
    if (!this.audio) return Promise.resolve();
    if (this.audio.readyState >= 1 && Number.isFinite(this.audio.duration)) {
      this.duration = this.audio.duration;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        this.audio.removeEventListener("loadedmetadata", finish);
        this.audio.removeEventListener("error", finish);
        if (
          generation === this.generation &&
          Number.isFinite(this.audio.duration)
        )
          this.duration = this.audio.duration;
        resolve();
      };
      const timeout = setTimeout(finish, 2000);
      this.audio.addEventListener("loadedmetadata", finish, { once: true });
      this.audio.addEventListener("error", finish, { once: true });
    });
  }

  clear() {
    this.load(null);
    this.waveformStatus("");
  }

  range() {
    return this.selection ? { ...this.selection } : null;
  }

  setRange(range) {
    const start = range ? Number(range.start ?? 0) : 0;
    const end =
      range && range.end !== null && range.end !== undefined
        ? Number(range.end)
        : null;
    if (
      !Number.isFinite(start) ||
      start < 0 ||
      (end !== null && (!Number.isFinite(end) || end <= start))
    ) {
      throw new RangeError(
        "The audio range must have a valid start and an end after the start.",
      );
    }
    this.selection = start === 0 && end === null ? null : { start, end };
    if (this.startInput) {
      this.startInput.value = String(start);
      this.startInput.setCustomValidity("");
    }
    if (this.endInput) {
      this.endInput.value = end === null ? "" : String(end);
      this.endInput.setCustomValidity("");
    }
    this.emitRange();
  }

  resetRange() {
    if (this.busy) return;
    this.selection = null;
    if (this.startInput) this.startInput.value = "0";
    if (this.endInput) this.endInput.value = "";
    if (this.startInput) this.startInput.setCustomValidity("");
    if (this.endInput) this.endInput.setCustomValidity("");
    this.emitRange();
  }

  readRange() {
    if (this.busy) return;
    const startText = this.startInput ? this.startInput.value.trim() : "";
    const endText = this.endInput ? this.endInput.value.trim() : "";
    const start = startText === "" ? 0 : Number(startText);
    const end = endText === "" ? null : Number(endText);
    const message =
      !Number.isFinite(start) || start < 0
        ? "Start time must be zero or greater."
        : end !== null && (!Number.isFinite(end) || end <= start)
          ? "End time must be after the start time."
          : this.duration > 0 &&
              (start >= this.duration ||
                (end !== null && end > this.duration + 0.01))
            ? "The selected range must be within this recording."
            : "";
    if (this.startInput) this.startInput.setCustomValidity(message);
    if (this.endInput) this.endInput.setCustomValidity(message);
    if (message) {
      (this.endInput || this.startInput)?.reportValidity();
      this.report(message, "error");
      return;
    }
    this.selection = start === 0 && end === null ? null : { start, end };
    this.emitRange();
  }

  emitRange() {
    if (this.options.onRangeChange) this.options.onRangeChange(this.range());
    this.scheduleDraw();
  }

  updateRangeLimits() {
    [this.startInput, this.endInput].forEach((input) => {
      if (!input) return;
      if (this.duration > 0) input.max = String(this.duration);
      else input.removeAttribute("max");
      input.min = "0";
      if (!input.hasAttribute("step")) input.step = "0.01";
    });
  }

  updateRangeControls() {
    [
      this.startInput,
      this.endInput,
      document.getElementById("range-reset"),
    ].forEach((element) => {
      if (element) element.disabled = this.busy || this.isRecording();
    });
    if (this.canvas)
      this.canvas.setAttribute(
        "aria-disabled",
        String(this.busy || this.isRecording()),
      );
  }

  seek(delta) {
    if (!this.audio) return;
    const max = Number.isFinite(this.audio.duration)
      ? this.audio.duration
      : this.duration || Infinity;
    this.audio.currentTime = Math.max(
      0,
      Math.min(max, (this.audio.currentTime || 0) + delta),
    );
  }

  pointerTime(event) {
    const rect = this.canvas.getBoundingClientRect();
    return (
      Math.max(
        0,
        Math.min(1, (event.clientX - rect.left) / (rect.width || 1)),
      ) * this.duration
    );
  }

  beginSelection(event) {
    if (this.busy || this.isRecording() || !this.duration || event.button !== 0)
      return;
    this.canvas.setPointerCapture(event.pointerId);
    this.drag = {
      pointer: event.pointerId,
      start: this.pointerTime(event),
      x: event.clientX,
      previous: this.range(),
    };
  }

  moveSelection(event) {
    if (!this.drag || this.drag.pointer !== event.pointerId || this.busy)
      return;
    if (Math.abs(event.clientX - this.drag.x) < 4) return;
    const time = this.pointerTime(event);
    this.selection = {
      start: Math.round(Math.min(time, this.drag.start) * 10) / 10,
      end: Math.min(
        this.duration,
        Math.round(Math.max(time, this.drag.start) * 10) / 10,
      ),
    };
    this.scheduleDraw();
  }

  endSelection(event) {
    if (!this.drag || this.drag.pointer !== event.pointerId) return;
    const drag = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(event.pointerId))
      this.canvas.releasePointerCapture(event.pointerId);
    if (this.busy) {
      this.selection = drag.previous;
      return;
    }
    if (Math.abs(event.clientX - drag.x) < 4) {
      this.selection = drag.previous;
      if (this.audio) this.audio.currentTime = drag.start;
      this.scheduleDraw();
      return;
    }
    if (this.selection && this.selection.end > this.selection.start) {
      if (this.startInput) {
        this.startInput.value = String(this.selection.start);
        this.startInput.setCustomValidity("");
      }
      if (this.endInput) {
        this.endInput.value = String(this.selection.end);
        this.endInput.setCustomValidity("");
      }
      this.emitRange();
    } else {
      this.selection = drag.previous;
      this.scheduleDraw();
    }
  }

  scheduleDraw() {
    if (this.drawFrame !== null || this.disposed) return;
    this.drawFrame = requestAnimationFrame(() => {
      this.drawFrame = null;
      this.draw();
    });
  }

  draw() {
    if (!this.canvas || !this.panel || this.panel.hidden) return;
    const width = this.canvas.clientWidth || 600;
    const height = this.canvas.clientHeight || 80;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);
    if (this.selection && this.duration) {
      ctx.fillStyle = "rgba(43, 99, 79, 0.14)";
      const x = (this.selection.start / this.duration) * width;
      const end =
        ((this.selection.end ?? this.duration) / this.duration) * width;
      ctx.fillRect(x, 0, Math.max(0, end - x), height);
    }
    ctx.strokeStyle = "#518b73";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (this.peaks && this.peaks.length) {
      const max = Math.max(0.01, ...this.peaks);
      const bars = Math.min(this.peaks.length, Math.floor(width / 3));
      for (let index = 0; index < bars; index++) {
        const peak =
          this.peaks[Math.floor((index / bars) * this.peaks.length)] / max;
        const x = ((index + 0.5) / bars) * width;
        const size = Math.max(1, peak * (height / 2 - 8));
        ctx.moveTo(x, height / 2 - size);
        ctx.lineTo(x, height / 2 + size);
      }
    } else {
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
    }
    ctx.stroke();
    if (this.duration && this.audio) {
      const x = Math.max(
        0,
        Math.min(width, (this.audio.currentTime / this.duration) * width),
      );
      ctx.strokeStyle = "#f97316";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  isRecording() {
    return (
      this.recordingPending ||
      this.recordingFinishing ||
      Boolean(this.recorder && this.recorder.state !== "inactive")
    );
  }

  async startRecording() {
    if (this.busy || this.isRecording() || this.disposed) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      this.report(
        "Microphone recording is unavailable. Open this app on localhost in a browser that supports MediaRecorder.",
        "error",
      );
      return;
    }
    const generation = ++this.recordingGeneration;
    this.recordingPending = true;
    this.recordingStatus("Waiting for microphone permission…");
    this.updateRecordingControls();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (
        generation !== this.recordingGeneration ||
        this.busy ||
        this.disposed
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ].find(
        (type) =>
          typeof MediaRecorder.isTypeSupported === "function" &&
          MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      this.recorder = recorder;
      this.chunks = [];
      this.discardRecording = false;
      this.recordingElapsed = 0;
      this.recordingStarted = performance.now();
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      });
      recorder.addEventListener("error", () => {
        this.report(
          "Microphone recording failed. Try recording again.",
          "error",
        );
        this.stopRecording(true);
      });
      recorder.addEventListener("stop", () => this.finishRecording(recorder));
      stream.getAudioTracks().forEach((track) =>
        track.addEventListener("ended", () => {
          if (recorder.state !== "inactive") {
            this.report(
              "The microphone disconnected. Your captured audio is available for preview.",
            );
            this.stopRecording(false);
          }
        }),
      );
      if (this.audio) this.audio.pause();
      recorder.start(1000);
      this.recordingTimer = setInterval(() => this.updateRecordingTime(), 250);
      this.recordingStatus("Recording microphone");
      this.updateRecordingTime();
    } catch (error) {
      this.releaseStream();
      if (generation === this.recordingGeneration && !this.disposed) {
        const message =
          error.name === "NotAllowedError" || error.name === "SecurityError"
            ? "Microphone access was denied. Allow microphone access in your browser and try again."
            : error.name === "NotFoundError"
              ? "No microphone was found. Connect a microphone and try again."
              : error.name === "NotReadableError"
                ? "The microphone is busy or unavailable. Close other recording apps and try again."
                : `Unable to record from the microphone: ${error.message || "unsupported recording format"}`;
        this.recordingStatus("Microphone unavailable");
        this.report(message, "error");
      }
    } finally {
      if (generation === this.recordingGeneration)
        this.recordingPending = false;
      this.updateRecordingControls();
    }
  }

  pauseRecording() {
    if (!this.recorder || this.busy) return;
    if (this.recorder.state === "recording") {
      this.recordingElapsed += performance.now() - this.recordingStarted;
      this.recorder.pause();
      this.recordingStatus("Recording paused");
    } else if (this.recorder.state === "paused") {
      this.recordingStarted = performance.now();
      this.recorder.resume();
      this.recordingStatus("Recording microphone");
    }
    this.updateRecordingTime();
    this.updateRecordingControls();
  }

  stopRecording(discard = false) {
    if (this.recordingPending && !this.recorder) {
      ++this.recordingGeneration;
      this.recordingPending = false;
      this.recordingStatus("Recording cancelled");
      this.updateRecordingControls();
      return;
    }
    if (!this.recorder || this.recorder.state === "inactive") return;
    this.discardRecording = discard;
    this.recordingFinishing = true;
    if (this.recorder.state === "recording")
      this.recordingElapsed += performance.now() - this.recordingStarted;
    clearInterval(this.recordingTimer);
    this.recordingTimer = null;
    this.recorder.stop();
    this.releaseStream();
    this.updateRecordingControls();
  }

  finishRecording(recorder) {
    if (this.recorder !== recorder) return;
    const discarded = this.discardRecording || this.disposed;
    const type = recorder.mimeType || this.chunks[0]?.type || "audio/webm";
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];
    this.recorder = null;
    this.recordingFinishing = false;
    this.recordingPending = false;
    clearInterval(this.recordingTimer);
    this.releaseStream();
    this.updateRecordingControls();
    this.recordingStatus(
      discarded ? "Recording discarded" : "Recording ready for preview",
    );
    if (discarded) return;
    if (!blob.size) {
      this.report("The recording was empty. Try recording again.", "error");
      return;
    }
    const extension = type.includes("mp4")
      ? "m4a"
      : type.includes("ogg")
        ? "ogg"
        : "webm";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = new File([blob], `recording-${stamp}.${extension}`, {
      type,
      lastModified: Date.now(),
    });
    if (this.options.onRecorded) {
      Promise.resolve(this.options.onRecorded(file)).catch((error) =>
        this.report(`Could not open recording: ${error.message}`, "error"),
      );
    }
  }

  releaseStream() {
    if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  recordingStatus(message) {
    const element = document.getElementById("recording-status");
    if (element) element.textContent = message;
  }

  updateRecordingTime() {
    const elapsed =
      this.recordingElapsed +
      (this.recorder?.state === "recording"
        ? performance.now() - this.recordingStarted
        : 0);
    const seconds = Math.floor(elapsed / 1000);
    const element = document.getElementById("recording-time");
    if (element)
      element.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  updateRecordingControls() {
    const active = this.isRecording();
    const paused = this.recorder?.state === "paused";
    const start = document.getElementById("record-start");
    const pause = document.getElementById("record-pause");
    const stop = document.getElementById("record-stop");
    const discard = document.getElementById("record-discard");
    if (start) start.disabled = this.busy || active;
    if (pause) {
      pause.disabled =
        this.busy || !this.recorder || this.recorder.state === "inactive";
      const label = pause.querySelector("[data-label]");
      if (label) label.textContent = paused ? "Resume" : "Pause";
      else pause.textContent = paused ? "Resume" : "Pause";
      pause.setAttribute(
        "aria-label",
        paused ? "Resume recording" : "Pause recording",
      );
    }
    if (stop) stop.disabled = !active || this.recordingPending;
    if (discard) discard.disabled = !active;
    this.updateRangeControls();
    if (active !== this.reportedRecordingState) {
      this.reportedRecordingState = active;
      if (this.options.onRecordingChange)
        this.options.onRecordingChange(active);
    }
  }

  setBusy(value) {
    this.busy = Boolean(value);
    this.updateRangeControls();
    this.updateRecordingControls();
  }

  dispose() {
    this.disposed = true;
    ++this.generation;
    this.stopRecording(true);
    this.releaseStream();
    clearInterval(this.recordingTimer);
    if (this.drawFrame !== null) cancelAnimationFrame(this.drawFrame);
    if (this.observer) this.observer.disconnect();
    this.listeners.forEach((remove) => remove());
    this.listeners = [];
    if (this.context && this.context.state !== "closed")
      this.context.close().catch(() => {});
  }
};
