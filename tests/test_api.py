import importlib
import json
import threading
import time
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
        {"quality": "invalid"},
        {"start_time": "nan"},
        {"end_time": "inf"},
        {"start_time": "-1"},
        {"start_time": "3", "end_time": "3"},
        {"end_time": "-2"},
        {"start_time": "invalid"},
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
    assert thread.call_args.kwargs["args"][7] == "cpu"
    assert thread.call_args.kwargs["target"] is api.run_job
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
    monkeypatch.setattr(engine, "decode", lambda path: [0] * 16000)
    monkeypatch.setattr(
        engine,
        "transcribe",
        lambda *args, **kwargs: {
            "text": "Hello.",
            "language": "en",
            "segments": [{"start": 0, "end": 1, "text": "Hello."}],
            "device": "cpu",
            "gpu_fallback": False,
            "warning": "Alignment model unavailable.",
        },
    )
    monkeypatch.setattr(diarization, "detect", Mock(side_effect=RuntimeError("failed hf_SECRET")))
    api.transcribe("test", str(folder), "clip.wav", "base", "", True)
    job = api.jobs["test"]
    assert job["state"] == "complete"
    assert job["text"] == "Hello."
    assert job["warning"] and "hf_SECRET" not in job["warning"]
    assert "Alignment model unavailable." in job["warning"]
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


@pytest.mark.parametrize("detect_speakers", [True, False])
def test_range_clips_audio_and_offsets_speaker_segments(monkeypatch, tmp_path, detect_speakers):
    folder = tmp_path / "upload"
    folder.mkdir()
    api.jobs["test"] = {"state": "loading"}
    monkeypatch.setattr(engine, "decode", lambda path: [0] * 160000)
    inference = Mock(
        return_value={
            "text": "Hello.",
            "language": "en",
            "device": "cpu",
            "gpu_fallback": False,
            "engine": "whisperx",
            "aligned": True,
            "segments": [
                {
                    "start": 0.25,
                    "end": 1.5,
                    "text": "Hello.",
                    "words": [{"start": 0.25, "end": 1.5, "word": " Hello.", "aligned": True}],
                }
            ],
        }
    )
    monkeypatch.setattr(engine, "transcribe", inference)
    monkeypatch.setattr(
        diarization,
        "detect",
        lambda *args, **kwargs: [
            {"start": 0, "end": 2, "speaker": "A"},
        ],
    )
    api.transcribe(
        "test",
        str(folder),
        "clip.wav",
        "base",
        "",
        detect_speakers,
        quality="accurate",
        start_time=3,
        end_time=5,
    )
    job = api.jobs["test"]
    assert job["state"] == "complete"
    assert len(inference.call_args.args[0]) == 32000
    assert inference.call_args.kwargs["quality"] == "accurate"
    assert job["duration"] == 2 and job["original_duration"] == 10
    assert job["range"] == {"start": 3, "end": 5}
    row = job["segments"][0]
    assert row["start"] == 3.25 and row["end"] == 4.5 and row["text"] == "Hello."
    assert row.get("speaker") == ("A" if detect_speakers else None)
    assert row["words"][0]["start"] == 3.25 and row["words"][0]["end"] == 4.5
    assert row["words"][0]["aligned"]
    assert job["engine"] == "whisperx" and job["aligned"]
    assert "00:00:03,250" in job["srt"]
    assert job["progress"] == 1 and job["stage"] == "complete"


def test_range_beyond_audio_fails_and_cleans(monkeypatch, tmp_path):
    folder = tmp_path / "upload"
    folder.mkdir()
    api.jobs["test"] = {"state": "loading"}
    monkeypatch.setattr(engine, "decode", lambda path: [0] * 16000)
    inference = Mock()
    monkeypatch.setattr(engine, "transcribe", inference)
    api.transcribe("test", str(folder), "clip.wav", "base", "", start_time=2)
    assert api.jobs["test"]["state"] == "error"
    assert "selected range" in api.jobs["test"]["message"]
    inference.assert_not_called()
    assert not folder.exists()


def test_cancel_missing_finished_and_queued_jobs(client, headers):
    assert client.post("/api/jobs/missing/cancel", headers=headers).status_code == 404
    api.jobs["done"] = {"state": "complete", "text": "Kept."}
    assert client.post("/api/jobs/done/cancel", headers=headers).json["text"] == "Kept."
    api.jobs["queued"] = {"state": "loading"}
    assert client.post("/api/jobs/queued/cancel", headers=headers).json["state"] == "cancelled"
    api.update_job("queued", state="complete", text="Late update")
    assert api.jobs["queued"]["state"] == "cancelled"
    assert "text" not in api.jobs["queued"]


def _blocking_inference_worker(events, arguments, gpu_disabled_reason=None):
    # A real spawned process models a native operation that never yields progress.
    Path(arguments[1], "started").write_text("running")
    while True:
        time.sleep(0.1)


def _completed_inference_worker(events, arguments, gpu_disabled_reason=None):
    events.send({"state": "complete", "text": "Finished.", "segments": [], "gpu_fallback": True})
    events.close()


def _exited_inference_worker(events, arguments, gpu_disabled_reason=None):
    events.close()


def _lingering_terminal_worker(events, arguments, gpu_disabled_reason=None):
    events.send({"state": arguments[3], "text": "Finished.", "message": "Finished."})
    Path(arguments[1], "sent").write_text("sent")
    while True:
        time.sleep(0.1)


@pytest.mark.parametrize("terminal_state", ["complete", "error"])
def test_terminal_state_waits_for_worker_exit_before_next_job_or_setup(
    client, headers, upload, monkeypatch, tmp_path, terminal_state
):
    folder = tmp_path / "upload"
    folder.mkdir()
    api.jobs["lingering"] = {"state": "loading", "created": time.time()}
    monkeypatch.setattr(api, "_inference_worker", _lingering_terminal_worker)
    monitor = threading.Thread(
        target=api.run_job, args=("lingering", str(folder), "clip.wav", terminal_state, "")
    )
    monitor.start()
    deadline = time.monotonic() + 15
    while not (folder / "sent").exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    try:
        assert (folder / "sent").exists()
        process = api.workers["lingering"]["process"]
        assert process.is_alive()
        assert client.get("/api/jobs/lingering", headers=headers).json["state"] == "loading"
        assert upload().status_code == 409
        assert (
            client.post(
                "/api/speakers/setup", headers=headers, json={"token": "hf_TEST_ONLY"}
            ).status_code
            == 409
        )
        monitor.join(timeout=10)
        assert not monitor.is_alive() and not process.is_alive()
        assert not folder.exists()
        assert api.jobs["lingering"]["state"] == terminal_state
        assert "lingering" not in api.workers
    finally:
        api.stop_workers()
        monitor.join(timeout=10)


def test_cancel_before_worker_start_prevents_native_work_and_cleans_upload(tmp_path):
    folder = tmp_path / "upload"
    folder.mkdir()
    api.jobs["queued"] = {"state": "cancelled"}
    api.upload_folders["queued"] = str(folder)
    api.run_job("queued", str(folder), "clip.wav", "base", "")
    assert api.jobs["queued"]["state"] == "cancelled"
    assert not folder.exists()
    assert not api.workers and not api.upload_folders


def test_worker_ipc_creation_failure_releases_job_and_upload(monkeypatch, tmp_path):
    folder = tmp_path / "upload"
    folder.mkdir()
    api.jobs["failed"] = {"state": "loading"}
    api.upload_folders["failed"] = str(folder)
    context = Mock()
    context.Pipe.side_effect = OSError("no IPC resources")
    monkeypatch.setattr(api.multiprocessing, "get_context", lambda name: context)
    api.run_job("failed", str(folder), "clip.wav", "base", "")
    assert api.jobs["failed"]["state"] == "error"
    assert not folder.exists()
    assert not api.workers and not api.upload_folders


@pytest.mark.parametrize(
    "worker,state", [(_completed_inference_worker, "complete"), (_exited_inference_worker, "error")]
)
def test_worker_exit_releases_process_and_upload(monkeypatch, tmp_path, worker, state):
    folder = tmp_path / "upload"
    folder.mkdir()
    api.jobs["exit"] = {"state": "loading"}
    api.upload_folders["exit"] = str(folder)
    monkeypatch.setattr(api, "_inference_worker", worker)
    api.run_job("exit", str(folder), "clip.wav", "base", "")
    assert api.jobs["exit"]["state"] == state
    assert not folder.exists()
    assert "exit" not in api.workers and "exit" not in api.upload_folders
    if state == "complete":
        assert engine.gpu_disabled_reason


@pytest.mark.parametrize("shutdown", [False, True])
def test_cancel_terminates_blocking_process_and_cleans_upload(
    client, headers, monkeypatch, tmp_path, shutdown
):
    folder = tmp_path / "upload"
    folder.mkdir()
    api.jobs["blocking"] = {"state": "loading"}
    monkeypatch.setattr(api, "_inference_worker", _blocking_inference_worker)
    monitor = threading.Thread(
        target=api.run_job, args=("blocking", str(folder), "clip.wav", "base", "")
    )
    monitor.start()
    deadline = time.monotonic() + 15
    while not (folder / "started").exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    try:
        assert (folder / "started").exists(), "worker did not start"
        process = api.workers["blocking"]["process"]
        if shutdown:
            api.stop_workers()
            assert api.jobs["blocking"]["state"] == "cancelled"
        else:
            response = client.post("/api/jobs/blocking/cancel", headers=headers)
            assert response.status_code == 200 and response.json["state"] == "cancelled"
        monitor.join(timeout=10)
        assert not process.is_alive()
        assert not monitor.is_alive()
        assert not folder.exists()
        assert "blocking" not in api.workers
    finally:
        client.post("/api/jobs/blocking/cancel", headers=headers)
        monitor.join(timeout=10)
