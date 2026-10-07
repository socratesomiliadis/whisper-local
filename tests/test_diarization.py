import sys
from types import SimpleNamespace
from unittest.mock import Mock

from whisper_local import diarization as d
from whisper_local import engine

TURNS = [
    {"start": 0, "end": 1.1, "speaker": "A"},
    {"start": 1.1, "end": 3, "speaker": "B"},
    {"start": 3, "end": 4, "speaker": "A"},
]


def test_word_attribution_splits_at_speaker_changes():
    segments = [
        {
            "start": 0,
            "end": 4,
            "text": " Hello there. Yes. Again.",
            "words": [
                {"start": 0, "end": 0.6, "word": " Hello"},
                {"start": 0.6, "end": 1, "word": " there."},
                {"start": 1.2, "end": 2, "word": " Yes."},
                {"start": 3.2, "end": 3.8, "word": " Again."},
            ],
        }
    ]
    rows, names = d.assign_speakers(segments, TURNS)
    assert [row["speaker"] for row in rows] == ["A", "B", "A"]
    assert [row["text"] for row in rows] == ["Hello there.", "Yes.", "Again."]
    assert names == {"A": "Speaker 1", "B": "Speaker 2"}
    assert d.assign_speakers(segments, [])[1] == {"unknown": "Unassigned"}


def test_overlap_drift_and_distant_words():
    assert d.speaker_at(1, 1.4, TURNS) == "B"
    assert d.speaker_at(4.1, 4.2, TURNS) == "A"
    assert d.speaker_at(10, 11, TURNS) == "unknown"
    assert d.assign_speakers([], []) == ([], {})


def test_missing_word_timestamps_and_long_pauses():
    rows, names = d.assign_speakers(
        [
            {"start": 0, "end": 1, "text": "Hello."},
            {"start": 3, "end": 4, "text": "Again."},
        ],
        [{"start": 0, "end": 4, "speaker": "A"}],
    )
    assert len(rows) == 2
    assert names == {"A": "Speaker 1"}


def test_setup_error_redacts_token():
    message = d.safe_error(Exception("download failed hf_SECRET-123_token"))
    assert message == "download failed [token hidden]"


def test_speaker_gpu_failure_retries_cpu(monkeypatch):
    # A small tensor/pipeline adapter keeps the recovery test independent of torch.
    tensor = Mock()
    torch = SimpleNamespace(from_numpy=lambda value: tensor, device=str)
    monkeypatch.setitem(sys.modules, "torch", torch)
    annotation = SimpleNamespace(
        itertracks=lambda **kwargs: iter([(SimpleNamespace(start=0, end=1), None, "A")])
    )

    class Worker:
        device = "cuda"
        attempts = []

        def to(self, device):
            self.device = device
            return self

        def __call__(self, audio, **kwargs):
            self.attempts.append(self.device)
            assert audio["sample_rate"] == 16000
            if self.device == "cuda":
                raise RuntimeError("CUDA out of memory")
            return SimpleNamespace(exclusive_speaker_diarization=annotation)

    worker = Worker()
    monkeypatch.setattr(d, "load_pipeline", lambda device: worker)
    monkeypatch.setattr(d, "pipeline_device", "cuda")
    monkeypatch.setattr(d, "gpu_failed", False)
    monkeypatch.setattr(engine, "capabilities", lambda: {"gpu_available": True})
    assert d.detect(Mock())[0]["speaker"] == "A"
    assert worker.attempts == ["cuda", "cpu"]
    assert d.gpu_failed and d.pipeline_device == "cpu"
