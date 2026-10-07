"""Resolve model storage independently of the current working directory."""

import os
from pathlib import Path

from platformdirs import user_cache_path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def model_directory() -> Path:
    if override := os.environ.get("WHISPER_LOCAL_MODELS_DIR"):
        return Path(override).expanduser().resolve()
    if (PROJECT_ROOT / "pyproject.toml").is_file():
        return PROJECT_ROOT / ".models"
    return user_cache_path("whisper-local", appauthor=False) / "models"


MODELS_DIR = model_directory()
