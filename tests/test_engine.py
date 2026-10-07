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
