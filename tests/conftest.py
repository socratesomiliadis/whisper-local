import importlib
import io

import pytest

from whisper_local import diarization, engine

api = importlib.import_module("whisper_local.app")


@pytest.fixture(autouse=True)
def isolate_state(monkeypatch):
    monkeypatch.setattr(api, "jobs", {})
    monkeypatch.setattr(api, "workers", {})
    monkeypatch.setattr(api, "upload_folders", {})
    monkeypatch.setattr(diarization, "setup_state", {"state": "idle", "message": "Setup required."})
    monkeypatch.setattr(diarization, "ready", lambda: False)
    monkeypatch.setattr(diarization, "installed", lambda: True)
    monkeypatch.setattr(engine, "gpu_disabled_reason", None)
    monkeypatch.setattr(engine, "valid_language", lambda language: language in {"en", "el", "fr"})


@pytest.fixture
def client():
    api.app.config.update(TESTING=True)
    with api.app.test_client() as client:
        yield client


@pytest.fixture
def headers():
    return {"X-App-Token": api.TOKEN}


@pytest.fixture
def upload(client, headers):
    def send(**fields):
        filename = fields.pop("filename", "clip.wav")
        contents = fields.pop("contents", b"audio fixture")
        return client.post(
            "/api/transcribe",
            headers=headers,
            data={"audio": (io.BytesIO(contents), filename), **fields},
        )

    return send
