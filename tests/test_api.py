import importlib
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from whisper_local import diarization, engine

api = importlib.import_module("whisper_local.app")


def test_host_and_api_token(client, headers):
    assert client.get("/api/status").status_code == 403
    assert client.get("/api/status", headers={"X-App-Token": "invalid☃"}).status_code == 403
    assert client.get("/", base_url="http://evil.example").status_code == 403
    assert client.get("/api/jobs/missing", headers=headers).status_code == 404
    page = client.get("/")
    assert page.status_code == 200
    assert api.TOKEN.encode() in page.data
    assert "frame-ancestors 'none'" in page.headers["Content-Security-Policy"]
    assert page.headers["Cache-Control"] == "no-store"
    assert client.get("/static/app.js").status_code == 200


@pytest.mark.parametrize(
    "fields",
    [
        {"filename": "bad.exe"},
        {"model": "invalid"},
        {"processing": "invalid"},
        {"language": "unsupported"},
        {"num_speakers": "0"},
        {"num_speakers": "21"},
        {"num_speakers": "1.5"},
        {"num_speakers": "-2"},
        {"num_speakers": "٢"},
        {"num_speakers": "9" * 5000},
    ],
)
def test_bad_upload_fields(upload, fields):
    assert upload(**fields).status_code == 400
    assert not api.jobs


def test_upload_required(client, headers):
    assert client.post("/api/transcribe", headers=headers).status_code == 400


def test_oversized_request_is_rejected(upload, monkeypatch):
    monkeypatch.setitem(api.app.config, "MAX_CONTENT_LENGTH", 1024)
    assert upload(contents=b"x" * 2048).status_code == 413


def test_empty_upload_cleans_up(upload, monkeypatch, tmp_path):
    folder = tmp_path / "upload"
    folder.mkdir()
    monkeypatch.setattr(api.tempfile, "mkdtemp", lambda **kwargs: str(folder))
    assert upload(contents=b"").status_code == 400
    assert not folder.exists()
    assert next(iter(api.jobs.values()))["state"] == "error"


def test_temp_directory_failure_releases_job(upload, monkeypatch):
    def fail(**kwargs):
        raise OSError("temporary directory unavailable")

    monkeypatch.setattr(api.tempfile, "mkdtemp", fail)
    assert upload().status_code == 400
    assert next(iter(api.jobs.values()))["state"] == "error"


def test_upload_reserves_worker_and_rejects_concurrent_job(upload, monkeypatch, tmp_path):
    thread = Mock()
    monkeypatch.setattr(api.threading, "Thread", thread)
    folder = tmp_path / "upload"
    folder.mkdir()
    monkeypatch.setattr(api.tempfile, "mkdtemp", lambda **kwargs: str(folder))
    response = upload(language="en", processing="cpu")
    assert response.status_code == 202
    thread.return_value.start.assert_called_once()
    assert Path(thread.call_args.kwargs["args"][2]).is_file()
    assert thread.call_args.kwargs["args"][-1] == "cpu"
    assert upload().status_code == 409


def test_speaker_setup_required(upload):
    assert upload(detect_speakers="true").status_code == 409


@pytest.mark.parametrize("data", [{}, {"token": "bad"}, {"token": None}, [], {"token": 123}])
def test_setup_validates_token(client, headers, data):
    assert client.post("/api/speakers/setup", headers=headers, json=data).status_code == 400


def test_setup_does_not_expose_token(client, headers, monkeypatch):
    thread = Mock()
    monkeypatch.setattr(api.threading, "Thread", thread)
    token = "hf_TEST_ONLY"
    assert (
        client.post("/api/speakers/setup", headers=headers, json={"token": token}).status_code
        == 202
    )
    thread.return_value.start.assert_called_once()
    status = client.get("/api/speakers/status", headers=headers)
    assert token not in json.dumps(status.json)
    assert (
        client.post("/api/speakers/setup", headers=headers, json={"token": token}).status_code
        == 409
    )


def test_transcription_retains_text_when_speakers_fail(monkeypatch, tmp_path):
    folder = tmp_path / "upload"
    folder.mkdir()
    api.jobs["test"] = {"state": "loading"}
    monkeypatch.setattr(engine, "decode", lambda path: object())
    monkeypatch.setattr(
        engine,
        "transcribe",
        lambda *args, **kwargs: {
            "text": "Hello.",
            "language": "en",
            "segments": [{"start": 0, "end": 1, "text": "Hello."}],
            "device": "cpu",
            "gpu_fallback": False,
        },
    )
    monkeypatch.setattr(diarization, "detect", Mock(side_effect=RuntimeError("failed hf_SECRET")))
    api.transcribe("test", str(folder), "clip.wav", "base", "", True)
    job = api.jobs["test"]
    assert job["state"] == "complete"
    assert job["text"] == "Hello."
    assert job["warning"] and "hf_SECRET" not in job["warning"]
    assert not job["speakers"]
    assert not folder.exists()


def test_decode_failure_cleans_up(monkeypatch, tmp_path):
    folder = tmp_path / "upload"
    folder.mkdir()
    api.jobs["test"] = {"state": "loading"}
    monkeypatch.setattr(engine, "decode", Mock(side_effect=ValueError("file could not be decoded")))
    api.transcribe("test", str(folder), "bad.wav", "base", "")
    assert api.jobs["test"]["state"] == "error"
    assert not folder.exists()


def test_subtitles_and_timestamp_rollover():
    assert api.timestamp(59.9996) == "00:01:00,000"
    assert api.timestamp(-1) == "00:00:00,000"
    assert api.timestamp(3600) == "01:00:00,000"
    srt = api.subtitle_text(
        [{"start": 0, "end": 1.1, "text": " Hello. ", "speaker": "A"}], {"A": "Alex"}
    )
    assert srt == "1\n00:00:00,000 --> 00:00:01,100\nAlex: Hello.\n"


def test_job_pruning(upload, monkeypatch, tmp_path):
    monkeypatch.setattr(api.threading, "Thread", Mock())
    monkeypatch.setattr(api.time, "time", lambda: 4000)
    api.jobs["expired"] = {"created": 0, "state": "complete"}
    for index in range(10):
        api.jobs[str(index)] = {"created": 3999, "state": "complete"}
    folder = tmp_path / "upload"
    folder.mkdir()
    monkeypatch.setattr(api.tempfile, "mkdtemp", lambda **kwargs: str(folder))
    assert upload().status_code == 202
    assert len(api.jobs) == 10
    assert "expired" not in api.jobs and "0" not in api.jobs
