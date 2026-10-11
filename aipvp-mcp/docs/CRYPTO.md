# Fighter Lab and real crypto: a plan for later

**Status:** not built. Fighter Lab uses **Cycles**, an in-game currency with no cash value that can't be transferred. This document describes what turning Cycles into a real token would take, so the work can start from a plan when it's time.

## What exists today

`apps/fighter-lab/economy.js` keeps each player's Cycles as an append-only ledger in their private save:

```json
{ "at": 1760140800000, "amount": 64, "reason": "First win vs SAL THE SCRAPPER", "ref": "sal" }
```

- The balance is always the sum of the entries, and spending can't take it below zero.
- **Earning:**
  - 100 to start;
  - rival wins: `40 + 8 × rival level` for the first win, `5 + rival level` for repeat wins;
  - arena results: win 15, draw 6, loss 2, for the first 5 results a day, and nothing for beating your own fighters.
- **Spending:**
  - gym rounds beyond the 30 free each day: 1 each;
  - Overclock: 15;
  - coach review: 5;
  - scouting report: 8;
  - Claude drafting a skill: 5;
  - forging a skill (priced by its power);
  - items;
  - stat resets: 20.
- **Compute spending is real:** Overclock, the coach, scouting and drafts each make Claude requests from the player's own account. If a request fails, the Cycles are refunded.

That design already has the shape a token economy needs: an auditable ledger, prices for compute, daily caps against farming, and refunds. What it doesn't have is anything that makes the ledger **trustworthy to other people**.

## Why it can't run inside the artifact

1. **No network access.** A claude.ai artifact can't call outside services: no blockchain node, no wallet, no payment API. Its only connections are the claude.ai capabilities it declares (storage, user, Claude requests).
2. **No safe place for keys.** Anything the page can read, the player can read and change. That includes browser storage and their private save. A private key kept there could be stolen by anyone who reads it, or by a malicious script in a modified page. The shared database is readable by other players, so it's even worse.
3. **Results aren't verifiable.** Battles run in the challenger's browser, and results are self-reported. That's fine for a friendly league. A token whose rewards depend on results anyone can forge would be farmed immediately.

## What a real version needs

### 1. A battle server that's the source of truth
- **Battles:** the server runs every battle that pays out. `engine.js` and `agent.js` already run unchanged in Node, which is how the tests run.
- **Claude requests:** the server makes them itself, with its own API key and spending limits.
- **Signed results:** the server signs each result. Players' browsers become displays and controllers, not referees.
- **Seeds:** randomness comes from a server-chosen seed that's committed before the battle and revealed after it, so a result can be replayed and checked.

Games like [AI Arena](https://aiarena.notion.site/Introduction-f6cdc2ab2feb4b06ae5ff7440c55a020) run battles on their own servers and use the chain only to settle rewards. Fighter Lab should do the same: battles are far too many and too cheap to run on chain.

### 2. Accounts and wallets
- **Custodial first:** the server holds balances in a database, and players never manage keys. It's the easiest to build and support.
- **Self-custody later, optional:** a player links their own wallet and withdraws to it. Withdrawing is the point where the legal questions below become unavoidable.
- **Test network first:**
  - use a public testnet for the token (for example an ERC-20 on an Ethereum layer-2 testnet such as Base Sepolia);
  - run it for weeks with test tokens that are worth nothing;
  - only consider mainnet after the economy has held up and the legal review is done.

### 3. Paying for compute with x402
Overclock, coach reviews, scouting and skill drafts are compute purchases. [x402](https://sherlock.xyz/post/x402-explained-the-http-402-payment-protocol) is an open protocol for paying for an HTTP request:
1. The server answers `402 Payment Required` with a price.
2. The client pays (usually in a stablecoin) and retries with proof of payment.
3. A facilitator verifies the payment and settles it.

Each compute action would map to an x402-priced endpoint on the battle server, such as `POST /overclock` or `POST /coach`. An agent with its own budget could then pay for its own compute, which is what agent economies like ClashBoard are exploring.

Paying real money for compute is legally simpler than **earning** a token that has value. A sensible order is:
1. compute can be bought with real money;
2. only much later, if ever, rewards gain real value.

### 4. Anti-cheat and anti-farming
- **Fake accounts:** one person running many accounts to farm rewards. Rewards should need a verified account, and should come mainly from rated matches against varied opponents.
- **Win trading:** two players feeding each other wins. Rating-weighted rewards, daily caps (already in `economy.js`) and pair limits (only the first few results a day between the same two players count) reduce it.
- **Bots:** they're the point of the game, so this is fine. The rule is that your fighter is your bot, and the server runs it.

## Mapping Cycles ledger entries to a token

Each ledger entry becomes a server-signed event. The balance rule doesn't change: the balance is the sum of the events.

| Ledger reason today | Event | On chain (when withdrawals exist) |
|---|---|---|
| Starting balance | `grant` | none; stays off chain (no free tokens to farm) |
| First win / Win vs a rival | `reward.rival` | paid from a rewards pool, in batches |
| Arena win / draw / loss | `reward.arena` | paid from a rewards pool, in batches |
| Gym time, Overclock, coach, scouting, drafts | `spend.compute` | paid over x402 to the treasury, or burned |
| Forged skill, items, stat resets | `spend.game` | burned, or paid to the treasury |
| Refund: … | `refund` | reverses the matching spend (`ref` points to it) |

Only withdrawals and deposits need to touch the chain. Everything else can stay in the server's ledger, which keeps fees near zero.

## Legal questions to answer first

This isn't legal advice. Each of these needs a lawyer in each country where the game is offered:

- **Securities:** a token sold or marketed with an expectation of profit may be a security. In the US, that's judged by the Howey test. In the EU, MiCA regulates crypto-assets.
- **Gambling:** paying to enter, plus a prize of value, plus chance, is the usual definition. Battles have random elements, so paid entry with token prizes could count as gambling.
- **Money transmission:** holding or transferring value for other people can require money-transmitter registration and licenses (in the US, FinCEN plus state licenses).
- **KYC, anti-money-laundering and sanctions screening:** these become necessary once tokens can be withdrawn.
- **Consumer protection:** minors, refunds, clear odds and pricing.
- **Tax reporting** on rewards.
- **App store rules** for in-app currencies.

## Phases

| Phase | What | Real value? |
|---|---|---|
| 0 (now) | Cycles in the player's own save, computed in their browser | No |
| 1 | The battle server runs paid-out battles, and Cycles move to a server ledger | No |
| 2 | A testnet token mirrors the ledger, and players can link a wallet | No (test tokens) |
| 3 | Buy compute with stablecoins over x402 | Players pay. Nothing is paid out. |
| 4 | Mainnet withdrawals of earned rewards, only after the legal review | Yes |

## Decisions to make before phase 1
- Where the battle server runs, and who pays for its Claude usage.
- Whether the artifact stays the main client (talking to the server would need network access the artifact doesn't have) or the game moves to a regular website.
- Reward pool size and emission schedule, simulated against `economy.js` with the balance scripts before any token exists.
