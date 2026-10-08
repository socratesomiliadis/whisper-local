# Changelog

## Unreleased

- Reuse a persistent inference worker and in-memory Whisper, alignment, and speaker
  models across recordings, sharing GPU memory between stages. Cancellation and
  shutdown terminate the worker and release its caches.
- WhisperX batched transcription and cached language-specific word alignment,
  with alignment progress, CPU recovery, and transcript preservation on alignment failure.
- Word timestamps retained through speaker assignment, selected ranges, and JSON
  exports; text/timing edits clear stale word metadata. Bundled Silero speech detection.
- Editable transcript segments, timing corrections, manual speaker assignment,
  search/replace, and undo/redo, shared across copying, saving, and exports.
- Browser-local IndexedDB transcript autosave, individual/all-record deletion,
  optional retained audio, and remembered review/transcription preferences.
- Synchronized playback highlighting, follow scrolling, playback speeds, skip
  controls, waveform previews, and selected-range transcription with original timestamps.
- Microphone capture with pause, resume, preview, discard, and permission handling.
- Sequential browser batch queues and ZIP downloads containing TXT/SRT/VTT/JSON results.
- VTT and JSON exports, subtitle line length/cue duration controls, and optional speaker labels.
- Fast/Tiny, Balanced/Base, and Accurate/Small presets with decoding beams 1/3/5.
- Structured stage progress, isolated inference processes, actual cancellation,
  private-upload cleanup on cancellation/shutdown, and session CPU fallback after GPU failure.
- More transcript space after file selection, collapsible advanced settings,
  accessible controls, and responsive editing layouts.
- Regression coverage for editing/export consistency, local history, queues,
  media controls, range offsets, worker completion, cancellation, and shutdown.

## 0.1.0

- Local uploads, audio preview, timestamps, and TXT/SRT export.
- Tiny, Base, and Small multilingual Whisper models using faster-whisper.
- Automatic NVIDIA GPU inference with INT8 CPU fallback and a Fast mode preset.
- Optional Community-1 speaker detection, word attribution, and editable labels.
- Loopback server, per-launch API token, temporary upload cleanup, and job recovery.
- Installable Python package, portable model storage, regression tests, and CI.
