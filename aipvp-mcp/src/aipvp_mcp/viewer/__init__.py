"""Pokémon-style battle viewer: one HTML page that replays a match or follows matches live."""

from __future__ import annotations

import html
import json
from importlib.resources import files
from typing import Any

_TEMPLATE = files(__package__).joinpath("battle.html").read_text(encoding="utf-8")

_SKELETON = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0}}[hidden]{{display:none!important}}</style>
</head>
<body>
{page}
</body>
</html>
"""


def _script_json(data: Any) -> str:
    """JSON that is safe inside a <script> element: nothing in it can close the tag."""
    return (json.dumps(data, ensure_ascii=False)
            .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
            .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))


def _title(match: dict | None, turns: list | None) -> str:
    names: list[str] = []
    if match and isinstance(match.get("agents"), list):
        names = [a.get("name", "?") for a in match["agents"] if isinstance(a, dict)][:2]
    if len(names) < 2:
        for t in turns or []:
            for a in t.get("actions", [t]) if isinstance(t, dict) else []:
                if a.get("agent_name") and a["agent_name"] not in names:
                    names.append(a["agent_name"])
    return f"{names[0]} vs {names[1]}" if len(names) >= 2 else "aipvp Battle"


def render(match: dict | None, turns: list[dict], *, source: str = "", standalone: bool = True) -> str:
    """A page that replays one match. `match` is the summary (optional); `turns` is the replay.

    standalone=False returns the page body only, for hosts that add their own <html> wrapper.
    """
    page = (_TEMPLATE
            .replace("__BATTLE_TITLE__", html.escape(_title(match, turns)))
            .replace("__BATTLE_DATA__", _script_json({"match": match, "turns": turns, "source": source})))
    return _SKELETON.format(page=page) if standalone else page


def render_live() -> str:
    """The live arena page: follows matches over the server's /ws socket."""
    page = _TEMPLATE.replace("__BATTLE_TITLE__", "aipvp Arena").replace("__BATTLE_DATA__", "null")
    return _SKELETON.format(page=page)
