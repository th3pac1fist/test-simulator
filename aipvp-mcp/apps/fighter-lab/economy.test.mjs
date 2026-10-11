// Run: node --test apps/fighter-lab/economy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = require("./engine.js");
const $ = require("./economy.js");
const DAY1 = new Date(2026, 9, 11, 10, 0).getTime(), DAY1_LATE = new Date(2026, 9, 11, 23, 59).getTime(), DAY2 = new Date(2026, 9, 12, 0, 1).getTime();

test("a new wallet starts with 100 Cycles, and the balance is the sum of the ledger", () => {
  const w = $.newWallet(DAY1);
  assert.equal($.balance(w), 100);
  const w2 = $.spend($.credit(w, 50, "Rival win", "sal", DAY1), 30, "Overclock", null, DAY1);
  assert.equal($.balance(w2), 120);
  assert.equal(w2.ledger.length, 3);
  assert.equal($.balance(w), 100, "wallets are never mutated");
});

test("spending never goes negative and says why", () => {
  const w = $.newWallet(DAY1);
  assert.throws(() => $.spend(w, 101, "Forge FIREBALL", null, DAY1), /Not enough Cycles: Forge FIREBALL costs 101, you have 100/);
  assert.throws(() => $.spend(w, -5, "x"), /positive/);
  assert.throws(() => $.credit(w, 0, "x"), /positive/);
});

test("30 free gym rounds a day, then 1 Cycle a round; resets at local midnight", () => {
  let w = $.newWallet(DAY1);
  let r = $.payForGym(w, 25, DAY1); w = r.wallet;
  assert.deepEqual([r.quote.free, r.quote.paid, $.balance(w)], [25, 0, 100]);
  r = $.payForGym(w, 10, DAY1_LATE); w = r.wallet;
  assert.deepEqual([r.quote.free, r.quote.paid, $.balance(w)], [5, 5, 95]);
  assert.equal($.gymQuote(w, 50, DAY1_LATE).cost, 50);
  assert.equal($.gymQuote(w, 50, DAY2).cost, 20, "new day: 30 free again");
  w = { ...w, ledger: [{ at: DAY1, amount: 3, reason: "x" }], carried: 0 };
  assert.throws(() => $.payForGym(w, 10, DAY1_LATE), /Not enough Cycles/);
});

test("rewards: big first rival win, small repeats; arena capped and no self-farming", () => {
  assert.ok($.rivalReward(10, true) > 5 * $.rivalReward(10, false));
  let w = $.newWallet(DAY1), got = 0;
  assert.equal($.arenaReward(w, "win", true, DAY1), 0, "your own fighter pays nothing");
  for (let i = 0; i < 8; i++) { const r = $.payArena(w, "win", false, "x", DAY1); w = r.wallet; got += r.amount; }
  assert.equal(got, 15 * $.ARENA_REWARDS_PER_DAY);
  assert.equal($.payArena(w, "win", false, "x", DAY2).amount, 15, "cap resets the next day");
});

test("forging prices scale with skill power", () => {
  const small = E.validateSkill({ effects: [{ type: "damage", power: 2 }] }).skill;
  const big = E.validateSkill({ effects: [{ type: "damage", power: 6 }, { type: "burn", chance: 1, damage: 4, turns: 4 }] }).skill;
  assert.ok($.forgeCost(big) > $.forgeCost(small) * 2);
  assert.ok($.forgeCost(E.STARTER_PASSIVES[0]) > 0);
  assert.equal($.itemPrice("potion"), E.ITEMS.potion.price);
  assert.equal($.itemPrice("nope"), Infinity);
});

test("long ledgers fold old entries into a carried balance", () => {
  let w = $.newWallet(DAY1);
  for (let i = 0; i < 450; i++) w = $.credit(w, 1, "tick", null, DAY1);
  assert.equal(w.ledger.length, $.LEDGER_KEEP);
  assert.equal($.balance(w), 550);
});

test("a damaged save becomes a valid wallet", () => {
  assert.equal($.balance($.sanitizeWallet(null, DAY1)), 100);
  const w = $.sanitizeWallet({ ledger: [{ at: 1, amount: 50, reason: "<b>x</b>\u0000" }, { at: "bad", amount: 9 }, null, { at: 2, amount: "NaN" }], carried: "x", roundsUsed: -4 }, DAY1);
  assert.equal($.balance(w), 50);
  assert.equal(w.roundsUsed, 0);
  assert.ok(!w.ledger[0].reason.includes("\u0000"));
});
