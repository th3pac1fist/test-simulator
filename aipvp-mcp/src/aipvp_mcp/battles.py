"""Fetch a match and write its battle viewer page."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse

from .client import AIPvPClient, ApiError
from .viewer import render


def export_battle(client: AIPvPClient, match_id: str, path: str | Path | None = None) -> Path:
    """Write a self-contained HTML replay of `match_id` and return its path."""
    turns = client.replay(match_id)
    try:
        match = client.get_match(match_id)
    except ApiError as e:
        if e.status not in (404, 405, 501):
            raise
        match = None  # the live site may not have this endpoint; the replay alone is enough
    host = urlparse(client.base_url).netloc
    source = "Local aipvp mock" if host.startswith(("127.0.0.1", "localhost")) else host
    out = Path(path) if path else Path(f"battle-{match_id}.html")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(match, turns, source=source), encoding="utf-8")
    return out.resolve()
