import os
from pathlib import Path

import pytest

from whisper_local import engine


@pytest.mark.integration
def test_real_cached_base_model():
    path = os.environ.get("WHISPER_TEST_AUDIO")
    if not path or not Path(path).is_file():
        pytest.skip("Set WHISPER_TEST_AUDIO to a local speech recording")
    directory = engine.MODELS_DIR / "faster-whisper" / "base"
    if not (directory / ".ready").is_file() or not (directory / "model.bin").is_file():
        pytest.skip("Download Base through the app before running this test")
    if not (engine.MODELS_DIR / "alignment" / "en" / ".ready").is_file():
        pytest.skip("Run English alignment through the app before running this test")
    result = engine.transcribe(
        engine.decode(path), name="base", language="en", word_timestamps=True
    )
    assert result["text"].strip()
    assert result["segments"] and result["segments"][0]["words"]
    assert result["device"] in {"cpu", "cuda"}
    assert result["engine"] == "whisperx" and result["aligned"]
