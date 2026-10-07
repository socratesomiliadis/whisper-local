"""A loopback-only browser companion for Whisper with faster local inference."""

from __future__ import annotations

import argparse
import logging
import secrets
import shutil
import tempfile
import threading
import time
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import RequestEntityTooLarge

from . import diarization, engine

MAX_BYTES = 500 * 1024 * 1024
EXTENSIONS = {
    ".mp3",
    ".wav",
    ".m4a",
    ".flac",
    ".ogg",
    ".opus",
    ".webm",
    ".aac",
    ".mp4",
    ".wma",
    ".aiff",
    ".aif",
}
MODELS = {"tiny", "base", "small"}
TOKEN = secrets.token_urlsafe(32)
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_BYTES + 1024 * 1024
jobs: dict[str, dict] = {}
state_lock = threading.Lock()
engine_lock = threading.Lock()


@app.before_request
def local_requests_only():
    if request.host.split(":")[0] not in {"localhost", "127.0.0.1"}:
        return jsonify(error="This app accepts local connections only."), 403
    if request.path.startswith("/api/") and not secrets.compare_digest(
        request.headers.get("X-App-Token", "").encode("utf-8"), TOKEN.encode("utf-8")
    ):
        return jsonify(error="Refresh the app and try again."), 403


@app.after_request
def headers(response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
    )
    return response


@app.get("/")
def index():
    return render_template("index.html", token=TOKEN)


@app.get("/api/status")
def status():
    import importlib.util

    return jsonify(
        ffmpeg=bool(shutil.which("ffmpeg")),
        whisper=bool(importlib.util.find_spec("faster_whisper")),
        speakers=diarization.status(),
        acceleration=engine.capabilities(),
    )


@app.get("/api/speakers/status")
def speaker_status():
    return jsonify(diarization.status())


@app.post("/api/speakers/setup")
def speaker_setup():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify(error="Provide a download token."), 400
    token = data.get("token", "")
    if (
        not isinstance(token, str)
        or not token.strip().startswith("hf_")
        or len(token.strip()) > 500
    ):
        return jsonify(error="Enter a Hugging Face read token starting with hf_."), 400
    if not diarization.installed():
        return jsonify(error="Run Setup.ps1 and restart the app to install speaker detection."), 503
    with state_lock:
        if any(
            j["state"] in {"uploading", "loading", "transcribing", "diarizing"}
            for j in jobs.values()
        ):
            return jsonify(error="Wait for the current transcription to finish before setup."), 409
        with diarization.lock:
            if diarization.setup_state["state"] == "downloading":
                return jsonify(error="The speaker model is already downloading."), 409
            if diarization.ready():
                return jsonify(state="complete", message="Speaker detection is already ready."), 200
            diarization.setup_state.update(
                state="downloading",
                message="Downloading the speaker model. Keep the launch window open.",
            )
    threading.Thread(
        target=diarization.download, args=(token.strip(), engine_lock), daemon=True
    ).start()
    return jsonify(state="downloading"), 202


@app.errorhandler(RequestEntityTooLarge)
def too_large(_error):
    return jsonify(error="Choose an audio file smaller than 500 MB."), 413


def update_job(job_id, **values):
    with state_lock:
        jobs[job_id].update(values)


def timestamp(seconds: float) -> str:
    milliseconds = max(0, round(float(seconds) * 1000))
    hours, milliseconds = divmod(milliseconds, 3600000)
    minutes, milliseconds = divmod(milliseconds, 60000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def subtitle_text(segments, speakers=None) -> str:
    def text(s):
        label = (speakers or {}).get(s.get("speaker"))
        return (f"{label}: " if label else "") + s["text"].strip()

    return (
        "\n\n".join(
            f"{i}\n{timestamp(s['start'])} --> {timestamp(s['end'])}\n{text(s)}"
            for i, s in enumerate(segments, 1)
        )
        + "\n"
    )


def transcribe(
    job_id: str,
    folder: str,
    path: str,
    model_name: str,
    language: str,
    detect_speakers=False,
    num_speakers=None,
    processing="auto",
):
    try:
        with engine_lock:
            started = time.perf_counter()
            audio = engine.decode(path)
            result = engine.transcribe(
                audio,
                name=model_name,
                language=language,
                word_timestamps=detect_speakers,
                processing=processing,
                progress=lambda state, message: update_job(job_id, state=state, message=message),
            )
            segments = [
                {"start": float(s["start"]), "end": float(s["end"]), "text": s["text"].strip()}
                for s in result["segments"]
                if s["text"].strip()
            ]
            speakers, warning = {}, None
            if detect_speakers and segments:
                update_job(
                    job_id, state="diarizing", message="Detecting speakers on your computer…"
                )
                try:
                    turns = diarization.detect(
                        audio,
                        num_speakers,
                        progress=lambda message: update_job(job_id, message=message),
                        device=result["device"],
                    )
                    segments, speakers = diarization.assign_speakers(result["segments"], turns)
                except Exception as exc:
                    # Preserve successful transcription when speaker detection fails.
                    warning = (
                        "The transcript is ready, but speaker detection failed. "
                        + diarization.safe_error(exc)
                    )
            update_job(
                job_id,
                state="complete",
                message="Transcript ready.",
                text=result["text"].strip(),
                language=result["language"],
                segments=segments,
                speakers=speakers,
                warning=warning,
                srt=subtitle_text(segments, speakers),
                device=result["device"],
                gpu_fallback=result["gpu_fallback"],
                elapsed=round(time.perf_counter() - started, 2),
            )
    except Exception as exc:
        logging.exception("Transcription failed")
        if isinstance(exc, ValueError) and "could not be decoded" in str(exc):
            message = str(exc)
        elif isinstance(exc, RuntimeError) and "Failed to load audio" in str(exc):
            message = "This file could not be decoded. Try a valid MP3, WAV, or M4A recording."
        else:
            message = (
                "Whisper could not finish. Check your connection if the model is downloading, then try again. Details: "
                + str(exc)[:250]
            )
        update_job(job_id, state="error", message=message)
    finally:
        shutil.rmtree(folder, ignore_errors=True)


@app.post("/api/transcribe")
def start_transcription():
    audio = request.files.get("audio")
    if audio is None or not audio.filename:
        return jsonify(error="Choose an audio file first."), 400
    extension = Path(audio.filename).suffix.lower()
    if extension not in EXTENSIONS:
        return jsonify(error="Unsupported file type. Try MP3, WAV, M4A, FLAC, OGG, or WebM."), 400
    model_name = request.form.get("model", "base")
    language = request.form.get("language", "")
    processing = request.form.get("processing", "auto")
    if processing not in {"auto", "cpu"}:
        return jsonify(error="Choose automatic processing or CPU only."), 400
    detect_speakers = request.form.get("detect_speakers", "false") == "true"
    count = request.form.get("num_speakers", "")
    if count and (
        len(count) > 2 or not count.isascii() or not count.isdigit() or not 1 <= int(count) <= 20
    ):
        return jsonify(error="Use automatic speaker counting or enter a number from 1 to 20."), 400
    num_speakers = int(count) if count else None
    if detect_speakers and (not diarization.installed() or not diarization.ready()):
        return jsonify(error="Complete speaker setup first, or turn off Detect speakers."), 409
    if model_name not in MODELS:
        return jsonify(error="Choose a supported Whisper model."), 400
    if language and not engine.valid_language(language):
        return jsonify(error="Choose a supported language."), 400
    with state_lock:
        if diarization.status()["state"] == "downloading":
            return jsonify(error="Wait for the speaker model download to finish."), 409
        if any(
            j["state"] in {"uploading", "loading", "transcribing", "diarizing"}
            for j in jobs.values()
        ):
            return jsonify(error="A transcription is already running. Wait for it to finish."), 409
        job_id = secrets.token_urlsafe(16)
        # Results live only in memory and expire after an hour. Keep at most ten.
        for key in list(jobs):
            if time.time() - jobs[key]["created"] > 3600:
                del jobs[key]
        while len(jobs) >= 10:
            del jobs[next(iter(jobs))]
        jobs[job_id] = {
            "state": "uploading",
            "message": "Reading your file.",
            "created": time.time(),
        }
    folder = None
    try:
        folder = tempfile.mkdtemp(prefix="whisper-local-")
        path = str(Path(folder) / ("audio" + extension))
        audio.save(path)
        size = Path(path).stat().st_size
        if size == 0 or size > MAX_BYTES:
            raise ValueError("Choose a nonempty audio file smaller than 500 MB.")
        update_job(job_id, state="loading", message="Preparing Whisper.")
        threading.Thread(
            target=transcribe,
            args=(
                job_id,
                folder,
                path,
                model_name,
                language,
                detect_speakers,
                num_speakers,
                processing,
            ),
            daemon=True,
        ).start()
    except Exception as exc:
        if folder is not None:
            shutil.rmtree(folder, ignore_errors=True)
        update_job(job_id, state="error", message=str(exc))
        return jsonify(error=str(exc)), 400
    return jsonify(job_id=job_id), 202


@app.get("/api/jobs/<job_id>")
def job_status(job_id):
    with state_lock:
        job = jobs.get(job_id)
        if job is None:
            return jsonify(error="This transcript expired. Transcribe the file again."), 404
        return jsonify(dict(job))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Transcribe audio locally in your browser.")
    parser.add_argument("--port", type=int, default=8765, help="Loopback port (default: 8765)")
    parser.add_argument(
        "--no-browser", action="store_true", help="Do not open the browser on launch"
    )
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    from waitress import create_server

    # Bind before opening the browser, so an occupied port never opens another app.
    try:
        server = create_server(
            app,
            host="127.0.0.1",
            port=args.port,
            threads=4,
            max_request_body_size=MAX_BYTES + 1024 * 1024,
        )
    except OSError as exc:
        parser.exit(
            1,
            f"Could not bind 127.0.0.1:{args.port}. Close the other instance or use --port. {exc}\n",
        )
    url = f"http://127.0.0.1:{args.port}"
    print(f"Whisper Local: {url}\nKeep this window open. Press Ctrl+C to close the app.")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    finally:
        server.close()


if __name__ == "__main__":
    main()
