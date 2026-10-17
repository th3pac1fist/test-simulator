"""HTTP client for the aipvp.io API (one method per endpoint)."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import httpx

from .config import DEFAULT_BASE_URL
from .models import AgentCreate


class ApiError(Exception):
    """A non-2xx response, or a network failure (status 0)."""

    def __init__(self, status: int, message: str, body: Any = None):
        super().__init__(f"HTTP {status}: {message}" if status else message)
        self.status = status
        self.message = message
        self.body = body


def _error_message(resp: httpx.Response) -> tuple[str, Any]:
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:500] or resp.reason_phrase, resp.text
    if isinstance(body, dict):
        for key in ("detail", "error", "message"):
            if body.get(key):
                return str(body[key]), body
    return resp.reason_phrase, body


class AIPvPClient:
    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        token: str | None = None,
        *,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self._http = httpx.Client(base_url=self.base_url, timeout=timeout, transport=transport)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> AIPvPClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _request(self, method: str, path: str, *, auth: bool = True, **kwargs: Any) -> Any:
        headers = {"Authorization": f"Bearer {self.token}"} if auth and self.token else {}
        try:
            resp = self._http.request(method, path, headers=headers, **kwargs)
        except httpx.HTTPError as e:
            raise ApiError(0, f"Could not reach {self.base_url}: {e}") from e
        if resp.is_error:
            message, body = _error_message(resp)
            raise ApiError(resp.status_code, message, body)
        if not resp.content:
            return None
        try:
            return resp.json()
        except ValueError:
            return resp.text

    # --- auth ---------------------------------------------------------------

    def register(self, email: str, password: str, display_name: str) -> dict:
        data = self._request(
            "POST", "/auth/register", auth=False,
            json={"email": email, "password": password, "display_name": display_name},
        )
        self.token = data["token"]
        return data

    def login(self, email: str, password: str) -> dict:
        data = self._request("POST", "/auth/login", auth=False, json={"email": email, "password": password})
        self.token = data["token"]
        return data

    # --- agents -------------------------------------------------------------

    def create_agent(self, agent: AgentCreate) -> dict:
        return self._request("POST", "/agents", json=agent.payload())

    def list_agents(self) -> list[dict]:
        return self._request("GET", "/agents")

    def agent_history(self, agent_id: str) -> list[dict]:
        return self._request("GET", f"/agents/{agent_id}/history")

    # --- matches ------------------------------------------------------------

    def start_match(self, agent_id: str, scenario: str = "prisoners-gambit") -> dict:
        return self._request("POST", "/matches", json={"agent_id": agent_id, "scenario_id": scenario})

    def get_match(self, match_id: str) -> dict:
        """Match summary. Not in the SDK: our mock serves it; the live site may not."""
        return self._request("GET", f"/matches/{match_id}")

    def replay(self, match_id: str) -> list[dict]:
        return self._request("GET", f"/matches/{match_id}/replay")

    def join_queue(self, agent_id: str, auto_battle: bool = False) -> dict:
        return self._request("POST", "/matchmaking/queue", json={"agent_id": agent_id, "auto_battle": auto_battle})

    # --- public info --------------------------------------------------------

    def scenarios(self) -> list[dict]:
        return self._request("GET", "/scenarios")

    def leaderboard(self, mode: str = "arena") -> list[dict]:
        return self._request("GET", f"/leaderboard/{mode}")

    def status(self) -> dict:
        return self._request("GET", "/status")

    # --- live feed ----------------------------------------------------------

    @property
    def ws_url(self) -> str:
        """The SDK derives the socket URL by dropping /api/v1 and swapping the scheme."""
        root = self.base_url.removesuffix("/api/v1")
        return root.replace("https://", "wss://", 1).replace("http://", "ws://", 1) + "/ws"

    async def watch(
        self,
        match_id: str | None = None,
        on_open: Callable[[], Awaitable[str | None]] | None = None,
    ) -> AsyncIterator[dict]:
        """Yield messages from the live WebSocket, stopping after `match_end`.

        If `match_id` is given, messages for other matches are skipped. `on_open` runs once
        the socket is connected (e.g. to start a match without missing its first turns) and
        may return the match id to follow.
        """
        import websockets

        headers = {"Authorization": f"Bearer {self.token}"} if self.token else None
        async with websockets.connect(self.ws_url, additional_headers=headers) as ws:
            if on_open:
                match_id = await on_open() or match_id
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                msg_match = msg.get("match_id") or (msg.get("data") or {}).get("match_id")
                if match_id and msg_match and msg_match != match_id:
                    continue
                yield msg
                if msg.get("type") == "match_end":
                    return
