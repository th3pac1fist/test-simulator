"""Local stand-in for the aipvp.io API.

Implements every endpoint the official SDK calls, in memory, so the CLI and
MCP server can be used and tested while the real site is unreachable.
Request bodies match the SDK; response shapes are our own guess.

Run:  aipvp-mock [--port 8787]   then point clients at http://127.0.0.1:8787/api/v1
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
import random
import secrets
import time
import uuid
from dataclasses import dataclass, field

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from ..models import KNOWN_SCENARIOS, TRAITS, AgentCreate

MAX_TURNS = 12

SCENARIOS = {
    "prisoners-gambit": ("Prisoner's Gambit", "Classic cooperation vs. betrayal."),
    "shark-tank": ("Shark Tank", "Pitch and negotiate under pressure."),
    "the-trial": ("The Trial", "Argue your case, defend your position."),
    "spy-network": ("Spy Network", "Deception and counter-intelligence."),
    "auction-house": ("Auction House", "Bidding strategy and bluffing."),
    "evolution-island": ("Evolution Island", "Adapt or die."),
}
assert list(SCENARIOS) == KNOWN_SCENARIOS

# Same scoring table as the SDK's MockArena: the stronger skill takes the turn.
SKILL_POWER = {"fight": 3, "deceive": 3, "talk": 2, "debate": 2, "negotiate": 2,
               "observe": 1, "analyze": 1, "strategize": 1, "shield": 1, "search": 1, "code": 1}

# Which personality trait pushes an agent toward each skill.
SKILL_TRAIT = {"fight": "aggression", "deceive": "aggression", "talk": "loyalty", "negotiate": "loyalty",
               "debate": "creativity", "strategize": "creativity", "code": "creativity", "search": "creativity",
               "observe": "caution", "analyze": "caution", "shield": "caution"}

LINES = {
    "fight": "{me} presses the attack on {them}.",
    "deceive": "{me} feints, hiding the real plan from {them}.",
    "talk": "{me} tries to win {them} over.",
    "negotiate": "{me} offers {them} a deal.",
    "debate": "{me} picks apart {them}'s last argument.",
    "strategize": "{me} lays out a plan for the next few turns.",
    "code": "{me} writes a tool to settle the question.",
    "search": "{me} looks up facts to back the case.",
    "observe": "{me} watches {them} closely.",
    "analyze": "{me} studies the pattern in {them}'s moves.",
    "shield": "{me} digs in and defends.",
}

HOUSE_BOTS = [
    ("HOUSE-BRUTE", "Mock opponent that favours aggression.",
     ["fight", "talk", "observe"], {"aggression": 0.9, "caution": 0.2, "creativity": 0.3, "loyalty": 0.2}),
    ("HOUSE-DIPLOMAT", "Mock opponent that favours cooperation.",
     ["talk", "negotiate", "observe", "debate"], {"aggression": 0.2, "caution": 0.5, "creativity": 0.5, "loyalty": 0.9}),
    ("HOUSE-TACTICIAN", "Mock opponent that plays the long game.",
     ["strategize", "observe", "fight", "shield"], {"aggression": 0.5, "caution": 0.7, "creativity": 0.8, "loyalty": 0.4}),
]


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _now() -> float:
    return round(time.time(), 3)


def _hash(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100_000)


@dataclass
class User:
    id: str
    email: str
    display_name: str
    salt: bytes
    pw_hash: bytes

    def public(self) -> dict:
        return {"id": self.id, "email": self.email, "display_name": self.display_name}


@dataclass
class Agent:
    id: str
    owner_id: str | None
    name: str
    description: str
    skills: list[str]
    personality: dict[str, float]
    created_at: float = field(default_factory=_now)
    rating: int = 1000
    wins: int = 0
    losses: int = 0
    draws: int = 0
    house: bool = False

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "description": self.description, "skills": self.skills,
                "personality": self.personality, "rating": self.rating, "wins": self.wins, "losses": self.losses,
                "draws": self.draws, "house": self.house, "created_at": self.created_at}


@dataclass
class Match:
    id: str
    scenario_id: str
    agent_ids: tuple[str, str]
    agent_names: tuple[str, str]
    status: str = "running"
    turns: list[dict] = field(default_factory=list)
    scores: list[float] = field(default_factory=lambda: [0.0, 0.0])
    winner_id: str | None = None
    created_at: float = field(default_factory=_now)
    finished_at: float | None = None

    def summary(self) -> dict:
        return {"match_id": self.id, "scenario_id": self.scenario_id, "status": self.status,
                "agents": [{"id": i, "name": n, "score": s}
                           for i, n, s in zip(self.agent_ids, self.agent_names, self.scores)],
                "winner_id": self.winner_id, "turns": len(self.turns), "max_turns": MAX_TURNS,
                "created_at": self.created_at, "finished_at": self.finished_at}


class LoginBody(BaseModel):
    email: str
    password: str


class RegisterBody(LoginBody):
    display_name: str


class MatchBody(BaseModel):
    agent_id: str
    scenario_id: str = "prisoners-gambit"


class QueueBody(BaseModel):
    agent_id: str
    auto_battle: bool = False


class Arena:
    """All mock state, plus the match engine."""

    def __init__(self, turn_delay: float = 0.0):
        self.turn_delay = turn_delay
        self.users: dict[str, User] = {}          # by email
        self.tokens: dict[str, str] = {}          # token -> user id
        self.agents: dict[str, Agent] = {}
        self.matches: dict[str, Match] = {}
        self.queue: list[str] = []                # waiting agent ids
        self.sockets: set[WebSocket] = set()
        self.tasks: set[asyncio.Task] = set()
        for name, desc, skills, pers in HOUSE_BOTS:
            a = Agent(_id("agt"), None, name, desc, skills, pers, house=True)
            self.agents[a.id] = a

    # --- engine -------------------------------------------------------------

    @staticmethod
    def _pick(rng: random.Random, agent: Agent, phase: str) -> str:
        weights = []
        for s in agent.skills:
            w = 0.2 + agent.personality.get(SKILL_TRAIT.get(s, "caution"), 0.5)
            if phase == "endgame" and SKILL_POWER.get(s, 1) >= 3:
                w *= 1.5  # agents push harder when points are worth double
            weights.append(w)
        return rng.choices(agent.skills, weights)[0]

    def _turn(self, m: Match, rng: random.Random, turn: int) -> dict:
        a, b = (self.agents[i] for i in m.agent_ids)
        phase = "opening" if turn <= 4 else "midgame" if turn <= 8 else "endgame"
        mult = {"opening": 1.0, "midgame": 1.5, "endgame": 2.0}[phase]
        sa, sb = self._pick(rng, a, phase), self._pick(rng, b, phase)
        pa, pb = SKILL_POWER.get(sa, 1), SKILL_POWER.get(sb, 1)
        if pa > pb:
            pts = (pa * mult, 0.0)
        elif pb > pa:
            pts = (0.0, pb * mult)
        else:
            pts = (pa * mult / 2, pb * mult / 2)
        m.scores = [m.scores[0] + pts[0], m.scores[1] + pts[1]]
        actions = [
            {"agent_id": a.id, "agent_name": a.name, "skill": sa, "points": pts[0],
             "content": LINES[sa].format(me=a.name, them=b.name)},
            {"agent_id": b.id, "agent_name": b.name, "skill": sb, "points": pts[1],
             "content": LINES[sb].format(me=b.name, them=a.name)},
        ]
        record = {"turn": turn, "phase": phase, "multiplier": mult, "actions": actions, "scores": list(m.scores)}
        m.turns.append(record)
        return record

    def _finish(self, m: Match) -> None:
        a, b = (self.agents[i] for i in m.agent_ids)
        if m.scores[0] == m.scores[1]:
            a.draws += 1
            b.draws += 1
            outcome = 0.5
        else:
            winner, loser = (a, b) if m.scores[0] > m.scores[1] else (b, a)
            winner.wins += 1
            loser.losses += 1
            m.winner_id = winner.id
            outcome = 1.0 if winner is a else 0.0
        # Elo, K=32
        expected = 1 / (1 + 10 ** ((b.rating - a.rating) / 400))
        delta = round(32 * (outcome - expected))
        a.rating += delta
        b.rating -= delta
        m.status = "completed"
        m.finished_at = _now()

    async def _broadcast(self, msg: dict) -> None:
        for ws in list(self.sockets):
            try:
                await ws.send_json(msg)
            except Exception:
                self.sockets.discard(ws)

    async def run(self, m: Match) -> None:
        rng = random.Random(m.id)
        for turn in range(1, MAX_TURNS + 1):
            record = self._turn(m, rng, turn)
            for act in record["actions"]:
                await self._broadcast({"type": "turn_action", "match_id": m.id,
                                       "data": {"match_id": m.id, "turn": turn, "phase": record["phase"], **act}})
            if self.turn_delay:
                await asyncio.sleep(self.turn_delay)
        self._finish(m)
        await self._broadcast({"type": "match_end", "match_id": m.id, "data": m.summary()})

    async def start(self, a: Agent, b: Agent, scenario_id: str) -> Match:
        m = Match(_id("mch"), scenario_id, (a.id, b.id), (a.name, b.name))
        self.matches[m.id] = m
        if self.turn_delay:
            task = asyncio.create_task(self.run(m))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        else:
            await self.run(m)
        return m


def create_app(turn_delay: float | None = None) -> FastAPI:
    if turn_delay is None:
        turn_delay = float(os.environ.get("AIPVP_MOCK_TURN_DELAY", "0.5"))
    arena = Arena(turn_delay)
    app = FastAPI(title="aipvp mock", version="0.1.0",
                  description="Local mock of the aipvp.io API. Response shapes are not confirmed against the real site.")
    app.state.arena = arena
    api = APIRouter(prefix="/api/v1")

    def current_user(authorization: str | None = Header(None)) -> str:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "Missing bearer token. Log in first.")
        user_id = arena.tokens.get(authorization.split(" ", 1)[1].strip())
        if not user_id:
            raise HTTPException(401, "Invalid or expired token.")
        return user_id

    def own_agent(agent_id: str, user_id: str) -> Agent:
        agent = arena.agents.get(agent_id)
        if not agent:
            raise HTTPException(404, f"Agent {agent_id} not found.")
        if agent.owner_id != user_id:
            raise HTTPException(403, "That agent belongs to another account.")
        return agent

    def issue(user: User) -> dict:
        token = secrets.token_urlsafe(32)
        arena.tokens[token] = user.id
        return {"token": token, "user": user.public()}

    # --- auth ---

    @api.post("/auth/register", status_code=201)
    def register(body: RegisterBody) -> dict:
        email = body.email.strip().lower()
        if "@" not in email:
            raise HTTPException(422, "Invalid email address.")
        if len(body.password) < 8:
            raise HTTPException(422, "Password must be at least 8 characters.")
        if email in arena.users:
            raise HTTPException(409, "An account with that email already exists.")
        salt = secrets.token_bytes(16)
        user = User(_id("usr"), email, body.display_name, salt, _hash(body.password, salt))
        arena.users[email] = user
        return issue(user)

    @api.post("/auth/login")
    def login(body: LoginBody) -> dict:
        user = arena.users.get(body.email.strip().lower())
        if not user or not secrets.compare_digest(user.pw_hash, _hash(body.password, user.salt)):
            raise HTTPException(401, "Wrong email or password.")
        return issue(user)

    # --- agents ---

    @api.post("/agents", status_code=201)
    def create_agent(body: AgentCreate, user_id: str = Depends(current_user)) -> dict:
        if any(a.owner_id == user_id and a.name.lower() == body.name.lower() for a in arena.agents.values()):
            raise HTTPException(409, f"You already have an agent named {body.name}.")
        agent = Agent(_id("agt"), user_id, body.name, body.description, [s.value for s in body.skills],
                      {t: getattr(body.personality, t) for t in TRAITS})
        arena.agents[agent.id] = agent
        return agent.public()

    @api.get("/agents")
    def list_agents(user_id: str = Depends(current_user)) -> list[dict]:
        return [a.public() for a in arena.agents.values() if a.owner_id == user_id]

    @api.get("/agents/{agent_id}/history")
    def agent_history(agent_id: str, user_id: str = Depends(current_user)) -> list[dict]:
        own_agent(agent_id, user_id)
        return [m.summary() for m in reversed(list(arena.matches.values())) if agent_id in m.agent_ids]

    # --- matches ---

    @api.post("/matches", status_code=201)
    async def start_match(body: MatchBody, user_id: str = Depends(current_user)) -> dict:
        agent = own_agent(body.agent_id, user_id)
        if body.scenario_id not in SCENARIOS:
            raise HTTPException(422, f"Unknown scenario {body.scenario_id}. Options: {', '.join(SCENARIOS)}")
        opponent = random.choice([a for a in arena.agents.values() if a.house])
        m = await arena.start(agent, opponent, body.scenario_id)
        return m.summary()

    @api.get("/matches/{match_id}/replay")
    def replay(match_id: str) -> list[dict]:
        m = arena.matches.get(match_id)
        if not m:
            raise HTTPException(404, f"Match {match_id} not found.")
        return m.turns

    @api.post("/matchmaking/queue")
    async def join_queue(body: QueueBody, user_id: str = Depends(current_user)) -> dict:
        agent = own_agent(body.agent_id, user_id)
        if agent.id in arena.queue:
            return {"status": "queued", "agent_id": agent.id, "position": arena.queue.index(agent.id) + 1}
        if arena.queue:
            other = arena.agents[arena.queue.pop(0)]
            m = await arena.start(other, agent, "prisoners-gambit")
            return {"status": "matched", "agent_id": agent.id, "match": m.summary()}
        if body.auto_battle:
            opponent = random.choice([a for a in arena.agents.values() if a.house])
            m = await arena.start(agent, opponent, "prisoners-gambit")
            return {"status": "matched", "agent_id": agent.id, "match": m.summary()}
        arena.queue.append(agent.id)
        return {"status": "queued", "agent_id": agent.id, "position": len(arena.queue)}

    # --- public ---

    @api.get("/scenarios")
    def scenarios() -> list[dict]:
        return [{"id": k, "title": t, "description": d} for k, (t, d) in SCENARIOS.items()]

    @api.get("/leaderboard/{mode}")
    def leaderboard(mode: str) -> list[dict]:
        if mode != "arena":
            raise HTTPException(404, f"Unknown leaderboard mode {mode}. The mock only has 'arena'.")
        ranked = sorted(arena.agents.values(), key=lambda a: (-a.rating, -a.wins, a.created_at))
        return [{"rank": i, **a.public()} for i, a in enumerate(ranked, 1)]

    @api.get("/status")
    def status() -> dict:
        return {"status": "ok", "mock": True, "version": app.version, "agents": len(arena.agents),
                "matches": len(arena.matches), "queue": len(arena.queue)}

    app.include_router(api)

    @app.websocket("/ws")
    async def ws(socket: WebSocket) -> None:
        await socket.accept()
        arena.sockets.add(socket)
        try:
            while True:
                await socket.receive_text()  # clients don't need to send anything
        except WebSocketDisconnect:
            pass
        finally:
            arena.sockets.discard(socket)

    return app


def main(argv: list[str] | None = None) -> None:
    import uvicorn

    p = argparse.ArgumentParser(prog="aipvp-mock", description="Run a local mock of the aipvp.io API.")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--turn-delay", type=float, default=None,
                   help="Seconds between match turns (default 0.5, env AIPVP_MOCK_TURN_DELAY). 0 = instant.")
    args = p.parse_args(argv)
    print(f"Mock API at http://{args.host}:{args.port}/api/v1  (export AIPVP_BASE_URL to use it)")
    uvicorn.run(create_app(args.turn_delay), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
