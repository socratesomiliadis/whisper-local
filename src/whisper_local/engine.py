"""Faster Whisper with automatic CUDA selection and an INT8 CPU fallback."""

from __future__ import annotations

import gc
import os
from functools import lru_cache
from pathlib import Path

from .settings import MODELS_DIR

os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
THREADS = min(8, max(1, (os.cpu_count() or 2) // 2))
model = None
model_key = None
gpu_disabled_reason = None
_dll_handles = []


@lru_cache(maxsize=1)
def configure_libraries():
    import torch

    torch.set_num_threads(THREADS)
    # CUDA-enabled PyTorch supplies cuBLAS and cuDNN on Windows. Make its DLLs
    # discoverable by CTranslate2 without installing a system CUDA toolkit.
    if os.name == "nt":
        directory = str(Path(torch.__file__).parent / "lib")
        os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")
        _dll_handles.append(os.add_dll_directory(directory))
    return torch


def capabilities() -> dict:
    try:
        torch = configure_libraries()
        import ctranslate2

        available = torch.cuda.is_available() and ctranslate2.get_cuda_device_count() > 0
        name = torch.cuda.get_device_name(0) if available else None
        return {
            "gpu_available": bool(available and not gpu_disabled_reason),
            "gpu_name": name,
            "device": "cuda" if available and not gpu_disabled_reason else "cpu",
        }
    except (ImportError, OSError, RuntimeError):
        return {"gpu_available": False, "gpu_name": None, "device": "cpu"}


def is_gpu_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return any(
        word in message
        for word in ("cuda", "cublas", "cudnn", "gpu", "driver", "out of memory", "dll")
    )


def unload():
    global model, model_key
    if model is not None:
        try:
            model.model.unload_model()
        except RuntimeError as exc:
            if not is_gpu_error(exc):
                raise
    model = model_key = None
    gc.collect()


def load(name: str, device: str, progress=None):
    global model, model_key
    if model_key != (name, device):
        unload()
        configure_libraries()
        from faster_whisper import WhisperModel
        from huggingface_hub import snapshot_download

        directory = MODELS_DIR / "faster-whisper" / name
        if progress:
            progress(
                "loading", "Preparing Whisper. A missing model downloads once, then works offline."
            )
        # Download the complete runtime model once. A marker avoids Hub metadata
        # requests on subsequent launches; model construction uses a local path.
        marker = directory / ".ready"
        if not marker.exists() or not (directory / "model.bin").is_file():
            snapshot_download(
                f"Systran/faster-whisper-{name}",
                local_dir=str(directory),
                token=False,
                allow_patterns=[
                    "config.json",
                    "preprocessor_config.json",
                    "model.bin",
                    "tokenizer.json",
                    "vocabulary.*",
                ],
            )
            marker.write_text(name + "\n", encoding="utf-8")
        worker = WhisperModel(
            str(directory),
            device=device,
            compute_type="float16" if device == "cuda" else "int8",
            cpu_threads=THREADS,
            num_workers=1,
            local_files_only=True,
        )
        model, model_key = worker, (name, device)
    return model


def decode(path: str):
    from faster_whisper.audio import decode_audio

    try:
        return decode_audio(path, sampling_rate=16000)
    except Exception as exc:
        raise ValueError(
            "This file could not be decoded. Try a valid MP3, WAV, or M4A recording."
        ) from exc


def valid_language(language: str) -> bool:
    from faster_whisper.tokenizer import _LANGUAGE_CODES

    return language in _LANGUAGE_CODES


def _run(audio, name, language, word_timestamps, device, progress):
    worker = load(name, device, progress)
    if progress:
        progress("transcribing", f"Transcribing on your {'GPU' if device == 'cuda' else 'CPU'}…")
    predicted, info = worker.transcribe(
        audio,
        language=language or None,
        task="transcribe",
        beam_size=1,
        word_timestamps=word_timestamps,
        vad_filter=True,
    )
    segments = []
    for segment in predicted:
        if not segment.text.strip():
            continue
        row = {"start": float(segment.start), "end": float(segment.end), "text": segment.text}
        if word_timestamps:
            row["words"] = [
                {"start": float(word.start), "end": float(word.end), "word": word.word}
                for word in segment.words or []
            ]
        segments.append(row)
        if progress:
            progress(
                "transcribing",
                f"Transcribing on your {'GPU' if device == 'cuda' else 'CPU'}… {int(segment.end)} seconds processed.",
            )
    return {
        "text": "".join(s["text"] for s in segments).strip(),
        "language": info.language,
        "segments": segments,
        "device": device,
        "gpu_fallback": False,
    }


def transcribe(
    audio, name="base", language="", word_timestamps=False, processing="auto", progress=None
):
    global gpu_disabled_reason
    device = "cuda" if processing == "auto" and capabilities()["gpu_available"] else "cpu"
    try:
        return _run(audio, name, language, word_timestamps, device, progress)
    except Exception as exc:
        if device != "cuda" or not is_gpu_error(exc):
            raise
        gpu_disabled_reason = str(exc)[:200]
        unload()
        if progress:
            progress("loading", "GPU acceleration could not finish. Continuing on your CPU…")
    result = _run(audio, name, language, word_timestamps, "cpu", progress)
    result["gpu_fallback"] = True
    return result
