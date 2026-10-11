import json
import re

import httpx

from aipvp_mcp.cli import main
from aipvp_mcp.client import AIPvPClient
from aipvp_mcp.models import AgentCreate
from aipvp_mcp.viewer import render, render_live


def embedded(page: str):
    m = re.search(r'<script id="battle-data" type="application/json">(.*?)</script>', page, re.S)
    return json.loads(m.group(1))


def test_render_embeds_data_safely():
    evil = "</script><script>alert(1)</script> &  "
    turns = [{"turn": 1, "phase": "opening", "scores": [3, 0], "actions": [
        {"agent_id": "a", "agent_name": "A<b>", "skill": "fight", "points": 3, "content": evil},
        {"agent_id": "b", "agent_name": "B", "skill": "talk", "points": 0, "content": "hi"}]}]
    page = render(None, turns)
    assert page.startswith("<!doctype html>")
    assert "<title>A&lt;b&gt; vs B</title>" in page
    assert page.count("</script>") == 2  # only the page's own two script tags close
    assert embedded(page)["turns"][0]["actions"][0]["content"] == evil
    assert "<!doctype" not in render(None, turns, standalone=False)


def test_live_page_has_no_data():
    page = render_live()
    assert "<title>aipvp Arena</title>" in page and embedded(page) is None


def test_mock_serves_arena_and_match_details(mock_url):
    root = mock_url.removesuffix("/api/v1")
    assert "aipvp Arena" in httpx.get(root + "/arena").text
    c = AIPvPClient(mock_url)
    c.register("v@example.com", "password123", "V")
    agent = c.create_agent(AgentCreate(name="SHOWN"))
    m = c.get_match(c.start_match(agent["id"])["match_id"])
    assert m["agents"][0]["personality"] and "rating" in m["agents"][0]


def test_cli_match_view(mock_url, tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("AIPVP_PASSWORD", "password123")
    main(["register", "cv@example.com", "--base-url", mock_url])
    main(["agent", "create", "--name", "PIXEL", "--json"])
    agent = json.loads(capsys.readouterr().out.split("\n", 1)[1])
    main(["match", "start", agent["id"], "--json"])
    match = json.loads(capsys.readouterr().out)
    out = tmp_path / "battle.html"
    main(["match", "view", match["match_id"], "-o", str(out)])
    data = embedded(out.read_text())
    assert len(data["turns"]) == 12 and data["match"]["agents"][0]["name"] == "PIXEL"
    assert data["source"] == "Local aipvp mock"
