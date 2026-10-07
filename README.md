# Whisper Local

A small browser app for private audio transcription using OpenAI's open-source
Whisper models. Upload a recording, transcribe on your computer, and export text
or subtitles. No OpenAI account, API key, or transcription fees.

![Whisper Local with an example speaker-labeled transcript](docs/screenshot.png)

*The screenshot uses a deterministic two-speaker fixture to demonstrate the UI.*

## Features

- Drag-and-drop audio uploads, playback, and clickable timestamps.
- Multilingual Tiny, Base, and Small models through faster-whisper.
- Automatic NVIDIA GPU acceleration with an INT8 CPU fallback.
- Fast mode preset for short turnaround; manual CPU processing is also available.
- Optional speaker detection, editable names, and speaker-aware TXT/SRT exports.
- Copy transcripts and resume a running job after refreshing the same browser tab.
- Local model caching, upload cleanup, and no application analytics.

## Quick start on Windows

1. Install the [Python install manager](https://www.python.org/downloads/windows/).
2. Clone or extract this repository.
3. Double-click **Start.cmd**. First launch runs setup and opens your browser.

Setup creates a private Python 3.11 runtime in `.runtime`. If an NVIDIA GPU is
detected, it installs CUDA-enabled PyTorch and its GPU libraries; that download
can be several GB. Other computers use CPU packages. A separate CUDA toolkit or
FFmpeg installation is not required. Audio decoding uses PyAV.

For a smaller CPU-only installation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1 -CpuOnly
.\Start.cmd
```

Keep the launch window open while using the app. Close existing app instances
before rerunning setup. The default address is `http://127.0.0.1:8765`.

## Standard Python installation

Use Python **3.11 or 3.12**, with a virtual environment. For CPU inference:

```sh
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux: source .venv/bin/activate
python -m pip install -r requirements-engine.txt --index-url https://download.pytorch.org/whl/cpu
python -m pip install -e .
python -m whisper_local
```

For a compatible NVIDIA GPU, install `requirements-engine-gpu.txt` instead with
`--index-url https://download.pytorch.org/whl/cu128` before installing the app.
Windows is the verified inference platform. CI checks Python and browser behavior
on Windows and Linux without loading model weights. macOS/MPS acceleration has
not been implemented or verified.

The installed command `whisper-local` and `python -m whisper_local` accept:

```sh
python -m whisper_local --port 8766 --no-browser
```

The server always binds to loopback. If the selected port is occupied, it exits
with an explanation before opening the browser.

## Speaker detection

Whisper supplies text and timestamps; **pyannote Community-1** supplies speaker
turns. Enable **Detect speakers** in the app and follow its one-time setup:

1. Sign in to Hugging Face and accept the access conditions for
   [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1).
2. Create a [read access token](https://huggingface.co/settings/tokens).
3. Paste it into the app's download field and download the speaker model.

The app uses the token for that download and clears the field. It does not save
the token. After setup, speaker inference uses local model files. Speaker names
start as “Speaker 1”, “Speaker 2”, etc.; rename them before copying or exporting.
You can specify a known speaker count from 1 to 20 or leave it automatic.

Speaker labels are estimates, especially during overlapping speech. The app
does not identify people by name. Distant words without a matching speaker turn
are marked “Unassigned”. If detection fails, the completed transcript is retained
with a warning. Attribution, setup behavior, and GPU recovery have fixture tests;
real Community-1 inference still requires the gated download and is not claimed
as verified by those tests.

## Models and speed

| Model | Approximate download | Use |
| --- | --- | --- |
| Tiny | 75 MB | Fastest, lower accuracy |
| Base | 145 MB | Default balance |
| Small | 460 MB | More accuracy, more processing time |

Missing models download on first use, then work offline. **Fast mode** selects
Tiny, automatic acceleration, and speaker detection off. NVIDIA inference uses
FP16; CPU inference uses INT8. A GPU runtime failure retries on CPU.

An illustrative local benchmark on an i9-12900K / RTX 3060 12 GB, using 80.47
seconds of synthesized English speech and already loaded models:

| Engine / model | Median transcription time |
| --- | ---: |
| Original Whisper Base, CPU | 3.900 s |
| faster-whisper Base, CPU INT8 | 3.287 s |
| faster-whisper Base, GPU FP16 | 0.895 s |
| faster-whisper Tiny, GPU FP16 | 0.568 s |

These are two-run warm medians with no speaker detection; they exclude download,
loading, decoding, and upload time. They are not a general performance guarantee.
See [benchmark data](docs/speed-benchmark.json).

## Formats and storage

Accepts MP3, WAV, M4A, FLAC, OGG, Opus, WebM, AAC, MP4, WMA, and AIFF, up to
500 MB. Browser playback support varies by format. Automatic language detection
is available; a manual language choice can improve short recordings.

- Audio stays on your computer. Setup and model downloads need internet access;
  inference uses locally cached weights. pyannote/Hugging Face telemetry is disabled.
- Temporary uploads are deleted after success or failure. Forced termination can
  leave the upload folder in the operating system's temp directory.
- At most ten job results are kept in memory. Old completed results are pruned
  when a new upload is accepted; closing the app clears all results.
- Refreshing the same tab resumes its current job but cannot restore the audio
  preview. Export transcripts you want to keep.
- One transcription runs at a time. Speaker setup cannot run concurrently with it.

Source checkouts cache weights in `.models` beside `pyproject.toml`. A wheel
installation uses your operating system's user cache directory. Override either
with the `WHISPER_LOCAL_MODELS_DIR` environment variable. Runtime files, model
weights, recordings, and credentials are excluded from Git.

## Troubleshooting

- **Model download failed:** check the connection and retry. A missing ready marker
  triggers another download attempt.
- **Speaker setup failed:** accept the model's conditions and use a token that can
  read that repository. Ordinary transcription works without speaker setup.
- **GPU unavailable:** update the NVIDIA driver or choose CPU processing. The
  pinned GPU packages target CUDA 12.8; unsupported hardware falls back to CPU.
- **Port already in use:** close the other launch window or use `--port 8766`.
- **Invalid recording:** try a valid WAV or MP3. Changing a filename extension does
  not convert an audio file.

Whisper can mishear names, hallucinate words on silence, and produce approximate
timestamps. Review the transcript before using it.

## Development

The application uses Flask/Waitress, a plain HTML/CSS/JavaScript frontend, and one
background inference worker. Audio is decoded once to mono 16 kHz and passed to
the speaker model as a tensor, avoiding a separate shared FFmpeg installation.

```text
src/whisper_local/   application, inference, speaker attribution, UI assets
tests/              deterministic regression tests and opt-in inference test
tests/browser/      browser checks with intercepted requests
scripts/            distribution validation
.github/workflows/  Windows/Linux checks, browser checks, package build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for installation and test commands.
The source is MIT licensed; weights and dependencies retain their licenses.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [SECURITY.md](SECURITY.md).
This is an independent project, unaffiliated with OpenAI or pyannote.
