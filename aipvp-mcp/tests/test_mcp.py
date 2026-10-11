import json

import pytest
from mcp import Client

from aipvp_mcp.client import AIPvPClient
from aipvp_mcp.mcp_server import server


def payload(result):
    """What the model actually reads: every tool must return exactly one JSON text block."""
    assert not result.is_error, result.content
    assert len(result.content) == 1, f"expected one text block, got {len(result.content)}"
    return json.loads(result.content[0].text)


@pytest.fixture
def logged_in_env(mock_url, monkeypatch):
    c = AIPvPClient(mock_url)
    c.register("mcp@example.com", "password123", "MCP")
    monkeypatch.setenv("AIPVP_BASE_URL", mock_url)
    monkeypatch.setenv("AIPVP_TOKEN", c.token)


async def test_tool_list():
    async with Client(server) as client:
        names = {t.name for t in (await client.list_tools()).tools}
    assert names == {"create_agent", "list_agents", "agent_history", "start_match", "get_replay",
                     "join_queue", "list_scenarios", "leaderboard", "api_status", "battle_viewer"}
    assert not any("login" in n or "password" in n for n in names)


async def test_create_agent_and_match(logged_in_env):
    async with Client(server) as client:
        agent = payload(await client.call_tool("create_agent", {"name": "MCP-BOT", "skills": ["fight", "deceive"],
                                                                "aggression": 0.7}))
        assert agent["skills"] == ["fight", "deceive"]
        match = payload(await client.call_tool("start_match", {"agent_id": agent["id"]}))
        replay = payload(await client.call_tool("get_replay", {"match_id": match["match_id"]}))
        assert replay["count"] == len(replay["turns"]) == 12
        board = payload(await client.call_tool("leaderboard", {"limit": 2}))
        assert board["count"] == 2 and board["agents"][0]["rank"] == 1


async def test_errors_become_tool_errors(mock_url, monkeypatch):
    monkeypatch.setenv("AIPVP_BASE_URL", mock_url)
    async with Client(server) as client:
        res = await client.call_tool("list_agents", {})
        assert res.is_error and "aipvp login" in res.content[0].text
        res = await client.call_tool("create_agent", {"name": "X", "skills": ["laser"]})
        assert res.is_error
        res = await client.call_tool("create_agent", {"name": "X", "loyalty": 3})
        assert res.is_error and "loyalty" in res.content[0].text


async def test_empty_list_still_returns_text(logged_in_env):
    async with Client(server) as client:
        agents = payload(await client.call_tool("list_agents", {}))
    assert agents == {"agents": [], "count": 0}


async def test_battle_viewer_tool(logged_in_env, tmp_path):
    async with Client(server) as client:
        agent = payload(await client.call_tool("create_agent", {"name": "VIEWED"}))
        match = payload(await client.call_tool("start_match", {"agent_id": agent["id"]}))
        out = tmp_path / "b.html"
        res = payload(await client.call_tool("battle_viewer", {"match_id": match["match_id"], "output_path": str(out)}))
    assert res["path"] == str(out.resolve()) and "VIEWED" in out.read_text()
