from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from whisper_local import engine


def test_gpu_failure_during_lazy_decode_retries_cpu(monkeypatch):
    devices = []

    class Worker:
        def __init__(self, device):
            self.device = device

        def transcribe(self, *args, **kwargs):
            def segments():
                if self.device == "cuda":
                    raise RuntimeError("CUDA out of memory during lazy decoding")
                yield SimpleNamespace(
                    start=0,
                    end=1,
                    text=" Hello.",
                    words=[SimpleNamespace(start=0, end=1, word=" Hello.")],
                )

            return segments(), SimpleNamespace(language="en")

    def load(name, device, progress):
        devices.append(device)
        return Worker(device)

    monkeypatch.setattr(engine, "capabilities", lambda: {"gpu_available": True})
    monkeypatch.setattr(engine, "load", load)
    unload = Mock()
    monkeypatch.setattr(engine, "unload", unload)
    result = engine.transcribe(object(), word_timestamps=True)
    assert devices == ["cuda", "cpu"]
    assert result["gpu_fallback"] and result["device"] == "cpu"
    assert result["segments"][0]["words"][0]["word"] == " Hello."
    assert engine.gpu_disabled_reason
    unload.assert_called_once()


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


@pytest.mark.parametrize("quality,beam", [("fast", 1), ("balanced", 3), ("accurate", 5)])
def test_quality_beams_and_structured_progress(monkeypatch, quality, beam):
    worker = Mock()
    worker.transcribe.return_value = (
        iter(
            [
                SimpleNamespace(start=0, end=1, text=" Hello.", words=[]),
                SimpleNamespace(start=1, end=4, text=" Done.", words=[]),
            ]
        ),
        SimpleNamespace(language="en"),
    )
    monkeypatch.setattr(engine, "load", lambda *args: worker)
    progress = Mock()
    result = engine.transcribe([0] * 64000, processing="cpu", quality=quality, progress=progress)
    assert worker.transcribe.call_args.kwargs["beam_size"] == beam
    assert result["text"] == "Hello. Done."
    updates = [call.kwargs for call in progress.call_args_list if "progress" in call.kwargs]
    assert [update["progress"] for update in updates] == [0.25, 1.0]
    assert updates[-1]["processed_seconds"] == 4


def test_invalid_quality_does_not_load_model(monkeypatch):
    load = Mock()
    monkeypatch.setattr(engine, "load", load)
    with pytest.raises(ValueError, match="quality"):
        engine.transcribe(object(), quality="bogus")
    load.assert_not_called()
