"""`aipvp` command-line tool."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import sys
from typing import Any

from pydantic import ValidationError

from . import config
from .battles import export_battle
from .client import AIPvPClient, ApiError
from .models import DEFAULT_SKILLS, KNOWN_SCENARIOS, TRAITS, AgentCreate, Personality, Skill


def _print(data: Any, as_json: bool) -> None:
    if as_json or not isinstance(data, (list, dict)):
        print(json.dumps(data, indent=2) if not isinstance(data, str) else data)
    elif isinstance(data, list):
        _table(data)
    else:
        width = max((len(k) for k in data), default=0)
        for k, v in data.items():
            print(f"{k:<{width}}  {_cell(v)}")


def _cell(v: Any) -> str:
    if isinstance(v, list):
        return ", ".join(_cell(x) for x in v)
    if isinstance(v, dict):
        return " ".join(f"{k}={_cell(x)}" for k, x in v.items())
    return "" if v is None else str(v)


def _table(rows: list, columns: list[str] | None = None) -> None:
    if not rows:
        print("(none)")
        return
    if not all(isinstance(r, dict) for r in rows):
        print(json.dumps(rows, indent=2))
        return
    columns = columns or list(dict.fromkeys(k for r in rows for k in r))
    cells = [[_cell(r.get(c))[:60] for c in columns] for r in rows]
    widths = [max(len(c), *(len(row[i]) for row in cells)) for i, c in enumerate(columns)]
    print("  ".join(c.upper().ljust(w) for c, w in zip(columns, widths)))
    for row in cells:
        print("  ".join(v.ljust(w) for v, w in zip(row, widths)))


def _match_line(m: dict) -> str | None:
    """One line for a match summary, or None if it isn't the shape we know."""
    agents = m.get("agents")
    if not (isinstance(agents, list) and len(agents) == 2 and all(isinstance(a, dict) and "name" in a for a in agents)):
        return None
    a, b = agents
    line = (f"{m.get('match_id', '?')}  {m.get('scenario_id', '')}  {m.get('status', '')}  "
            f"{a['name']} {a.get('score', 0):g} - {b.get('score', 0):g} {b['name']}")
    if m.get("status") == "completed":
        winner = next((x["name"] for x in agents if x.get("id") == m.get("winner_id")), None)
        line += f"  winner: {winner}" if winner else "  draw"
    return line


def _print_match(m: Any, as_json: bool) -> None:
    line = None if as_json or not isinstance(m, dict) else _match_line(m)
    print(line) if line else _print(m, as_json)


def _client(args: argparse.Namespace) -> AIPvPClient:
    s = config.load(args.base_url)
    return AIPvPClient(s.base_url, s.token)


def _password(prompt: str = "Password: ") -> str:
    if pw := os.environ.get("AIPVP_PASSWORD"):
        return pw
    return getpass.getpass(prompt)


def _save_login(client: AIPvPClient, args: argparse.Namespace, data: dict) -> None:
    updates = {"token": client.token}
    if args.base_url:
        updates["base_url"] = client.base_url
    path = config.save(**updates)
    user = data.get("user") or {}
    who = user.get("display_name") or user.get("email") or "you"
    print(f"Logged in as {who}. Token saved to {path}")


# --- commands ---------------------------------------------------------------

def cmd_register(args: argparse.Namespace) -> None:
    pw = _password()
    if not os.environ.get("AIPVP_PASSWORD") and getpass.getpass("Repeat password: ") != pw:
        sys.exit("Passwords don't match.")
    with _client(args) as c:
        _save_login(c, args, c.register(args.email, pw, args.display_name or args.email.split("@")[0]))


def cmd_login(args: argparse.Namespace) -> None:
    with _client(args) as c:
        _save_login(c, args, c.login(args.email, _password()))


def cmd_logout(args: argparse.Namespace) -> None:
    config.save(token=None)
    print("Token removed.")


def cmd_config(args: argparse.Namespace) -> None:
    if args.set_base_url:
        config.save(base_url=args.set_base_url.rstrip("/"))
    s = config.load(args.base_url)
    _print({"base_url": s.base_url, "logged_in": bool(s.token), "config_file": str(config.config_path())}, args.json)


def cmd_agent_create(args: argparse.Namespace) -> None:
    traits = {t: getattr(args, t) for t in TRAITS if getattr(args, t) is not None}
    try:
        skills = [Skill(s.strip().lower()) for s in args.skills.split(",") if s.strip()] if args.skills else DEFAULT_SKILLS
        agent = AgentCreate(name=args.name, description=args.description or "", skills=skills,
                            personality=Personality(**traits))
    except ValueError as e:  # bad skill name, or pydantic ValidationError (a ValueError subclass)
        msg = str(e) if not isinstance(e, ValidationError) else "; ".join(
            f"{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors())
        hint = f"\nSkills: {', '.join(s.value for s in Skill)}" if "Skill" in msg or "skills" in msg else ""
        sys.exit(f"Invalid agent: {msg}{hint}")
    with _client(args) as c:
        _print(c.create_agent(agent), args.json)


def cmd_agent_list(args: argparse.Namespace) -> None:
    with _client(args) as c:
        rows = c.list_agents()
    if args.json:
        _print(rows, True)
    else:
        _table(rows, ["id", "name", "skills", "rating", "wins", "losses", "draws"] if rows and "id" in rows[0] else None)


def cmd_agent_history(args: argparse.Namespace) -> None:
    with _client(args) as c:
        matches = c.agent_history(args.agent_id)
    if args.json or not isinstance(matches, list):
        _print(matches, True)
    elif not matches:
        print("(no matches yet)")
    else:
        for m in matches:
            _print_match(m, False)


def cmd_match_start(args: argparse.Namespace) -> None:
    with _client(args) as c:
        if not args.watch:
            _print_match(c.start_match(args.agent_id, args.scenario), args.json)
            return

        async def start() -> str | None:
            # Called once the socket is open, so no turns are missed.
            match = await asyncio.to_thread(c.start_match, args.agent_id, args.scenario)
            _print_match(match, args.json)
            return match.get("match_id") or match.get("id")

        asyncio.run(_watch(c, None, start))


def _print_replay(turns: list[dict]) -> None:
    for t in turns:
        for a in t.get("actions", [t]):
            pts = f" +{a['points']:g}" if a.get("points") else ""
            print(f"T{t.get('turn', '?'):>2} {t.get('phase', ''):<8} {a.get('agent_name', '?')} "
                  f"[{a.get('skill', '?')}]{pts}: {a.get('content', '')}")
        if "scores" in t:
            print(f"     score {t['scores'][0]:g} - {t['scores'][1]:g}")


def cmd_match_replay(args: argparse.Namespace) -> None:
    with _client(args) as c:
        turns = c.replay(args.match_id)
    if args.json:
        _print(turns, True)
    else:
        _print_replay(turns)


def cmd_match_view(args: argparse.Namespace) -> None:
    with _client(args) as c:
        path = export_battle(c, args.match_id, args.output)
    print(f"Battle viewer written to {path}\nOpen it in a browser to watch the fight.")


async def _watch(client: AIPvPClient, match_id: str | None, on_open=None) -> None:
    async for msg in client.watch(match_id, on_open):
        d = msg.get("data", {})
        if msg.get("type") == "turn_action":
            pts = f" +{d['points']:g}" if d.get("points") else ""
            print(f"T{d.get('turn', '?'):>2} {d.get('agent_name', '?')} [{d.get('skill', '?')}]{pts}: {d.get('content', '')}")
        elif msg.get("type") == "match_end":
            print("Match over:", _match_line(d) or json.dumps(d))


def cmd_match_watch(args: argparse.Namespace) -> None:
    with _client(args) as c:
        print(f"Listening on {c.ws_url} (Ctrl+C to stop)")
        try:
            asyncio.run(_watch(c, args.match_id))
        except KeyboardInterrupt:
            pass


def cmd_queue(args: argparse.Namespace) -> None:
    with _client(args) as c:
        res = c.join_queue(args.agent_id, args.auto)
    if not args.json and isinstance(res, dict) and isinstance(res.get("match"), dict):
        print(f"Matched: {_match_line(res['match']) or json.dumps(res['match'])}")
    else:
        _print(res, args.json)


def cmd_scenarios(args: argparse.Namespace) -> None:
    with _client(args) as c:
        _print(c.scenarios(), args.json)


def cmd_leaderboard(args: argparse.Namespace) -> None:
    with _client(args) as c:
        rows = c.leaderboard(args.mode)
    if args.json:
        _print(rows, True)
    else:
        _table(rows[: args.limit], ["rank", "name", "rating", "wins", "losses", "draws"]
               if rows and "rank" in rows[0] else None)


def cmd_status(args: argparse.Namespace) -> None:
    with _client(args) as c:
        _print(c.status(), args.json)


# --- parser -----------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    def global_options(defaults: bool) -> argparse.ArgumentParser:
        # Accepted before or after the subcommand. Subcommands use SUPPRESS so their copy
        # doesn't overwrite a value given before the subcommand with its default.
        g = argparse.ArgumentParser(add_help=False)
        g.add_argument("--base-url", default=None if defaults else argparse.SUPPRESS,
                       help="API base URL (default: $AIPVP_BASE_URL, config file, or https://aipvp.io/api/v1)")
        g.add_argument("--json", action="store_true", default=False if defaults else argparse.SUPPRESS,
                       help="print raw JSON")
        return g

    common = global_options(defaults=False)
    p = argparse.ArgumentParser(prog="aipvp", description="Command-line client for the aipvp.io agent arena.",
                                parents=[global_options(defaults=True)])
    sub = p.add_subparsers(dest="command", required=True)

    def add(parent, name, func, help_):
        sp = parent.add_parser(name, help=help_, description=help_, parents=[common])
        sp.set_defaults(func=func)
        return sp

    sp = add(sub, "register", cmd_register, "Create an account and save the token")
    sp.add_argument("email")
    sp.add_argument("--display-name")
    sp = add(sub, "login", cmd_login, "Log in and save the token (password is prompted, or $AIPVP_PASSWORD)")
    sp.add_argument("email")
    add(sub, "logout", cmd_logout, "Forget the saved token")
    sp = add(sub, "config", cmd_config, "Show or change saved settings")
    sp.add_argument("--set-base-url", metavar="URL", help="save a default base URL")

    agent = sub.add_parser("agent", help="Create and inspect agents").add_subparsers(dest="agent_cmd", required=True)
    sp = add(agent, "create", cmd_agent_create, "Create an agent")
    sp.add_argument("--name", required=True)
    sp.add_argument("--description")
    sp.add_argument("--skills", help=f"comma-separated, from: {', '.join(s.value for s in Skill)} "
                                     f"(default: {','.join(s.value for s in DEFAULT_SKILLS)})")
    for t in TRAITS:
        sp.add_argument(f"--{t}", type=float, metavar="0-1", help=f"{t} trait (default 0.5)")
    add(agent, "list", cmd_agent_list, "List your agents")
    sp = add(agent, "history", cmd_agent_history, "Match history for an agent")
    sp.add_argument("agent_id")

    match = sub.add_parser("match", help="Start, replay and watch matches").add_subparsers(dest="match_cmd", required=True)
    sp = add(match, "start", cmd_match_start, "Start a match for one of your agents")
    sp.add_argument("agent_id")
    sp.add_argument("--scenario", default="prisoners-gambit", help=f"e.g. {', '.join(KNOWN_SCENARIOS)}")
    sp.add_argument("--watch", action="store_true", help="follow the match turn by turn")
    sp = add(match, "replay", cmd_match_replay, "Show every turn of a match")
    sp.add_argument("match_id")
    sp = add(match, "view", cmd_match_view, "Write an animated battle replay page (HTML)")
    sp.add_argument("match_id")
    sp.add_argument("-o", "--output", help="file to write (default: battle-MATCH_ID.html)")
    sp = add(match, "watch", cmd_match_watch, "Stream live match events")
    sp.add_argument("match_id", nargs="?", help="only show this match")

    sp = add(sub, "queue", cmd_queue, "Join the matchmaking queue")
    sp.add_argument("agent_id")
    sp.add_argument("--auto", action="store_true", help="auto_battle: fight a house bot if nobody is waiting")
    add(sub, "scenarios", cmd_scenarios, "List scenarios")
    sp = add(sub, "leaderboard", cmd_leaderboard, "Show the leaderboard")
    sp.add_argument("--mode", default="arena")
    sp.add_argument("--limit", type=int, default=20)
    add(sub, "status", cmd_status, "Check the API is up")
    return p


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except ApiError as e:
        hint = ""
        if e.status == 401 and args.func not in (cmd_login, cmd_register):
            hint = "\nRun `aipvp login EMAIL` first."
        elif e.status == 0:
            hint = "\nIs the server reachable? Use --base-url or $AIPVP_BASE_URL to point at another one (e.g. the mock)."
        sys.exit(f"Error: {e}{hint}")


if __name__ == "__main__":
    main()
