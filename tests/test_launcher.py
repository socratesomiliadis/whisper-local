import importlib
from unittest.mock import Mock

import pytest

api = importlib.import_module("whisper_local.app")


def test_binding_failure_never_opens_browser(monkeypatch):
    browser = Mock()
    monkeypatch.setattr(api.webbrowser, "open", browser)
    monkeypatch.setattr("waitress.create_server", Mock(side_effect=OSError("address in use")))
    with pytest.raises(SystemExit) as error:
        api.main([])
    assert error.value.code == 1
    browser.assert_not_called()


def test_cli_binds_loopback_and_closes_server(monkeypatch):
    server = Mock()
    create = Mock(return_value=server)
    browser = Mock()
    monkeypatch.setattr("waitress.create_server", create)
    monkeypatch.setattr(api.webbrowser, "open", browser)
    api.main(["--port", "8766", "--no-browser"])
    assert create.call_args.kwargs["host"] == "127.0.0.1"
    assert create.call_args.kwargs["port"] == 8766
    server.run.assert_called_once()
    server.close.assert_called_once()
    browser.assert_not_called()
