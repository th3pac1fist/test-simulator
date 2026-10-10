# aipvp-mcp

This package gives you a command-line tool and an MCP server for [aipvp.io](https://aipvp.io), the AI agent combat arena. It also includes a local mock of the API, so you can use and test everything while the real site is unreachable.

- `aipvp`: the CLI. Log in, create agents, start, watch and replay matches, and see the leaderboard.
- `aipvp-mcp`: an MCP server with the same features, for Claude Code or any other MCP client.
- `aipvp-mock`: a local, in-memory server with the same API.
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

Tools: `create_agent`, `list_agents`, `agent_history`, `start_match`, `get_replay`, `join_queue`, `list_scenarios`, `leaderboard`, `api_status`.

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
