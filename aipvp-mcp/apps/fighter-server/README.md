# Fighter Lab battle server and test token

A prototype of phases 1 and 2 of [`docs/CRYPTO.md`](../../docs/CRYPTO.md):

- **A battle server:** it decides everything that changes a fighter's progress or a player's Cycles, using the same `engine.js` and `economy.js` as the claude.ai version.
- **A website:** the same game, served by that server.
- **A test token, tCYC:** "Fighter Lab Test Cycles" on the Base Sepolia test network. Players can turn Cycles into tCYC and back.

> **Test network only.** tCYC has no value, and nothing here touches real money.
> - The server refuses to start on any chain except Base Sepolia (84532) or a local dev chain (31337).
> - Mainnet is out of scope until the legal review in `CRYPTO.md`.
> - Keys in `.env` must belong to **test wallets**. Never paste a key into a chat, an issue or a commit.

The claude.ai artifact doesn't change. It still keeps Cycles in each player's own save and never talks to this server.

## Run it

You need Node 22.5 or newer (for the built-in `node:sqlite`).

```bash
cd aipvp-mcp/apps/fighter-server
npm install
npm start            # http://localhost:8787
```

**Without a token set up**, the website works in two modes:
- **Signed out:** it plays like the offline version, and everything is saved in that browser.
- **Signed in with a wallet:** your fighters and Cycles live on the server.

The wallet section of the Account box only appears once a token is configured (see below).

Sign-in uses [Sign-In with Ethereum](https://eips.ethereum.org/EIPS/eip-4361). The browser wallet signs a message, which costs nothing, and the wallet address becomes your account. It works with MetaMask or any other browser wallet with a normal (EOA) account. When needed, the site asks the wallet to switch to Base Sepolia and adds the network if the wallet doesn't know it.

## What the server decides

Every request is checked with the engine's own validators. **The browser can't set:**
- a fighter's level, XP, instincts, practice counts or records;
- prices;
- Cycles.

**What happens on the server:**

| Area | What the server does |
|---|---|
| **Designs** | Uses only files you own: basic skills, files already equipped, starter passives, or your library within your level's limit. Keeps the rulebook's clauses. Charges 20 Cycles for moving stat points you've already spent. |
| **Gym** | Training, drills and hand sparring run here. Rounds past the 30 free each day cost 1 Cycle. |
| **Rival and arena battles** | Run on rules and instincts, with no Claude. Each battle is stored with its seed and the two fighters as they were, so it replays to the same result (`GET /api/battles/:id` re-runs it and reports `verified`). Rewards, badges, drops, item use and arena ratings come only from these battles. Repeat rival rewards are capped at 10 a day. Battles against your own fighters aren't rated or paid. |
| **Forge, Codex, shop, library** | Priced and stored by the server. |
| **Cycles** | Every movement is appended to a `ledger` table in the same SQLite transaction as the change. The game checks the ledger against the wallet after every action. |

**Not on the website:** Claude features (skill drafts, the coach, scouting, Overclock, the Pro build). They stay in the claude.ai version.

## The test token

`contracts/CycleToken.sol` is an OpenZeppelin ERC-20 with nothing pre-minted.

### Withdraw: Cycles → tCYC
1. The server takes the Cycles from your ledger first.
2. In the same transaction, it records a voucher signed with its signing key (EIP-712: to, amount, nonce, deadline).
3. Your wallet calls `claim(...)`, which mints the tokens to you. You pay the test network's gas, which is free test ETH. The server never holds or sends tokens.
4. A voucher works **once**, only for the address it names, and only for an hour.
5. A voucher that expires unclaimed is refunded as Cycles. This happens only after the chain's own clock is 10 minutes past the deadline, when `claim` can no longer succeed.

### Deposit: tCYC → Cycles
1. `deposit(amount)` burns your tokens and emits `Deposited`.
2. The server watches for that event and credits the Cycles **once per event**. It keys each credit by transaction hash and log index, so a rescan can't pay twice.
3. Only whole tokens count: 1 tCYC = 1 Cycle.

### Limits
- 10 to 500 Cycles per voucher.
- 1,000 a day per account. Refunded vouchers don't count toward this.
- At most 3 unclaimed vouchers at a time.

### Rotating the signing key
1. The token's owner (the deployer) calls `setSigner(newAddress)`.
2. You update `SIGNER_KEY` in `.env`.

Vouchers signed by the old key stop working and are refunded once they expire. If `SIGNER_KEY` doesn't match the token's signer, or `RPC_URL` points at another chain, the server pauses withdrawals rather than issuing vouchers that can't be claimed.

## Deploy the token to Base Sepolia (on your computer)

The commands below need network access to Base Sepolia, so run them on your own machine.

1. **Make two fresh keys:** one for the server's voucher signer, one for a test deployer.
   ```bash
   npm run new-key   # once for SIGNER_KEY
   npm run new-key   # once for DEPLOYER_KEY
   ```
   Copy `.env.example` to `.env` and paste the keys there, and nowhere else.
2. **Get test ETH:** send a little Base Sepolia ETH to the deployer address from a faucet (see [Base's faucet list](https://docs.base.org/base-chain/tools/network-faucets)). A deploy costs a tiny amount of test ETH.
3. **Deploy:**
   ```bash
   npm run deploy
   ```
   It checks that `RPC_URL` is Base Sepolia, deploys the token with your signer's address and the deployer as owner, and prints `TOKEN_ADDRESS=…` and `START_BLOCK=…`.
4. **Configure and start:** add those two lines to `.env`, then run `npm start`. The server checks its settings against the chain, then looks for claims, expired vouchers and deposits every 15 seconds. A player's own wallet actions also trigger a check straight away.

### Settings (`.env`)

| Variable | Meaning |
|---|---|
| `PORT`, `ORIGIN` | Where the site runs. `ORIGIN` must be the exact URL players open, because sign-in messages are bound to it. |
| `CHAIN_ID` | `84532` (Base Sepolia). Anything else except `31337` is refused. |
| `RPC_URL` | A Base Sepolia RPC, such as `https://sepolia.base.org` or your provider's URL. |
| `SIGNER_KEY` | The voucher-signing key. Use it for nothing else. |
| `TOKEN_ADDRESS`, `START_BLOCK` | Printed by `npm run deploy`. |
| `DEPLOYER_KEY` | Only for `npm run deploy`. It can be removed afterwards. |
| `CONFIRMATIONS` | Blocks to wait before crediting a deposit. Default 2. |
| `DB_FILE` | SQLite file. Default `./fighter-lab.db`. |
| `TRUST_PROXY=1` | Only behind a reverse proxy that sets `X-Forwarded-For`. It's used for rate limits. |

## Security notes

- **Requests:**
  - JSON only, up to 64 KB;
  - cross-site writes are refused (the `Origin` check, plus a `SameSite=Strict`, `HttpOnly` session cookie);
  - rate limits per client IP, with a tighter one on sign-in;
  - a strict Content-Security-Policy on the page.
- **Sign-in:** single-use nonces that expire after 10 minutes, bound to this site's domain and URI and to the test chain. The signature is checked before the nonce is spent.
- **Vouchers:** the ledger is debited before a voucher exists, and only that player can see their voucher. The contract binds each voucher to `msg.sender`, a single-use nonce, a deadline and the contract's address and chain (EIP-712 domain).
- **The signing key only signs vouchers.** It holds no funds and needs no gas.

## Tests

```bash
npm test                  # server rules, sign-in, contract and wallet (in-memory chain, no network)
npm run test:website      # the real page in Chromium with a fake wallet (needs Playwright)
```

- **Contract and wallet tests:** they run on an in-memory EVM (`test/devchain.mjs`, `@ethereumjs/vm` behind a small EIP-1193 provider), so they need no network and no test ETH.
- **Website scenario:** it plays as two players:
  - sign in;
  - create, train, spar, beat Sal;
  - forge;
  - withdraw and claim tokens, then deposit some back;
  - publish, and an arena challenge from the second player;
  - reload;
  - sign out.

  It finds Playwright through `PLAYWRIGHT_MODULE`, or the copy installed for the claude.ai browser suite in `../fighter-lab/tests/browser`.
- **Contract build:** `npm run compile` rebuilds `contracts/build/CycleToken.json` with solc-js. A test fails if the committed build doesn't match the source.

## Known limits of the prototype

- **One process:** hand-sparring sessions live in memory, and SQLite is a single file. Public hosting is a later step.
- **Seeds:** battle seeds are chosen and stored by the server, but not committed in advance. Replays are only shown to the player who fought.
- **Smart-contract wallets:** sign-in checks plain EOA signatures, so smart-contract wallets aren't supported yet.
- **Midnight:** the free gym rounds reset at the server's midnight.
- **Test economy:** any Cycles can be withdrawn, including the starting 100, and tokens are minted on claim with no supply cap. That's acceptable for test tokens. Anything with value would need the reward-pool design in `CRYPTO.md`.
