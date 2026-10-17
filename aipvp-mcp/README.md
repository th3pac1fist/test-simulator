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

`apps/fighter-lab/` is a browser game, published as a claude.ai Artifact, built on top of the battle viewer. Every fighter is an AI agent. In a battle, Claude picks each action for both fighters, turn by turn.

- **A fighter** is made of:
  - a look;
  - a **loadout**: 4 skills, 1 passive and 1 held item;
  - **stats**: a point per level for Power (+3% damage), Vitality (+4% max HP) or Speed (+2% chance to dodge an attack, up to 40%);
  - up to 4 **battle rules** (if-then, like Gladiabots);
  - a **persona** you write ("how it thinks");
  - a **playbook** of lessons, written by an AI coach;
  - **instincts**, a small reinforcement-learning policy trained in the gym.

  Claude reads all of this before every action. Rules fire first and skip Claude entirely.
- **Combat:**
  - **Styles:** four, each beating the next: Aggro → Social → Mind → Guard → Aggro (×2 effective, ×0.5 resisted).
  - **Energy:** start with 3, gain 2 a turn, hold up to 10. Basic skills cost 0–2 and forged skills up to 7.
  - **Cooldowns** on strong skills.
  - **Statuses:** burn, poison, stun (followed by a turn of stun immunity), shield, regen, weaken and focus.
  - **Turn order:** priority skills first, then the faster fighter.
  - **Items** (one use per battle): Potion (heals 15% of max HP), Ether, Antidote, Smoke Bomb.
  - **Scaling:** shields, heals, burn and poison grow with level, like damage.
  - **Length:** 12 turns or a knockout.
- **Skill files:** a skill is JSON made from a fixed set of effects, so it always makes sense:
  ```json
  { "name": "FIREBALL", "style": "aggro", "element": "fire", "kind": "active",
    "effects": [ {"type": "damage", "power": 3}, {"type": "burn", "chance": 0.3, "damage": 2, "turns": 3} ] }
  ```
  - The game prices every skill from its effects (`priceSkill`). The price sets its energy cost and cooldown.
  - A level cap limits how strong a skill can be, so stronger skills unlock as your fighter levels up.
  - Simulations check that equal-power skills win about equally often.
- **Skill Forge** (Forge tab): two ways to make a skill.
  - **Build it** from effect blocks, watching the price update live.
  - **Describe it** ("shoots fireballs that set them on fire"): Claude drafts the file, then the game validates it, drops anything invented and scales it down to your level.
- **Cycles**, the in-game currency (`economy.js`):
  - **Earn:** rival wins (a big reward the first time), arena results (capped per day, nothing for beating your own fighters), and 100 to start.
  - **Spend on:**
    - gym rounds after the 30 free each day;
    - compute: Overclock (Claude's bigger model for a battle), coach reviews, scouting reports, skill drafts;
    - forging, items, stat resets.
  - **Ledger:** append-only, and the balance can't go negative.
  - **No cash value:** Cycles can't be transferred. [`docs/CRYPTO.md`](docs/CRYPTO.md) is the plan for a real token later.
- **Rulebook** (`RULEBOOK` and `validateLoadout` in `engine.js`, shown in the Forge tab):
  - **File rules:** only listed effects, at most 3 per file, numbers within range, and power within the level limit. The game sets the price.
  - **Unlocks:**
    - Everyone starts with damage, burn, shield and heal skills, plus regen and starting-shield passives.
    - Each rival's first win earns a **badge** that unlocks more (like Pokémon gym badges). Sal's badge opens the weapon slot.
    - The **Codex** sells any family early for `60 + 15 × that rival's level` Cycles (like Hearthstone crafting).
    - Real wins can **drop** a ready-made blueprint into your library; duplicates become Cycles (like Clash Royale chests).
  - **Weapons:** a new slot and a fourth file type, with these effects:
    - edge (+damage for one style);
    - burn or poison riders;
    - critical hits;
    - lifesteal;
    - guard (blocks part of the first hit each turn);
    - evade.
  - **Practice before battle** (like Final Fantasy IX's AP):
    - New files are "in training" until practiced: skills need `10 + 8 × power` uses, passives and weapons `3 + 2 × power` practice battles.
    - Sparring by hand counts double, and a Drill makes the fighter use one skill whenever it can.
    - Rival and arena battles need a battle-ready loadout. Once proven, a file stays battle-ready.
  - **Clauses** (like Smogon's competitive Pokémon rules), enforced in loadouts, battles and the arena:
    - one stun skill per loadout;
    - no two skills sharing a special effect;
    - at most 50% of max HP healed per battle;
    - one action deals at most 40% of the target's max HP.
- **Balance, checked by simulation** (`engine.test.mjs`, `optimizer.test.mjs`):
  - Power, Vitality and Speed are all percentages, so they're worth about the same at levels 4, 15 and 35.
  - The Potion helps about as much as the Smoke Bomb.
  - Effect prices (`PRICE` in `engine.js`) are calibrated so forged skills of equal power win about equally often. Shields are strongest early on and weaken effects late in the game.
  - Weapon prices (`WPRICE`) are calibrated the same way.
- **Pro build** (`optimizer.js`, owner only):
  - **Who sees it:** the artifact's owner (`user.isOwner()`) gets a Pro build box in the Design tab. It only hides the UI: every viewer gets the same page code. The builds it makes are legal anyway, and arena skills are re-checked when they arrive.
  - **What it can use:** only what's legal at the fighter's level, unlocked, within the clauses, and affordable with your Cycles:
    - basic and owned skills;
    - skills to forge, from archetypes scaled to your power limit;
    - passives, weapons, items paired with matching rules, and stat splits.
  - **Practice plan:** its result includes how many drill rounds the new files need.
  - **How it searches:** in stages:
    1. Screen every loadout covering the four styles.
    2. Try forged skills one slot at a time, then combine the best.
    3. Add a passive, an item with rules, stats and a finisher rule.
    4. Run finals with several seeds.
  - **What it tests against:**
    - your next rivals;
    - the gym partners;
    - published arena fighters, shown to Claude only by number;
    - a field of random legal builds standing in for other players;
    - a round-robin among the finalists.
  - **What you get:**
    - win rates against the current build;
    - reasons;
    - training tips;
    - a level-up path: what to forge or re-forge at each milestone.
  - **Apply:** forges and buys through the normal Cycles flow and fills the Design form; you press Save.
  - **Write its mind:** Claude writes a persona and playbook for the build (5 Cycles).
- **Getting stronger:**
  - **Gym practice** is instant and uses no Claude. It builds XP and levels (capped at 50), skill mastery (up to +50%) and instincts.
  - **Spar by hand:** you choose every action, and the instincts learn by copying you (imitation learning, as in AI Arena).
  - **Real battles** give 3× XP and also train instincts.
- **Rivals:** a ladder of 7 Claude-powered rivals, from level 3 to 35, each with its own skills, persona and pre-trained instincts. Beat one to unlock the next.
- **Arena:** players publish fighters and challenge each other's, with an Elo leaderboard.
  - Each player writes only their own `arena/<id>` and `results/<id>` documents.
  - Everything read from the arena is validated, and custom skills are re-priced on arrival, so a hand-edited file can't cheat.
  - Results are worked out in the challenger's browser, so it's a friendly league, not a tamper-proof one.
- **Built to fail safely:**
  - **Saves never block the game:** they go to the browser first, then to the account in the background.
  - **Accounts stay separate:** the on-device backup is tagged with its account, so two accounts on one browser never share fighters or Cycles.
  - **Claude requests:**
    - at most 2 run at once, and nothing is retried in a loop;
    - an illegal or failed choice falls back to instincts;
    - a failed paid request is refunded.
  - **Your fighter's prompt** never contains an opponent's persona, playbook, lines or custom skill names; their skills are described in the game's own words.
  - **Shared text** is rendered as text, not HTML.
- **Code:**
  - `engine.js`: rules, skills and pricing, instincts, training, rivals, arena helpers; no DOM.
  - `economy.js`: the Cycles ledger, prices and rewards.
  - `optimizer.js`: the Pro build search; no DOM.
  - `agent.js`: prompts, reply parsing, the AI battle runner, skill drafts, scouting and the coach. It takes a `sample` function, so tests can pass in a fake.
  - `sprites.js`: the pixel creatures.
  - `app.js`: the UI.
  - `index.html`: layout and styles.
- **Tests:** `node --test apps/fighter-lab/*.test.mjs`. They cover:
  - skill pricing and validation, status effects, rules and migration of older saves;
  - balance simulations;
  - ledger math and daily caps;
  - the AI runner's fallbacks, and that opponents' text stays out of prompts.

## Fighter Lab website, battle server and test token

`apps/fighter-server/` is a prototype of phases 1 and 2 of [`docs/CRYPTO.md`](docs/CRYPTO.md). It runs on a **test network only** (Base Sepolia), so nothing has real value. It has three parts:

- **A battle server:** it owns fighters and the Cycles ledger, and runs battles that pay out, on rules and instincts, with replayable seeds.
- **A website:** the same game, played with wallet sign-in.
- **tCYC:** an ERC-20 test token. Players can withdraw Cycles as signed vouchers they claim, and deposit tokens back as Cycles.

The claude.ai artifact is unchanged. Setup, deploying the token with your own test wallet, and security notes are in [its README](apps/fighter-server/README.md).

## Mock server

`aipvp-mock [--port 8787] [--turn-delay 0.5]`

It keeps users, agents and matches in memory, so they're lost when it stops. It starts with three house-bot opponents. Each match plays 12 turns using the SDK's scoring table, and every turn is streamed over `ws://127.0.0.1:8787/ws`. Set `--turn-delay 0` to make matches finish instantly. See [`docs/API.md`](docs/API.md) for exactly what the mock does and what is confirmed about the real API.

## Development

```bash
pip install -e '.[dev]'
pytest                            # client, CLI and MCP tests, all against a real mock server
python scripts/gen_openapi.py     # regenerate docs/openapi.json after changing the mock
```

## Testing

Everything below also runs in CI (`.github/workflows/aipvp-mcp.yml`) on every push and pull request that touches `aipvp-mcp/`.

| What | Command (from `aipvp-mcp/`) |
|---|---|
| CLI, MCP server and mock | `pytest` |
| Fighter Lab rules, economy, prompts, optimizer and balance | `node --test apps/fighter-lab/*.test.mjs` |
| Fighter Lab in a headless browser | `cd apps/fighter-lab/tests/browser && npm ci && npx playwright install chromium && node run.cjs` |
| Fighter Lab server, sign-in, test token contract and wallet (in-memory chain) | `cd apps/fighter-server && npm ci && npm test` |
| Fighter Lab website with the server and a fake wallet | `cd apps/fighter-server && npm run test:website` (after the browser suite's `npm ci`) |

The browser suite runs about 110 checks in Chromium against a fake claude.ai platform (`tests/browser/fake-claude.js`). The fake provides storage, the signed-in user and a stand-in Claude. Several pages share one fake database, so the checks can play as several people. It covers:
- saving while storage hangs;
- moving to a new account;
- the forge, Codex, badges and drops;
- practice gates and drills;
- weapons and clauses;
- rival battles, Overclock and scouting;
- the arena, including hostile entries;
- the Pro build;
- what happens when Claude is declined or unavailable;
- phone and desktop layouts.

`run.cjs` builds the test page, serves it on a free port and exits non-zero if any check fails. Screenshots land in `tests/browser/out/`. Set `PLAYWRIGHT_MODULE` to point at an existing Playwright install and skip `npm ci`.

The balance tools in `apps/fighter-lab/tools/` (see its README) are the simulations used to tune skill and weapon prices, stats, items and the rival ladder.

## Switching to the live site

1. Make sure `aipvp.io` resolves, and that your network allows it.
2. Run `aipvp --base-url https://aipvp.io/api/v1 status`. This is also the default, so the flag only matters if you saved a different one.
3. Run `aipvp login`, then `aipvp agent create …`. If a response has a different shape from the mock's, `--json` shows the raw data. The CLI's table output adapts to whatever fields come back.
