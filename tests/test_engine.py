from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from whisper_local import engine


@pytest.fixture
def worker(monkeypatch):
    worker = Mock()
    worker.transcribe.return_value = {
        "language": "en",
        "segments": [{"start": 0, "end": 4, "text": " Hello. Done."}],
    }
    monkeypatch.setattr(engine, "load", Mock(return_value=worker))
    monkeypatch.setattr(engine, "unload", Mock())
    monkeypatch.setattr(
        engine,
        "align_segments",
        lambda segments, *args: engine.normalize_segments(
            [
                {
                    **s,
                    "words": [
                        {"word": "Hello.", "start": 0, "end": 1},
                        {"word": "Done.", "start": 1, "end": 4},
                    ],
                }
                for s in segments
            ],
            "en",
            4,
        ),
    )
    return worker


def test_gpu_failure_retries_cpu(monkeypatch, worker):
    monkeypatch.setattr(engine, "capabilities", lambda: {"gpu_available": True})
    worker.transcribe.side_effect = [
        RuntimeError("CUDA out of memory"),
        worker.transcribe.return_value,
    ]
    result = engine.transcribe([0] * 64000)
    assert [c.args[1] for c in engine.load.call_args_list] == ["cuda", "cpu"]
    assert result["gpu_fallback"] and result["device"] == "cpu"
    assert result["segments"][0]["words"][0]["word"] == " Hello."
    assert engine.gpu_disabled_reason


def test_cpu_mode_does_not_probe_gpu(monkeypatch):
    monkeypatch.setattr(engine, "capabilities", Mock(side_effect=AssertionError("GPU probed")))
    run = Mock(return_value={"device": "cpu"})
    monkeypatch.setattr(engine, "_run", run)
    assert engine.transcribe(object(), processing="cpu")["device"] == "cpu"
    assert run.call_args.args[4] == "cpu"


def test_download_errors_do_not_retry(monkeypatch):
    monkeypatch.setattr(engine, "capabilities", lambda: {"gpu_available": True})
    run = Mock(side_effect=RuntimeError("Model download failed"))
    monkeypatch.setattr(engine, "_run", run)
    with pytest.raises(RuntimeError, match="download failed"):
        engine.transcribe(object())
    run.assert_called_once()


def test_unavailable_libraries_report_cpu(monkeypatch):
    monkeypatch.setattr(engine, "configure_libraries", Mock(side_effect=ImportError("missing")))
    assert engine.capabilities() == {"gpu_available": False, "gpu_name": None, "device": "cpu"}


@pytest.mark.parametrize("quality", ["fast", "balanced", "accurate"])
def test_quality_and_structured_progress(monkeypatch, worker, quality):
    def predict(*args, **kwargs):
        kwargs["progress_callback"](25)
        kwargs["progress_callback"](100)
        return worker.transcribe.return_value

    worker.transcribe.side_effect = predict
    progress = Mock()
    result = engine.transcribe([0] * 64000, processing="cpu", quality=quality, progress=progress)
    assert engine.load.call_args.kwargs["quality"] == quality
    assert worker.transcribe.call_args.kwargs["batch_size"] == 2
    assert result["text"] == "Hello. Done."
    assert result["engine"] == "whisperx" and result["aligned"]
    updates = [c.kwargs for c in progress.call_args_list if "progress" in c.kwargs]
    assert [u["progress"] for u in updates] == [0, 0.25, 1.0]
    assert updates[-1]["processed_seconds"] == 4


def test_invalid_quality_does_not_load_model(monkeypatch):
    load = Mock()
    monkeypatch.setattr(engine, "load", load)
    with pytest.raises(ValueError, match="quality"):
        engine.transcribe(object(), quality="bogus")
    load.assert_not_called()


def test_alignment_failure_keeps_transcript(monkeypatch, worker):
    monkeypatch.setattr(
        engine, "align_segments", Mock(side_effect=ValueError("No model for language"))
    )
    result = engine.transcribe([0] * 64000, processing="cpu")
    assert result["text"] == "Hello. Done."
    assert not result["aligned"] and "word alignment" in result["warning"]
    assert "words" not in result["segments"][0]


def test_alignment_gpu_failure_retries_only_alignment(monkeypatch, worker):
    monkeypatch.setattr(engine, "configure_libraries", Mock())
    monkeypatch.setattr(engine, "capabilities", lambda: {"gpu_available": True})
    rows = engine.normalize_segments(
        [
            {
                "start": 0,
                "end": 4,
                "text": "Hello.",
                "words": [{"word": "Hello.", "start": 0, "end": 4}],
            }
        ],
        "en",
        4,
    )
    align = Mock(side_effect=[RuntimeError("CUDA out of memory"), rows])
    monkeypatch.setattr(engine, "align_segments", align)
    result = engine.transcribe([0] * 64000)
    assert [c.args[3] for c in align.call_args_list] == ["cuda", "cpu"]
    worker.transcribe.assert_called_once()
    assert worker.transcribe.call_args.kwargs["batch_size"] == 8
    assert result["aligned"] and result["gpu_fallback"] and result["device"] == "cpu"


def test_silence_skips_alignment(monkeypatch, worker):
    worker.transcribe.return_value["segments"] = []
    align = Mock(side_effect=AssertionError("Alignment on silence"))
    monkeypatch.setattr(engine, "align_segments", align)
    result = engine.transcribe([0] * 64000, processing="cpu")
    assert result["segments"] == [] and result["text"] == ""
    assert result["warning"] is None


def test_missing_word_times_are_retained_and_marked():
    rows = engine.normalize_segments(
        [
            {
                "start": 0,
                "end": 3,
                "text": "Pay 20 pounds.",
                "words": [
                    {"word": "Pay", "start": 0, "end": 1},
                    {"word": "20"},
                    {"word": "pounds.", "start": 2, "end": 3},
                ],
            }
        ],
        "en",
        3,
    )
    words = rows[0]["words"]
    assert "".join(w["word"] for w in words).strip() == "Pay 20 pounds."
    assert words[1] == {"word": " 20", "start": 1, "end": 2, "aligned": False}
    assert words[0]["aligned"] and words[2]["aligned"]


def test_language_without_spaces():
    rows = engine.normalize_segments(
        [
            {
                "start": 0,
                "end": 2,
                "text": "你好",
                "words": [
                    {"word": "你", "start": 0, "end": 1},
                    {"word": "好", "start": 1, "end": 2},
                ],
            }
        ],
        "zh",
        2,
    )
    assert "".join(w["word"] for w in rows[0]["words"]) == "你好"


@pytest.mark.parametrize("quality,beam", [("fast", 1), ("balanced", 3), ("accurate", 5)])
def test_cached_load_is_local_and_configures_beams(monkeypatch, tmp_path, quality, beam):
    directory = tmp_path / "faster-whisper" / "tiny"
    directory.mkdir(parents=True)
    (directory / ".ready").touch()
    (directory / "model.bin").touch()
    monkeypatch.setattr(engine, "MODELS_DIR", tmp_path)
    monkeypatch.setattr(engine, "model", None)
    monkeypatch.setattr(engine, "model_key", None)
    monkeypatch.setattr(engine, "configure_libraries", Mock())
    monkeypatch.setattr(engine, "bundled_vad", Mock())
    # The cached path needs no Hub library or network calls.
    import sys

    monkeypatch.setitem(
        sys.modules,
        "huggingface_hub",
        SimpleNamespace(snapshot_download=Mock(side_effect=AssertionError("Network"))),
    )
    wx = Mock()
    monkeypatch.setattr(engine, "whisperx_module", lambda: wx)
    first = engine.load("tiny", "cpu", quality=quality, language="en")
    assert engine.load("tiny", "cpu", quality=quality, language="en") is first
    wx.load_model.assert_called_once()
    assert wx.load_model.call_args.kwargs["asr_options"]["beam_size"] == beam
    assert wx.load_model.call_args.kwargs["local_files_only"]
    assert wx.load_model.call_args.kwargs["use_auth_token"] is False
    engine.load("tiny", "cpu", quality=quality, language="el")
    assert wx.load_model.call_count == 2


@pytest.mark.parametrize("cached", [True, False])
def test_alignment_cache_and_sentence_resources(monkeypatch, tmp_path, cached):
    import sys

    directory = tmp_path / "alignment" / "en"
    directory.mkdir(parents=True)
    if cached:
        (directory / ".ready").touch()
    monkeypatch.setattr(engine, "MODELS_DIR", tmp_path)
    nltk = SimpleNamespace(data=SimpleNamespace(path=[], find=Mock()), download=Mock())
    monkeypatch.setitem(sys.modules, "nltk", nltk)
    monkeypatch.setitem(
        sys.modules,
        "whisperx.alignment",
        SimpleNamespace(
            DEFAULT_ALIGN_MODELS_HF={},
            DEFAULT_ALIGN_MODELS_TORCH={"en": "model"},
            PUNKT_LANGUAGES={"en": "english"},
        ),
    )
    wx = Mock()
    wx.load_align_model.return_value = (object(), {})
    monkeypatch.setattr(engine, "whisperx_module", lambda: wx)
    engine.alignment_resources("en", "cpu", None)
    assert wx.load_align_model.call_args.kwargs["model_cache_only"] is cached
    assert wx.load_align_model.call_args.kwargs["model_dir"] == str(directory)
    assert (directory / ".ready").exists()
    nltk.download.assert_not_called()
    with pytest.raises(ValueError, match="No default alignment"):
        engine.alignment_resources("xx", "cpu", None)


def test_alignment_losing_text_preserves_original(monkeypatch, worker):
    monkeypatch.setattr(engine, "alignment_resources", lambda *args: (object(), {}))
    wx = Mock()
    wx.align.return_value = {"segments": []}
    monkeypatch.setattr(engine, "whisperx_module", lambda: wx)
    monkeypatch.setattr(engine, "configure_libraries", Mock())
    # Restore the actual alignment function replaced by the worker fixture.
    monkeypatch.setattr(engine, "align_segments", REAL_ALIGN)
    result = engine.transcribe([0] * 64000, processing="cpu")
    assert result["text"] == "Hello. Done."
    assert result["segments"] and result["warning"] and not result["aligned"]


REAL_ALIGN = engine.align_segments
