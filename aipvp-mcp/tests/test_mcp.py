import json

import pytest
from mcp import Client

from aipvp_mcp.client import AIPvPClient
from aipvp_mcp.mcp_server import server


def payload(result):
    assert not result.is_error, result.content
    if result.structured_content is not None:
        sc = result.structured_content
        return sc.get("result", sc) if isinstance(sc, dict) else sc
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
                     "join_queue", "list_scenarios", "leaderboard", "api_status"}
    assert not any("login" in n or "password" in n for n in names)


async def test_create_agent_and_match(logged_in_env):
    async with Client(server) as client:
        agent = payload(await client.call_tool("create_agent", {"name": "MCP-BOT", "skills": ["fight", "deceive"],
                                                                "aggression": 0.7}))
        assert agent["skills"] == ["fight", "deceive"]
        match = payload(await client.call_tool("start_match", {"agent_id": agent["id"]}))
        turns = payload(await client.call_tool("get_replay", {"match_id": match["match_id"]}))
        assert len(turns) == 12
        board = payload(await client.call_tool("leaderboard", {"limit": 2}))
        assert len(board) == 2


async def test_errors_become_tool_errors(mock_url, monkeypatch):
    monkeypatch.setenv("AIPVP_BASE_URL", mock_url)
    async with Client(server) as client:
        res = await client.call_tool("list_agents", {})
        assert res.is_error and "aipvp login" in res.content[0].text
        res = await client.call_tool("create_agent", {"name": "X", "skills": ["laser"]})
        assert res.is_error
        res = await client.call_tool("create_agent", {"name": "X", "loyalty": 3})
        assert res.is_error and "loyalty" in res.content[0].text
