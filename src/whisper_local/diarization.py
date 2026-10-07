"""Local Community-1 setup and word-level speaker attribution."""

from __future__ import annotations

import importlib.util
import os
import re
import threading
import warnings

from . import engine
from .settings import MODELS_DIR

# Keep library telemetry off, including when using an already downloaded model.
os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"

MODEL_ID = "pyannote/speaker-diarization-community-1"
MODEL_DIR = MODELS_DIR / "speakers"
MARKER = MODEL_DIR / ".ready"
lock = threading.Lock()
setup_state = {"state": "idle", "message": "Speaker detection needs a one-time model download."}
pipeline = None
pipeline_device = "cpu"
gpu_failed = False


def installed() -> bool:
    try:
        return importlib.util.find_spec("pyannote.audio") is not None
    except (ModuleNotFoundError, ValueError):
        return False


def ready() -> bool:
    return MARKER.is_file() and (MODEL_DIR / "config.yaml").is_file()


def status() -> dict:
    with lock:
        return {**setup_state, "installed": installed(), "ready": ready()}


def safe_error(exc: Exception) -> str:
    return re.sub(r"hf_[A-Za-z0-9_-]+", "[token hidden]", str(exc))[:350]


def load_pipeline(device="cpu"):
    global pipeline, pipeline_device, gpu_failed
    if pipeline is None:
        # The app intentionally bypasses the library's optional file decoder.
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message=r"\s*torchcodec is not installed correctly.*",
                category=UserWarning,
                module=r"pyannote\.audio\.core\.io",
            )
            from pyannote.audio import Pipeline
        import torch

        # A directory checkpoint resolves all submodels locally; no Hub calls.
        loaded = Pipeline.from_pretrained(MODEL_DIR, token=False)
        if loaded is None:
            raise RuntimeError("The speaker model could not be loaded. Run speaker setup again.")
        pipeline = loaded.to(torch.device("cpu"))
        pipeline_device = "cpu"
    if device != pipeline_device:
        import torch

        try:
            pipeline.to(torch.device(device))
            pipeline_device = device
        except Exception as exc:
            if device != "cuda" or not engine.is_gpu_error(exc):
                raise
            gpu_failed = True
            pipeline.to(torch.device("cpu"))
            pipeline_device = "cpu"
    return pipeline


def download(token: str, engine_lock: threading.Lock):
    try:
        with engine_lock:
            from huggingface_hub import snapshot_download

            MODEL_DIR.mkdir(parents=True, exist_ok=True)
            snapshot_download(MODEL_ID, token=token, local_dir=MODEL_DIR)
            with lock:
                setup_state.update(
                    state="downloading", message="Checking the downloaded speaker model…"
                )
            load_pipeline()
            MARKER.write_text(MODEL_ID + "\n", encoding="utf-8")
        with lock:
            setup_state.update(
                state="complete",
                message="Speaker detection is ready. Future recordings work offline.",
            )
    except Exception as exc:
        # Never log request bodies or store the user's download token.
        with lock:
            setup_state.update(
                state="error",
                message="Could not prepare speaker detection. Accept the model terms and use a token with read access. "
                + safe_error(exc),
            )
    finally:
        token = ""


def detect(audio, num_speakers: int | None = None, progress=None, device="auto") -> list[dict]:
    global pipeline_device, gpu_failed
    import torch

    selected = (
        "cuda"
        if not gpu_failed and device != "cpu" and engine.capabilities()["gpu_available"]
        else "cpu"
    )
    worker = load_pipeline(selected)
    # Whisper already decoded to mono 16 kHz. Passing a tensor avoids the
    # TorchCodec/FFmpeg shared-DLL requirement on Windows.
    waveform = torch.from_numpy(audio.copy()).unsqueeze(0)
    options = {"num_speakers": num_speakers} if num_speakers else {}

    def hook(step_name, _artifact, file=None, total=None, completed=None):
        if progress:
            label = step_name.replace("_", " ")
            fraction = f" ({completed}/{total})" if total and completed is not None else ""
            progress(
                "Detecting speakers: " + label + fraction + ".",
                stage="diarizing",
                progress=min(1.0, completed / total) if total and completed is not None else None,
                step=label,
            )

    try:
        output = worker({"waveform": waveform, "sample_rate": 16000}, hook=hook, **options)
    except Exception as exc:
        if pipeline_device != "cuda" or not engine.is_gpu_error(exc):
            raise
        gpu_failed = True
        worker.to(torch.device("cpu"))
        pipeline_device = "cpu"
        if progress:
            progress("Continuing speaker detection on your CPU…")
        output = worker({"waveform": waveform, "sample_rate": 16000}, hook=hook, **options)
    annotation = output.exclusive_speaker_diarization
    return [
        {"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker)}
        for turn, _, speaker in annotation.itertracks(yield_label=True)
    ]


def speaker_at(start: float, end: float, turns: list[dict]) -> str:
    overlaps: dict[str, float] = {}
    for turn in turns:
        overlap = max(0.0, min(end, turn["end"]) - max(start, turn["start"]))
        if overlap:
            overlaps[turn["speaker"]] = overlaps.get(turn["speaker"], 0.0) + overlap
    if overlaps:
        return max(overlaps, key=overlaps.get)
    # Slight timestamp drift is common; distant or silent words stay unassigned.
    if turns:
        closest = min(turns, key=lambda t: max(t["start"] - end, start - t["end"], 0.0))
        if max(closest["start"] - end, start - closest["end"], 0.0) <= 0.5:
            return closest["speaker"]
    return "unknown"


def assign_speakers(segments: list[dict], turns: list[dict]) -> tuple[list[dict], dict[str, str]]:
    """Assign each Whisper word, splitting a segment at speaker changes."""
    turns = sorted(turns, key=lambda t: t["start"])
    rows = []
    names: dict[str, str] = {}
    for segment in segments:
        words = segment.get("words") or [
            {"start": segment["start"], "end": segment["end"], "word": " " + segment["text"]}
        ]
        for word in words:
            text = word["word"]
            if not text.strip():
                continue
            start, end = float(word["start"]), float(word["end"])
            speaker = speaker_at(start, end, turns)
            if speaker not in names:
                names[speaker] = (
                    "Unassigned"
                    if speaker == "unknown"
                    else f"Speaker {1 + sum(key != 'unknown' for key in names)}"
                )
            if rows and rows[-1]["speaker"] == speaker and start - rows[-1]["end"] <= 1.5:
                # Whisper words retain their original leading whitespace.
                rows[-1]["text"] += text
                rows[-1]["end"] = max(rows[-1]["end"], end)
            else:
                rows.append({"start": start, "end": end, "text": text, "speaker": speaker})
    for row in rows:
        row["text"] = row["text"].strip()
    return rows, names
