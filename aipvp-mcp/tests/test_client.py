import pytest

from aipvp_mcp.client import AIPvPClient, ApiError
from aipvp_mcp.models import AgentCreate, Personality, Skill


def logged_in(url, email="a@example.com"):
    c = AIPvPClient(url)
    c.register(email, "password123", "Alice")
    return c


def test_public_endpoints(mock_url):
    c = AIPvPClient(mock_url)
    assert c.status()["status"] == "ok"
    assert "prisoners-gambit" in [s["id"] for s in c.scenarios()]
    assert len(c.leaderboard()) == 3  # house bots


def test_register_login_and_bad_password(mock_url):
    logged_in(mock_url)
    c = AIPvPClient(mock_url)
    assert c.login("A@example.com", "password123")["token"] == c.token
    with pytest.raises(ApiError) as e:
        c.login("a@example.com", "wrong-password")
    assert e.value.status == 401
    with pytest.raises(ApiError) as e:
        c.register("a@example.com", "password123", "Dup")
    assert e.value.status == 409


def test_agent_requires_auth(mock_url):
    with pytest.raises(ApiError) as e:
        AIPvPClient(mock_url).list_agents()
    assert e.value.status == 401


def test_create_agent_match_replay_history(mock_url):
    c = logged_in(mock_url)
    agent = c.create_agent(AgentCreate(name="NEXUS", skills=[Skill.FIGHT, Skill.TALK],
                                       personality=Personality(aggression=0.9)))
    assert agent["skills"] == ["fight", "talk"] and agent["personality"]["aggression"] == 0.9
    assert [a["id"] for a in c.list_agents()] == [agent["id"]]

    match = c.start_match(agent["id"], "shark-tank")
    assert match["status"] == "completed" and match["turns"] == 12
    turns = c.replay(match["match_id"])
    assert len(turns) == 12 and [t["phase"] for t in turns[::4]] == ["opening", "midgame", "endgame"]
    assert sum(a["points"] for t in turns for a in t["actions"]) == pytest.approx(sum(match_a["score"] for match_a in match["agents"]))
    assert c.agent_history(agent["id"])[0]["match_id"] == match["match_id"]


def test_cannot_use_someone_elses_agent(mock_url):
    alice = logged_in(mock_url)
    agent = alice.create_agent(AgentCreate(name="A"))
    bob = logged_in(mock_url, "b@example.com")
    with pytest.raises(ApiError) as e:
        bob.start_match(agent["id"])
    assert e.value.status == 403


def test_unknown_scenario(mock_url):
    c = logged_in(mock_url)
    agent = c.create_agent(AgentCreate(name="A"))
    with pytest.raises(ApiError) as e:
        c.start_match(agent["id"], "no-such-scenario")
    assert e.value.status == 422 and "prisoners-gambit" in e.value.message


def test_queue_pairs_two_agents(mock_url):
    a = logged_in(mock_url)
    b = logged_in(mock_url, "b@example.com")
    first = a.join_queue(a.create_agent(AgentCreate(name="A"))["id"])
    assert first["status"] == "queued"
    second = b.join_queue(b.create_agent(AgentCreate(name="B"))["id"])
    assert second["status"] == "matched" and second["match"]["status"] == "completed"


def test_unreachable_server_is_status_0():
    with pytest.raises(ApiError) as e:
        AIPvPClient("http://127.0.0.1:9/api/v1", timeout=2).status()
    assert e.value.status == 0


def test_ws_url():
    assert AIPvPClient("https://aipvp.io/api/v1").ws_url == "wss://aipvp.io/ws"
    assert AIPvPClient("http://127.0.0.1:8787/api/v1").ws_url == "ws://127.0.0.1:8787/ws"


def test_agent_validation():
    with pytest.raises(ValueError):
        Personality(aggression=1.5)
    with pytest.raises(ValueError):
        AgentCreate(name="x", skills=[])
    assert AgentCreate(name="x", skills=["fight", "fight"]).skills == [Skill.FIGHT]
