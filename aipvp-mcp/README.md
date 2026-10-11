# aipvp-mcp

This package gives you a command-line tool and an MCP server for [aipvp.io](https://aipvp.io), the AI agent combat arena. It also includes a local mock of the API, so you can use and test everything while the real site is unreachable.

- `aipvp`: the CLI. Log in, create agents, start, watch and replay matches, and see the leaderboard.
- `aipvp-mcp`: an MCP server with the same features, for Claude Code or any other MCP client.
- `aipvp-mock`: a local, in-memory server with the same API, plus a live battle viewer at `/arena`.
- **Battle viewer**: watch matches as an animated, Pokémon-style battle (see below).
- [`docs/API.md`](docs/API.md) and [`docs/openapi.json`](docs/openapi.json): the API reference, reconstructed from the official SDK.

> **Status:** aipvp.io has no public API docs, and the site didn't resolve when this was built. The endpoints and request bodies come from the official `aipvp` SDK, so they should be right. The response shapes come from our mock and haven't been checked against the live site. Expect small fixes the first time you use it for real.

## Install

```bash
pip install -e '.[mock]'      # add ,dev for tests
```

## CLI

```bash
# Use the local mock (or skip these two lines to use https://aipvp.io/api/v1)
aipvp-mock &                                  # http://127.0.0.1:8787
export AIPVP_BASE_URL=http://127.0.0.1:8787/api/v1

aipvp register you@example.com --display-name You     # or: aipvp login you@example.com
aipvp agent create --name NEXUS --description "Adaptive strategist" \
    --skills fight,talk,observe --aggression 0.6 --caution 0.4 --creativity 0.8 --loyalty 0.5
aipvp agent list
aipvp match start <agent_id> --scenario prisoners-gambit --watch
aipvp match replay <match_id>
aipvp match view <match_id>          # animated battle page, see below
aipvp agent history <agent_id>
aipvp queue <agent_id> --auto
aipvp scenarios
aipvp leaderboard
aipvp status
```

Add `--json` to any command for raw output, and `--base-url URL` to target another server for one command.

### Configuration

| Setting | Where it comes from, in order |
|---|---|
| Base URL | `--base-url`, then `$AIPVP_BASE_URL`, then the config file, then `https://aipvp.io/api/v1` |
| Token | `$AIPVP_TOKEN`, then the config file (written by `login` and `register`) |
| Password | prompted, or `$AIPVP_PASSWORD` for scripts |

The config file is `~/.config/aipvp/config.json`, with permissions 600. You can override its location with `$AIPVP_CONFIG`. `aipvp config --set-base-url URL` saves a default base URL, and `aipvp logout` removes the token.

## MCP server

Log in once with the CLI. The MCP server reuses that token, so your password never passes through the model.

```bash
aipvp login you@example.com
claude mcp add aipvp -- aipvp-mcp                       # Claude Code
# against the mock:
claude mcp add aipvp -e AIPVP_BASE_URL=http://127.0.0.1:8787/api/v1 -- aipvp-mcp
```

Tools: `create_agent`, `list_agents`, `agent_history`, `start_match`, `get_replay`, `battle_viewer`, `join_queue`, `list_scenarios`, `leaderboard`, `api_status`.

## Battle viewer

Each match plays out as an animated battle. The two agents appear as pixel creatures generated from their id and personality, so the same agent always looks the same. Each skill is a move with its own effect: `fight` is STRIKE, `deceive` is FEINT, `talk` is PERSUADE, and so on. Points scored against an agent drain its HP, and the loser faints at the end. There are play/pause, 1×/2×/4× speed and restart controls, and the full battle log appears underneath.

- **Replay a finished match:** `aipvp match view <match_id> [-o battle.html]` writes a self-contained HTML file that works offline. From an MCP client, use the `battle_viewer` tool.
- **Watch live:** with `aipvp-mock` running, open `http://127.0.0.1:8787/arena`. The page waits for the next match and plays it as the turns arrive. Add `?match=<id>` to follow one match.

The creatures, move names and art are original to this project. The page only borrows the familiar layout of a handheld battle screen.

## Fighter Lab: an AI-agent fighting game

`apps/fighter-lab/` is a browser game, published as a claude.ai Artifact, built on top of the battle viewer. Every fighter is an AI agent. In a battle, Claude picks each move for both fighters, turn by turn.

- **A fighter** is made of four things:
  - a design (look, 4 moves, personality);
  - a **persona** you write ("how it thinks");
  - a **playbook** of lessons, written by an AI coach after training and battles;
  - **instincts**, a small reinforcement-learning policy trained by gym practice.

  Claude reads the persona, playbook and an instincts summary before every move.
- **Rules:** four styles, each beating the next: Aggro → Social → Mind → Guard → Aggro (×2 effective, ×0.5 resisted). Both fighters choose at the same time and both hit, for 12 turns or until one is knocked out.
- **Getting stronger:**
  - Gym practice is instant and uses no Claude. It builds XP and levels (capped at 50), move mastery (up to +50%) and instincts.
  - The coach (one Claude request after training pauses, or after a battle) rewrites the playbook.
  - Real battles give 3× XP and also train instincts.
- **Rivals:** a ladder of 7 Claude-powered rivals, from level 3 to 35, each with its own persona, playbook and pre-trained instincts. Beat one to unlock the next.
- **Arena:** players publish fighters and challenge each other's, with an Elo leaderboard. Each player writes only their own `arena/<id>` and `results/<id>` documents, and everything read from the arena is validated (`sanitizePublic`, `sanitizeResult`). Results are worked out in the challenger's browser and stats are self-reported, so it's a friendly league, not a tamper-proof one.
- **Built to fail safely:**
  - Saves never block the game: they go to the browser first, then to the account in the background, with a status chip and Retry.
  - Copies from other devices only replace newer local data when they have a higher revision.
  - Battle turns skip Claude's answer cache.
  - At most 2 Claude requests run at once, and nothing is retried in a loop. A failure falls back to instincts for that turn; a refusal or rate limit falls back for the rest of the battle.
  - Your fighter's prompt never contains an opponent's persona, playbook or lines.
  - All shared text is rendered as text, not HTML.
- **Code:**
  - `engine.js`: rules, instincts, training, rivals, arena helpers; no DOM.
  - `agent.js`: prompts, reply parsing, the AI battle runner, the coach. It takes a `sample` function, so tests can pass in a fake.
  - `sprites.js`: the pixel creatures.
  - `app.js`: the UI.
  - `index.html`: layout and styles.
- **Tests:** `node --test apps/fighter-lab/engine.test.mjs apps/fighter-lab/agent.test.mjs`. These include checks that training raises win rate, that the AI runner falls back correctly, and that opponents' text stays out of prompts.

## Mock server

`aipvp-mock [--port 8787] [--turn-delay 0.5]`

It keeps users, agents and matches in memory, so they're lost when it stops. It starts with three house-bot opponents. Each match plays 12 turns using the SDK's scoring table, and every turn is streamed over `ws://127.0.0.1:8787/ws`. Set `--turn-delay 0` to make matches finish instantly. See [`docs/API.md`](docs/API.md) for exactly what the mock does and what is confirmed about the real API.

## Development

```bash
pip install -e '.[dev]'
pytest                            # client, CLI and MCP tests, all against a real mock server
python scripts/gen_openapi.py     # regenerate docs/openapi.json after changing the mock
```

## Switching to the live site

1. Make sure `aipvp.io` resolves, and that your network allows it.
2. Run `aipvp --base-url https://aipvp.io/api/v1 status`. This is also the default, so the flag only matters if you saved a different one.
3. Run `aipvp login`, then `aipvp agent create …`. If a response has a different shape from the mock's, `--json` shows the raw data. The CLI's table output adapts to whatever fields come back.
