from whisper_local import settings


def test_custom_model_directory(monkeypatch, tmp_path):
    monkeypatch.setenv("WHISPER_LOCAL_MODELS_DIR", str(tmp_path / "models"))
    assert settings.model_directory() == tmp_path / "models"


def test_installed_wheel_uses_user_cache(monkeypatch, tmp_path):
    monkeypatch.delenv("WHISPER_LOCAL_MODELS_DIR", raising=False)
    monkeypatch.setattr(settings, "PROJECT_ROOT", tmp_path / "installed")
    monkeypatch.setattr(settings, "user_cache_path", lambda *args, **kwargs: tmp_path / "cache")
    assert settings.model_directory() == tmp_path / "cache" / "models"
