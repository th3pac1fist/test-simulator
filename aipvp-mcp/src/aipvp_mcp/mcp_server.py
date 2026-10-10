"""MCP server exposing the aipvp.io API as tools.

Login is deliberately not a tool, so passwords never pass through the model:
run `aipvp login EMAIL` once (or set AIPVP_TOKEN) and this server reuses the token.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import ValidationError

from . import config
from .client import AIPvPClient, ApiError
from .models import AgentCreate, Personality, Skill

SkillName = Literal["talk", "observe", "fight", "debate", "negotiate", "deceive",
                    "analyze", "strategize", "shield", "search", "code"]
assert set(SkillName.__args__) == {s.value for s in Skill}

server = MCPServer(
    "aipvp",
    instructions=(
        "Tools for the aipvp.io AI agent arena: create agents, start matches against them, and read replays, "
        "history and the leaderboard. Authentication comes from the user's saved `aipvp login` token or "
        "AIPVP_TOKEN; if a tool says you are not logged in, ask the user to run `aipvp login EMAIL` in a terminal. "
        "Never ask the user for their password."
    ),
)


def _call(fn_name: str, *args: Any, **kwargs: Any) -> Any:
    s = config.load()  # re-read each call so a login in another terminal takes effect
    with AIPvPClient(s.base_url, s.token) as client:
        try:
            return getattr(client, fn_name)(*args, **kwargs)
        except ApiError as e:
            if e.status == 401:
                raise ToolError(f"{e}. Not logged in: ask the user to run `aipvp login EMAIL` in a terminal.") from e
            if e.status == 0:
                raise ToolError(f"{e}. The API at {s.base_url} is unreachable.") from e
            raise ToolError(str(e)) from e


@server.tool()
def create_agent(
    name: str,
    description: str = "",
    skills: list[SkillName] | None = None,
    aggression: float = 0.5,
    caution: float = 0.5,
    creativity: float = 0.5,
    loyalty: float = 0.5,
) -> dict:
    """Create an arena agent for the logged-in user.

    skills: which skills the agent may use each turn (default talk, observe, fight, debate).
    Some skills need a paid tier on aipvp.io (strategize, negotiate, deceive, shield: Pro;
    code, search: Champion). Personality traits are 0-1 and shape which skills it favours.
    Returns the created agent, including its id.
    """
    try:
        agent = AgentCreate(
            name=name, description=description,
            **({"skills": skills} if skills else {}),
            personality=Personality(aggression=aggression, caution=caution, creativity=creativity, loyalty=loyalty),
        )
    except ValidationError as e:
        raise ToolError("; ".join(f"{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors())) from e
    return _call("create_agent", agent)


@server.tool()
def list_agents() -> list[dict]:
    """List the logged-in user's agents with their ids, skills and records."""
    return _call("list_agents")


@server.tool()
def agent_history(agent_id: str) -> list[dict]:
    """Past matches for one of the user's agents, newest first."""
    return _call("agent_history", agent_id)


@server.tool()
def start_match(agent_id: str, scenario: str = "prisoners-gambit") -> dict:
    """Start a match for one of the user's agents in a scenario (see list_scenarios).

    Returns the match summary including match_id. Use get_replay to read the turns.
    """
    return _call("start_match", agent_id, scenario)


@server.tool()
def get_replay(match_id: str) -> list[dict]:
    """Every turn of a match so far: phase, each agent's skill, content and points, and running scores."""
    return _call("replay", match_id)


@server.tool()
def join_queue(agent_id: str, auto_battle: bool = False) -> dict:
    """Put an agent in the matchmaking queue. auto_battle=True fights a bot if nobody is waiting."""
    return _call("join_queue", agent_id, auto_battle)


@server.tool()
def list_scenarios() -> list[dict]:
    """Available match scenarios and their ids."""
    return _call("scenarios")


@server.tool()
def leaderboard(mode: str = "arena", limit: int = 20) -> list[dict]:
    """Top agents on the leaderboard."""
    return _call("leaderboard", mode)[:limit]


@server.tool()
def api_status() -> dict:
    """Check that the API is reachable, and which base URL and login state the server is using."""
    s = config.load()
    return {"base_url": s.base_url, "logged_in": bool(s.token), "api": _call("status")}


def main() -> None:
    logging.getLogger("httpx").setLevel(logging.WARNING)  # keep request logs off stderr
    server.run()


if __name__ == "__main__":
    main()
