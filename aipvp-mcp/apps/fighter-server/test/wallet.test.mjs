// Cycles <-> test tokens through the server, against the token on an in-memory chain. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startServer, signIn, client } from "./helpers.mjs";
import { deployToken, randomAddress, OWNER } from "./token-helpers.mjs";
import { chainModule, WALLET_LIMITS, UNIT } from "../src/chain.mjs";
import { ECON } from "../src/game.mjs";

/** A server wired to a freshly deployed token, plus one signed-in player. */
async function setup() {
  const t = await deployToken();
  const app = await startServer({ chain: chainModule({ token: t.token, signerKey: t.signerKey, transport: t.transport, confirmations: 0 }) });
  const c = await signIn(app.base);
  return { t, app, c };
}
const grant = (app, address, n) => app.game.act(address, (p, now) => { p.wallet = ECON.credit(p.wallet, n, "test grant", null, now); });
const claimVoucher = (t, from, v) => t.sendTx(from, v.claim);
const balance = async (c) => (await c.get("/api/state")).body.progress.balance;

test("withdraw: Cycles leave the ledger first, the voucher claims tokens once, and the server sees it", async () => {
  const { t, app, c } = await setup();
  try {
    const me = await c.get("/api/me");
    assert.equal(me.body.chain.token, t.token);
    const w = await c.post("/api/wallet/withdraw", { cycles: 25 });
    assert.equal(w.status, 200, w.text);
    assert.equal(w.body.progress.balance, ECON.START - 25, "debited before the voucher exists");
    assert.equal(app.store.ledgerSum(c.address), ECON.START - 25);
    const v = w.body.voucher;
    assert.equal(v.to, c.address); assert.equal(v.amount, (25n * UNIT).toString()); assert.equal(v.status, "issued");
    assert.equal((await claimVoucher(t, c.address, v)).status, "success");
    assert.equal(await t.read("balanceOf", [c.address]), 25n * UNIT);
    assert.equal(await t.revertName(c.address, "claim", [BigInt(v.amount), BigInt(v.nonce), BigInt(v.deadline), v.signature]), "VoucherUsed");
    const s = await c.post("/api/wallet/sync");
    assert.equal(s.status, 200, s.text);
    assert.equal(s.body.withdrawals[0].status, "claimed");
    assert.equal(s.body.tokenBalance, (25n * UNIT).toString());
    assert.equal(s.body.withdrawals[0].claim, null, "no claim button for a claimed voucher");
  } finally { await app.close(); }
});

test("withdraw limits: amount range, balance, open vouchers and the daily cap", async () => {
  const { app, c } = await setup();
  try {
    for (const cycles of [WALLET_LIMITS.min - 1, WALLET_LIMITS.max + 1, 12.5, "lots", -20]) {
      assert.equal((await c.post("/api/wallet/withdraw", { cycles })).status, 400, String(cycles));
    }
    const broke = await c.post("/api/wallet/withdraw", { cycles: 200 });
    assert.equal(broke.status, 400); assert.match(broke.body.error, /Not enough Cycles/);
    assert.equal(app.store.withdrawals(c.address).length, 0, "a refused withdrawal leaves no voucher behind");
    grant(app, c.address, 5000);
    for (let i = 0; i < WALLET_LIMITS.open; i++) assert.equal((await c.post("/api/wallet/withdraw", { cycles: 10 })).status, 200);
    const open = await c.post("/api/wallet/withdraw", { cycles: 10 });
    assert.equal(open.status, 400); assert.match(open.body.error, /vouchers waiting/);
    // the daily cap counts every voucher issued in the last 24 hours
    const c2 = await signIn(app.base);
    grant(app, c2.address, 5000);
    assert.equal((await c2.post("/api/wallet/withdraw", { cycles: WALLET_LIMITS.max })).status, 200);
    assert.equal((await c2.post("/api/wallet/withdraw", { cycles: WALLET_LIMITS.daily - WALLET_LIMITS.max })).status, 200);
    const capped = await c2.post("/api/wallet/withdraw", { cycles: WALLET_LIMITS.min });
    assert.equal(capped.status, 400); assert.match(capped.body.error, /a day/);
    assert.equal(app.store.ledgerSum(c2.address), ECON.START + 5000 - WALLET_LIMITS.daily);
    assert.equal((await client(app.base).post("/api/wallet/withdraw", { cycles: 10 })).status, 401);
  } finally { await app.close(); }
});

test("expiry: an unclaimed voucher is refunded once, after it can no longer be claimed", async () => {
  const { t, app, c } = await setup();
  try {
    const v = (await c.post("/api/wallet/withdraw", { cycles: 20 })).body.voucher;
    assert.equal(await balance(c), ECON.START - 20);
    t.chain.increaseTime(WALLET_LIMITS.ttl + 5); await t.chain.mine();
    let r = await app.chain.sync();
    assert.equal(r.refunded, 0, "past the deadline but inside the grace period: not yet");
    t.chain.increaseTime(WALLET_LIMITS.refundGrace); await t.chain.mine();
    r = await app.chain.sync();
    assert.equal(r.refunded, 1);
    assert.equal(await balance(c), ECON.START);
    assert.equal(app.store.withdrawal(v.nonce).status, "refunded");
    assert.equal(await t.revertName(c.address, "claim", [BigInt(v.amount), BigInt(v.nonce), BigInt(v.deadline), v.signature]), "VoucherExpired", "and it can't be claimed any more");
    assert.equal((await app.chain.sync()).refunded, 0, "never twice");
    assert.equal(await balance(c), ECON.START);
    assert.equal(app.store.ledgerSum(c.address), ECON.START);
    // refunds don't count toward the daily cap
    assert.equal(app.store.withdrawnSince(c.address, 0), 0);
  } finally { await app.close(); }
});

test("deposit: burning tokens credits Cycles exactly once per event", async () => {
  const { t, app, c } = await setup();
  try {
    const v = (await c.post("/api/wallet/withdraw", { cycles: 30 })).body.voucher;
    await claimVoucher(t, c.address, v);
    const tx = await c.get("/api/wallet/deposit?cycles=12");
    assert.equal(tx.status, 200);
    assert.equal(tx.body.to, t.token);
    assert.equal((await t.sendTx(c.address, tx.body)).status, "success");
    const before = await balance(c);
    assert.equal((await app.chain.sync()).deposits, 1);
    assert.equal(await balance(c), before + 12);
    assert.equal((await app.chain.sync()).deposits, 0, "the same event isn't credited again");
    app.store.set("deposits.next", "0");       // even if the scan starts over from block 0
    assert.equal((await app.chain.sync()).deposits, 0);
    assert.equal(await balance(c), before + 12);
    assert.equal(app.store.ledgerSum(c.address), before + 12);
    assert.equal(await t.read("balanceOf", [c.address]), 18n * UNIT);
    assert.equal((await c.get("/api/wallet/deposit?cycles=0")).status, 400);
  } finally { await app.close(); }
});

test("deposit from a wallet that never played makes its account", async () => {
  const { t, app, c } = await setup();
  try {
    const v = (await c.post("/api/wallet/withdraw", { cycles: 15 })).body.voucher;
    await claimVoucher(t, c.address, v);
    const stranger = randomAddress();
    await t.send(c.address, "transfer", [stranger, 15n * UNIT]);
    await t.send(stranger, "deposit", [15n * UNIT]);
    await app.chain.sync();
    assert.equal(app.store.ledgerSum(stranger), ECON.START + 15);
  } finally { await app.close(); }
});

test("deposit: confirmations hold back the newest blocks", async () => {
  const t = await deployToken();
  const app = await startServer({ chain: chainModule({ token: t.token, signerKey: t.signerKey, transport: t.transport, confirmations: 2 }) });
  try {
    const c = await signIn(app.base);
    const v = (await c.post("/api/wallet/withdraw", { cycles: 10 })).body.voucher;
    await claimVoucher(t, c.address, v);
    await t.send(c.address, "deposit", [10n * UNIT]);
    assert.equal((await app.chain.sync()).deposits, 0, "only just mined");
    await t.chain.mine(); await t.chain.mine();
    assert.equal((await app.chain.sync()).deposits, 1);
  } finally { await app.close(); }
});

test("key rotation: vouchers from the old key fail on chain and come back as Cycles", async () => {
  const { t, app, c } = await setup();
  try {
    const v = (await c.post("/api/wallet/withdraw", { cycles: 40 })).body.voucher;
    await t.send(OWNER, "setSigner", [privateKeyToAccount(generatePrivateKey()).address]);
    assert.equal(await t.revertName(c.address, "claim", [BigInt(v.amount), BigInt(v.nonce), BigInt(v.deadline), v.signature]), "BadSignature");
    t.chain.increaseTime(WALLET_LIMITS.ttl + WALLET_LIMITS.refundGrace + 1); await t.chain.mine();
    assert.equal((await app.chain.sync()).refunded, 1);
    assert.equal(await balance(c), ECON.START);
  } finally { await app.close(); }
});

test("without a deployed token the wallet routes don't exist", async () => {
  const app = await startServer();
  try {
    const c = await signIn(app.base);
    assert.equal((await c.get("/api/me")).body.chain, null);
    assert.equal((await c.get("/api/wallet")).status, 404);
    assert.equal((await c.post("/api/wallet/withdraw", { cycles: 10 })).status, 404);
  } finally { await app.close(); }
});

test("a server key that isn't the token's signer pauses withdrawals instead of issuing dead vouchers", async () => {
  const t = await deployToken();
  const app = await startServer({ chain: chainModule({ token: t.token, signerKey: generatePrivateKey(), transport: t.transport, confirmations: 0 }) });
  try {
    const c = await signIn(app.base);
    const r = await c.post("/api/wallet/withdraw", { cycles: 10 });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /paused/);
    assert.equal(await balance(c), ECON.START, "nothing was taken");
    await assert.rejects(app.chain.check(), /signer/);
  } finally { await app.close(); }
});
