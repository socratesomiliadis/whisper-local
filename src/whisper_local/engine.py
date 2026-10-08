"""WhisperX batched transcription and cached, language-specific alignment."""

from __future__ import annotations

import gc
import math
import os
import warnings
from functools import lru_cache
from pathlib import Path

from .settings import MODELS_DIR

os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
THREADS = min(8, max(1, (os.cpu_count() or 2) // 2))
QUALITY_BEAMS = {"fast": 1, "balanced": 3, "accurate": 5}
model = None
model_key = None
model_parked = False
alignment = None
alignment_language = None
gpu_disabled_reason = None
_dll_handles = []


@lru_cache(maxsize=1)
def configure_libraries():
    import torch

    torch.set_num_threads(THREADS)
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
    return any(
        word in str(exc).lower()
        for word in ("cuda", "cublas", "cudnn", "gpu", "driver", "out of memory", "dll")
    )


def unload():
    global model, model_key, model_parked
    if model is not None:
        try:
            model.model.model.unload_model()
        except RuntimeError as exc:
            if not is_gpu_error(exc):
                raise
    model = model_key = None
    model_parked = False
    gc.collect()


def park_model():
    """Release ASR VRAM, retaining the CTranslate2 weights in CPU memory."""
    global model_parked
    if model is not None and model_key[1] == "cuda" and not model_parked:
        model.model.model.unload_model(to_cpu=True)
        model_parked = True


def whisperx_module():
    # Audio is decoded with PyAV and supplied as arrays/tensors. The optional
    # torchcodec file-decoding warning does not apply to this pipeline.
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message=r"\s*torchcodec is not installed correctly.*",
            category=UserWarning,
            module=r"pyannote\.audio\.core\.io",
        )
        import whisperx
        import whisperx.asr  # Load lazy imports inside the warning scope.
    return whisperx


def bundled_vad():
    from silero_vad import get_speech_timestamps, load_silero_vad
    from whisperx.vads.silero import Silero

    class BundledSilero(Silero):
        def __init__(self):
            # Use installed model assets rather than Silero's torch.hub loader.
            self.vad_onset = 0.5
            self.chunk_size = 30
            self.vad_pipeline = load_silero_vad()
            self.get_speech_timestamps = get_speech_timestamps

    return BundledSilero()


def load(name: str, device: str, progress=None, quality="balanced", language=""):
    global model, model_key, model_parked
    key = (name, device, quality, language)
    if model_key != key:
        unload()
        configure_libraries()
        from huggingface_hub import snapshot_download

        directory = MODELS_DIR / "faster-whisper" / name
        marker = directory / ".ready"
        if not marker.exists() or not (directory / "model.bin").is_file():
            if progress:
                progress(
                    "loading",
                    "Downloading Whisper model. This only happens once…",
                    stage="downloading",
                    progress=None,
                )
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
        if progress:
            progress("loading", "Loading WhisperX into memory…", stage="loading", progress=None)
        worker = whisperx_module().load_model(
            str(directory),
            device=device,
            compute_type="float16" if device == "cuda" else "int8",
            threads=THREADS,
            local_files_only=True,
            language=language or None,
            asr_options={"beam_size": QUALITY_BEAMS[quality]},
            vad_method="silero",
            vad_model=bundled_vad(),
            use_auth_token=False,
        )
        model, model_key = worker, key
    elif model_parked:
        model.model.model.load_model()
        model_parked = False
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


def alignment_resources(language, device, progress):
    global alignment, alignment_language
    if alignment is not None and alignment_language == language:
        alignment[0].to(device)
        return alignment

    import nltk
    from whisperx.alignment import (
        DEFAULT_ALIGN_MODELS_HF,
        DEFAULT_ALIGN_MODELS_TORCH,
        PUNKT_LANGUAGES,
    )

    if language not in DEFAULT_ALIGN_MODELS_HF and language not in DEFAULT_ALIGN_MODELS_TORCH:
        raise ValueError("No default alignment model for this language.")
    # Bound memory to the most recently used language, rather than accumulating
    # an alignment model for every language processed during this launch.
    alignment = alignment_language = None
    gc.collect()
    nltk_dir = MODELS_DIR / "alignment" / "nltk"
    nltk_dir.mkdir(parents=True, exist_ok=True)
    if str(nltk_dir) not in nltk.data.path:
        nltk.data.path.insert(0, str(nltk_dir))
    punkt = PUNKT_LANGUAGES.get(language, "english")
    try:
        nltk.data.find(f"tokenizers/punkt_tab/{punkt}/")
    except LookupError:
        if progress:
            progress(
                "transcribing",
                "Downloading sentence alignment resources once…",
                stage="downloading",
                progress=None,
            )
        if not nltk.download(
            "punkt_tab", download_dir=str(nltk_dir), quiet=True, raise_on_error=True
        ):
            raise RuntimeError("Sentence alignment resources could not download.")
    directory = MODELS_DIR / "alignment" / language
    directory.mkdir(parents=True, exist_ok=True)
    marker = directory / ".ready"
    if progress:
        progress(
            "transcribing",
            "Loading alignment model…"
            if marker.exists()
            else "Downloading alignment model for this language once…",
            stage="aligning" if marker.exists() else "downloading",
            progress=None,
        )
    resources = whisperx_module().load_align_model(
        language_code=language,
        device=device,
        model_dir=str(directory),
        model_cache_only=marker.exists(),
    )
    marker.write_text(language + "\n", encoding="utf-8")
    alignment, alignment_language = resources, language
    return resources


def normalize_segments(segments, language, duration):
    rows = []
    for segment in segments:
        text = segment["text"].strip()
        if not text:
            continue
        raw_start, raw_end = float(segment["start"]), float(segment["end"])
        if not math.isfinite(raw_start) or not math.isfinite(raw_end):
            raise ValueError("Alignment returned invalid segment timestamps.")
        start = max(0.0, min(duration, raw_start))
        end = max(start, min(duration, raw_end))
        row = {"start": start, "end": end, "text": text}
        words = segment.get("words", [])
        if words:
            row["words"] = []
            for i, word in enumerate(words):
                timed = all(
                    isinstance(word.get(k), (int, float)) and math.isfinite(word[k])
                    for k in ("start", "end")
                )
                word_start = (
                    float(word["start"]) if timed else start + (end - start) * i / len(words)
                )
                word_end = (
                    float(word["end"]) if timed else start + (end - start) * (i + 1) / len(words)
                )
                word_start = max(start, min(end, word_start))
                word_end = max(word_start, min(end, word_end))
                token = str(word["word"]).strip()
                # Speaker attribution joins tokens; retain language-appropriate separators.
                row["words"].append(
                    {
                        "start": word_start,
                        "end": word_end,
                        "word": token if language in {"ja", "zh"} else " " + token,
                        "aligned": timed and word.get("aligned", True),
                    }
                )
        rows.append(row)
    return rows


def align_segments(segments, audio, language, device, progress):
    alignment_model = None
    try:
        alignment_model, metadata = alignment_resources(language, device, progress)
        if progress:
            progress("transcribing", "Aligning word timestamps…", stage="aligning", progress=0.0)

        def report(percent):
            if progress:
                progress(
                    "transcribing",
                    "Aligning word timestamps…",
                    stage="aligning",
                    progress=max(0.0, min(1.0, percent / 100)),
                )

        result = whisperx_module().align(
            segments,
            alignment_model,
            metadata,
            audio,
            device,
            return_char_alignments=False,
            progress_callback=report,
        )
        original_text = "".join(s["text"] for s in segments)
        aligned_text = "".join(s["text"] for s in result["segments"])
        if "".join(original_text.split()) != "".join(aligned_text.split()):
            raise RuntimeError("Alignment did not preserve the complete transcript.")
        for segment in result["segments"]:
            for word in segment.get("words", []):
                # WhisperX can interpolate missing times; those words have no score.
                score = word.get("score")
                word["aligned"] = isinstance(score, (int, float)) and math.isfinite(score)
        return normalize_segments(result["segments"], language, len(audio) / 16000)
    finally:
        if device == "cuda":
            if alignment_model is not None:
                alignment_model.to("cpu")
            # Free temporary CUDA buffers, keeping cached weights in RAM.
            torch = configure_libraries()
            torch.cuda.empty_cache()


def _run(audio, name, language, word_timestamps, device, progress, quality="balanced"):
    global gpu_disabled_reason
    worker = load(name, device, progress, quality=quality, language=language)
    duration = len(audio) / 16000

    def report(percent):
        if progress:
            fraction = max(0.0, min(1.0, percent / 100))
            progress(
                "transcribing",
                f"Transcribing on your {'GPU' if device == 'cuda' else 'CPU'}…",
                stage="transcribing",
                progress=fraction,
                processed_seconds=fraction * duration,
            )

    report(0)
    predicted = worker.transcribe(
        audio,
        language=language or None,
        task="transcribe",
        batch_size=8 if device == "cuda" else 2,
        progress_callback=report,
    )
    # ASR and alignment share VRAM without re-reading ASR weights from disk.
    del worker
    park_model()
    language = predicted["language"]
    segments = normalize_segments(predicted["segments"], language, duration)
    warning = None
    fallback = False
    aligned = False
    if segments:
        try:
            try:
                segments = align_segments(segments, audio, language, device, progress)
            except Exception as exc:
                if device != "cuda" or not is_gpu_error(exc):
                    raise
                gpu_disabled_reason = "GPU word alignment failed; using CPU."
                device, fallback = "cpu", True
                if progress:
                    progress(
                        "transcribing",
                        "Continuing word alignment on your CPU…",
                        stage="aligning",
                        progress=None,
                    )
            if fallback:
                # Leave the exception scope before retrying: its traceback can
                # otherwise retain the failed GPU model and its allocations.
                gc.collect()
                configure_libraries().cuda.empty_cache()
                segments = align_segments(segments, audio, language, device, progress)
            aligned = any(w["aligned"] for s in segments for w in s.get("words", []))
            if not aligned:
                warning = "Word alignment returned no reliable word times. Review the transcript timestamps."
            elif any(not w["aligned"] for s in segments for w in s.get("words", [])):
                warning = "Some word timestamps were estimated. Review them against the recording."
        except Exception:
            warning = "The transcript is ready, but word alignment could not finish for this language or recording. Original segment timestamps were retained. Check your connection if its alignment model has not downloaded yet."
    return {
        "text": ("" if language in {"ja", "zh"} else " ").join(s["text"] for s in segments).strip(),
        "language": language,
        "segments": segments,
        "device": device,
        "gpu_fallback": fallback,
        "engine": "whisperx",
        "aligned": aligned,
        "warning": warning,
    }


def transcribe(
    audio,
    name="base",
    language="",
    word_timestamps=False,
    processing="auto",
    progress=None,
    quality="balanced",
):
    global gpu_disabled_reason
    if quality not in QUALITY_BEAMS:
        raise ValueError("Choose fast, balanced, or accurate quality.")
    device = "cuda" if processing == "auto" and capabilities()["gpu_available"] else "cpu"
    try:
        return _run(audio, name, language, word_timestamps, device, progress, quality)
    except Exception as exc:
        if device != "cuda" or not is_gpu_error(exc):
            raise
        gpu_disabled_reason = "GPU transcription failed; using CPU."
        unload()
        if progress:
            progress("loading", "GPU acceleration could not finish. Continuing on your CPU…")
    result = _run(audio, name, language, word_timestamps, "cpu", progress, quality)
    result["gpu_fallback"] = True
    return result
