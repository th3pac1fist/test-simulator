import socket
import threading
import time

import pytest
import uvicorn

from aipvp_mcp.mock.server import create_app


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def mock_url():
    """A fresh mock server (instant matches) on a random port; yields its API base URL."""
    port = _free_port()
    srv = uvicorn.Server(uvicorn.Config(create_app(turn_delay=0), host="127.0.0.1", port=port, log_level="error"))
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    for _ in range(200):
        if srv.started:
            break
        time.sleep(0.02)
    yield f"http://127.0.0.1:{port}/api/v1"
    srv.should_exit = True
    t.join(5)


@pytest.fixture(autouse=True)
def isolated_config(tmp_path, monkeypatch):
    """Never touch the real ~/.config/aipvp, and ignore any AIPVP_* in the environment."""
    monkeypatch.setenv("AIPVP_CONFIG", str(tmp_path / "config.json"))
    for var in ("AIPVP_BASE_URL", "AIPVP_TOKEN", "AIPVP_PASSWORD"):
        monkeypatch.delenv(var, raising=False)
    return tmp_path / "config.json"
