"""Where the CLI and MCP server find the API base URL and auth token.

Precedence: explicit argument > environment variable > config file > default.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_BASE_URL = "https://aipvp.io/api/v1"


def config_path() -> Path:
    if env := os.environ.get("AIPVP_CONFIG"):
        return Path(env)
    root = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return root / "aipvp" / "config.json"


def _read_file() -> dict:
    try:
        return json.loads(config_path().read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


@dataclass
class Settings:
    base_url: str
    token: str | None


def load(base_url: str | None = None, token: str | None = None) -> Settings:
    stored = _read_file()
    return Settings(
        base_url=(base_url or os.environ.get("AIPVP_BASE_URL") or stored.get("base_url") or DEFAULT_BASE_URL).rstrip("/"),
        token=token or os.environ.get("AIPVP_TOKEN") or stored.get("token"),
    )


def save(**updates: str | None) -> Path:
    """Merge `updates` into the config file (None removes a key). The file is private to the user."""
    path = config_path()
    data = _read_file()
    for key, value in updates.items():
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(path, 0o600)
    return path
