// Run: npm test (from apps/fighter-server)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, client, siwe, signIn, newAccount, BASIC_MOVES, ORIGIN } from "./helpers.mjs";
import { E, ECON, LIMITS } from "../src/game.mjs";

let app;
before(async () => { app = await startServer(); });
after(async () => { await app.close(); });

const balanceOf = async (c) => (await c.get("/api/state")).body.progress.balance;
async function newFighter(c, extra = {}) {
  const r = await c.post("/api/fighters", { name: "quill", moves: BASIC_MOVES, ...extra });
  assert.equal(r.status, 200, r.text);
  return r.body.fighter;
}
/** Level a stored fighter up directly in the store (test setup only: players can't do this). */
function levelUp(c, id, reps = 400) {
  const f = app.store.fighter(c.address, id);
  const { fighter } = E.train(f, "brawler", reps, { rng: E.rng(7) });
  app.store.putFighter(c.address, fighter, Date.now());
  return fighter;
}
/** Fight a rival until the first win (instincts are random; a trained fighter wins most). */
async function winAgainst(c, id, rival, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await c.post(`/api/fighters/${id}/battle`, { rival });
    assert.equal(r.status, 200, r.text);
    if (r.body.result === "win") return r.body;
  }
  throw new Error(`never beat ${rival}`);
}

// ---------- sign-in ----------
test("sign-in: a signed message makes an account with the starting Cycles", async () => {
  const c = await signIn(app.base);
  assert.match(c.address, /^0x[0-9a-fA-F]{40}$/);
  const me = await c.get("/api/me");
  assert.equal(me.body.address, c.address);
  const st = await c.get("/api/state");
  assert.equal(st.status, 200);
  assert.equal(st.body.progress.balance, ECON.START);
  assert.equal(app.store.ledgerSum(c.address), ECON.START, "the ledger table holds the same Cycles");
  assert.match(c.cookie, /^fl_session=[0-9a-f]{64}$/);
});

test("sign-in: replays, other sites, other chains and wrong signers are refused", async () => {
  const acct = newAccount();
  const login = (b) => client(app.base).post("/api/auth/login", b);
  const ok = await siwe(app.base, acct);
  assert.equal((await login(ok)).status, 200);
  assert.equal((await login(ok)).status, 401, "a nonce works once");
  assert.equal((await login(await siwe(app.base, acct, (m) => ({ ...m, domain: "evil.test" })))).status, 401);
  assert.equal((await login(await siwe(app.base, acct, (m) => ({ ...m, uri: "http://evil.test" })))).status, 401);
  assert.equal((await login(await siwe(app.base, acct, (m) => ({ ...m, chainId: 8453 })))).status, 401, "mainnet is refused");
  assert.equal((await login(await siwe(app.base, acct, (m) => ({ ...m, nonce: "abcdefgh12345678" })))).status, 401, "a nonce this server never issued");
  assert.equal((await login(await siwe(app.base, acct, (m) => ({ ...m, expirationTime: new Date(Date.now() - 1000) })))).status, 401, "expired");
  const other = newAccount();
  const forged = await siwe(app.base, acct);
  forged.signature = await other.signMessage({ message: forged.message });
  assert.equal((await login(forged)).status, 401, "signed by someone else");
  // the forged attempt didn't spend the nonce, so the real owner can still use it
  forged.signature = await acct.signMessage({ message: forged.message });
  assert.equal((await login(forged)).status, 200);
  assert.equal((await login({ message: 5, signature: "0x" })).status, 401);
});

test("signed-out requests are refused, and logout ends the session", async () => {
  const anon = client(app.base);
  assert.equal((await anon.get("/api/state")).status, 401);
  assert.equal((await anon.post("/api/fighters", { name: "x", moves: BASIC_MOVES })).status, 401);
  assert.equal((await anon.get("/api/arena")).status, 200, "the arena is public");
  const c = await signIn(app.base);
  assert.equal((await c.post("/api/auth/logout")).status, 200);
  assert.equal((await c.get("/api/state")).status, 401);
  assert.equal((await client(app.base).call("GET", "/api/state", undefined, { cookie: "fl_session=" + "0".repeat(64) })).status, 401);
});

// ---------- the browser can't set progress ----------
test("level, XP, instincts, practice and records come from the server, not the request", async () => {
  const c = await signIn(app.base);
  const f = await newFighter(c, { level: 50, xp: 1e6, proven: ["x"], uses: { fight: 9999 }, brain: { W: [], b: [] }, record: { w: 99, l: 0, d: 0 }, id: "f_mine" });
  assert.equal(f.level, 1); assert.equal(f.xp, 0);
  assert.deepEqual(f.proven, []); assert.equal(f.uses.fight, 0);
  assert.equal(f.record.w, 0); assert.notEqual(f.id, "f_mine");
  assert.equal(f.brain.W.length, 30);
  const up = await c.put(`/api/fighters/${f.id}`, { name: "quill", moves: BASIC_MOVES, level: 30, xp: 99999, stats: { power: 0, vitality: 0, speed: 0 } });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.body.fighter.level, 1);
  assert.equal(up.body.fighter.xp, 0);
  const tooMany = await c.put(`/api/fighters/${f.id}`, { name: "quill", moves: BASIC_MOVES, stats: { power: 5, vitality: 0, speed: 0 } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /stat points/);
  const cycles = await c.post("/api/shop", { item: "potion", price: 0, balance: 1e6 });
  assert.equal(cycles.body.progress.balance, ECON.START - E.ITEMS.potion.price, "prices come from the server");
});

test("designs only use files the player owns, within the level limit and the clauses", async () => {
  const c = await signIn(app.base);
  const fake = { id: "sk_fake", name: "GOD MODE", kind: "active", style: "aggro", effects: [{ type: "damage", power: 99, hits: 9 }] };
  const r1 = await c.post("/api/fighters", { name: "cheat", moves: ["sk_fake", "talk", "strategize", "shield"], custom: { sk_fake: fake } });
  assert.equal(r1.status, 400);
  assert.match(r1.body.error, /don't own/);
  const r2 = await c.post("/api/fighters", { name: "cheat", moves: BASIC_MOVES, passive: { ...E.STARTER_PASSIVES[0], id: "ps_mine", effects: [{ type: "regen", heal: 99, every: 1 }] } });
  assert.equal(r2.status, 400, "a passive that isn't a starter or in the library");
  const r3 = await c.post("/api/fighters", { name: "ok", moves: BASIC_MOVES, passive: E.STARTER_PASSIVES[0].id });
  assert.equal(r3.status, 200);
  assert.deepEqual(r3.body.fighter.passive.effects, E.STARTER_PASSIVES[0].effects, "the server's copy of the starter");
  assert.equal((await c.post("/api/fighters", { name: "dup", moves: ["fight", "fight", "talk", "shield"] })).status, 400);
  assert.equal((await c.post("/api/fighters", { name: "", moves: BASIC_MOVES })).status, 400);
  // two forged skills with the same special effect break the no-duplicates clause
  const burn = (name) => ({ name, kind: "active", style: "aggro", effects: [{ type: "damage", power: 2 }, { type: "burn", chance: 0.5, damage: 2, turns: 2 }] });
  const a = (await c.post("/api/forge", { skill: burn("BURN A") })).body.file;
  const b = (await c.post("/api/forge", { skill: { ...burn("BURN B"), style: "mind" } })).body.file;
  const r4 = await c.post("/api/fighters", { name: "twins", moves: [a.id, b.id, "talk", "shield"] });
  assert.equal(r4.status, 400);
  assert.match(r4.body.error, /No duplicates/);
});

// ---------- forge, Codex, shop, library ----------
test("forge: re-priced by the server; locked and over-limit files are refused", async () => {
  const c = await signIn(app.base);
  const hit = { name: "test hit", kind: "active", style: "aggro", effects: [{ type: "damage", power: 4 }] };
  const v = E.validateSkill(hit, { level: 1 });
  const r = await c.post("/api/forge", { skill: { ...hit, energy: 0, budget: 0 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.file.energy, v.skill.energy);
  assert.equal(r.body.cost, ECON.forgeCost(v.skill));
  assert.equal(r.body.progress.balance, ECON.START - r.body.cost);
  assert.ok(r.body.progress.library.some((s) => s.id === r.body.file.id));
  const big = { name: "too big", kind: "active", style: "aggro", effects: [{ type: "damage", power: 12, hits: 3 }] };
  assert.ok(E.validateSkill(big, { level: 1 }).overBudget, "test setup: over the level 1 limit");
  const r2 = await c.post("/api/forge", { skill: big });
  assert.equal(r2.status, 400); assert.match(r2.body.error, /Too powerful/);
  const stun = { name: "zap", kind: "active", style: "mind", effects: [{ type: "damage", power: 2 }, { type: "stun", chance: 0.3 }] };
  const r3 = await c.post("/api/forge", { skill: stun });
  assert.equal(r3.status, 400); assert.match(r3.body.error, /Locked/);
  const r4 = await c.post("/api/forge", { skill: { ...hit, effects: [{ type: "nuke", power: 9 }] } });
  assert.equal(r4.status, 400, "unknown effects aren't silently dropped");
  assert.equal(await balanceOf(c), ECON.START - r.body.cost, "refused forges cost nothing");
});

test("Codex unlocks a family for Cycles; then the forge accepts it", async () => {
  const c = await signIn(app.base);
  app.game.act(c.address, (p, now) => { p.wallet = ECON.credit(p.wallet, 500, "test grant", null, now); });
  const key = "active:stun";
  const r = await c.post("/api/codex", { key });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.progress.balance, ECON.START + 500 - ECON.codexPrice(key));
  assert.ok(r.body.progress.codex.includes(key));
  assert.equal((await c.post("/api/codex", { key })).status, 400, "already unlocked");
  assert.equal((await c.post("/api/codex", { key: "active:damage" })).status, 400, "starters aren't for sale");
  const stun = { name: "zap", kind: "active", style: "mind", effects: [{ type: "damage", power: 2 }, { type: "stun", chance: 0.3 }] };
  assert.equal((await c.post("/api/forge", { skill: stun })).status, 200);
});

test("shop and library: buying needs the Cycles; equipped files can't be deleted", async () => {
  const c = await signIn(app.base);
  for (let i = 0; i < 8; i++) assert.equal((await c.post("/api/shop", { item: "potion" })).status, 200);
  const broke = await c.post("/api/shop", { item: "potion" });
  assert.equal(broke.status, 400); assert.match(broke.body.error, /Not enough Cycles/);
  const st = (await c.get("/api/state")).body.progress;
  assert.equal(st.inventory.potion, 8);
  assert.equal(st.balance, ECON.START - 8 * E.ITEMS.potion.price);
  assert.equal((await c.post("/api/shop", { item: "__proto__" })).status, 400);

  const c2 = await signIn(app.base);
  const file = (await c2.post("/api/forge", { skill: { name: "jab", kind: "active", style: "aggro", effects: [{ type: "damage", power: 3 }] } })).body.file;
  await newFighter(c2, { moves: [file.id, "talk", "strategize", "shield"] });
  const del = await c2.del(`/api/library/${file.id}`);
  assert.equal(del.status, 400); assert.match(del.body.error, /equipped/);
});

// ---------- gym ----------
test("gym: 30 free rounds a day, then 1 Cycle a round; a refused session changes nothing", async () => {
  const c = await signIn(app.base);
  const f = await newFighter(c);
  const r = await c.post(`/api/fighters/${f.id}/train`, { partner: "brawler", reps: 50 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.quote.free, r.body.quote.paid], [30, 20]);
  assert.equal(r.body.progress.balance, ECON.START - 20);
  assert.ok(r.body.fighter.xp > 0 && r.body.report.reps === 50);
  assert.ok(r.body.report.lastMatch.turns.length > 0, "a match to replay in the browser");
  // spend down to 5 Cycles, then ask for more rounds than that
  app.game.act(c.address, (p, now) => { p.wallet = ECON.spend(p.wallet, ECON.balance(p.wallet) - 5, "test drain", null, now); });
  const before = app.store.fighter(c.address, f.id);
  const r2 = await c.post(`/api/fighters/${f.id}/train`, { partner: "brawler", reps: 10 });
  assert.equal(r2.status, 400); assert.match(r2.body.error, /Not enough Cycles/);
  assert.deepEqual(app.store.fighter(c.address, f.id), before, "the fighter wasn't trained");
  assert.equal(await balanceOf(c), 5);
  assert.equal((await c.post(`/api/fighters/${f.id}/train`, { partner: "brawler", reps: 500 })).status, 400);
  assert.equal((await c.post(`/api/fighters/${f.id}/train`, { partner: "kade", reps: 1 })).status, 400, "Kade unlocks at level 20");
  assert.equal(app.store.ledgerSum(c.address), 5);
});

test("practice: a new file blocks battles until drilled; then it's battle-ready", async () => {
  const c = await signIn(app.base);
  const file = (await c.post("/api/forge", { skill: { name: "jab", kind: "active", style: "aggro", effects: [{ type: "damage", power: 4 }] } })).body.file;
  const f = await newFighter(c, { moves: [file.id, "talk", "strategize", "shield"] });
  const blocked = await c.post(`/api/fighters/${f.id}/battle`, { rival: "sal" });
  assert.equal(blocked.status, 400); assert.match(blocked.body.error, /in training/);
  assert.equal((await c.post(`/api/fighters/${f.id}/publish`)).status, 400, "not into the arena either");
  let ready = [];
  for (let i = 0; i < 6 && !ready.length; i++) {
    const r = await c.post(`/api/fighters/${f.id}/train`, { partner: "turtle", reps: 10, drill: file.id });
    assert.equal(r.status, 200, r.text);
    ready = r.body.ready;
  }
  assert.deepEqual(ready, ["JAB"]);
  assert.ok(E.readiness(app.store.fighter(c.address, f.id)).ready);
  assert.equal((await c.post(`/api/fighters/${f.id}/battle`, { rival: "sal" })).status, 200);
});

test("spar: hand-picked turns on the server, saved when the bout ends", async () => {
  const c = await signIn(app.base), other = await signIn(app.base);
  const f = await newFighter(c);
  const s = await c.post(`/api/fighters/${f.id}/spar`, { partner: "talker" });
  assert.equal(s.status, 200, s.text);
  const id = s.body.sparId;
  assert.equal((await other.post(`/api/spar/${id}/turn`, { slot: 0 })).status, 404, "someone else's spar");
  assert.equal((await c.post(`/api/spar/${id}/turn`, { slot: 9 })).status, 400);
  let last, n = 0;
  do {
    const mask = E.legalMask(last ? last.spar.state : s.body.spar.state, 0);
    const slot = mask.findIndex(Boolean);
    const r = await c.post(`/api/spar/${id}/turn`, { slot: slot < 0 ? "rest" : slot });
    assert.equal(r.status, 200, r.text);
    last = r.body; n++;
  } while (!last.over && n < 20);
  assert.ok(last.over);
  assert.ok(last.xp > 0);
  assert.equal(last.fighter.xp, last.xp);
  assert.equal(app.store.fighter(c.address, f.id).xp, last.xp);
  assert.equal((await c.post(`/api/spar/${id}/turn`, { slot: 0 })).status, 404, "a finished spar is gone");
});

// ---------- battles ----------
test("rival battles: run on the server, stored with the seed, and replay to the same result", async () => {
  const c = await signIn(app.base);
  const f = await newFighter(c);
  assert.equal((await c.post(`/api/fighters/${f.id}/battle`, { rival: "grid" })).status, 400, "the ladder goes in order");
  levelUp(c, f.id);
  const r = await c.post(`/api/fighters/${f.id}/battle`, { rival: "sal" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.match.turns.length > 0, true);
  const rec = await c.get(`/api/battles/${r.body.battleId}`);
  assert.equal(rec.status, 200);
  assert.equal(rec.body.verified, true);
  assert.equal(rec.body.seed, r.body.seed);
  assert.deepEqual(rec.body.match.turns, r.body.match.turns, "the replay is the same battle, turn for turn");
  assert.equal(rec.body.result, r.body.result);
  const other = await signIn(app.base);
  assert.equal((await other.get(`/api/battles/${r.body.battleId}`)).status, 404, "your battles are yours");
});

test("rival rewards: first win, badge and a blueprint; repeat wins pay less and are capped per day", async () => {
  const c = await signIn(app.base);
  const f = await newFighter(c);
  levelUp(c, f.id);
  const start = await balanceOf(c);
  const first = await winAgainst(c, f.id, "sal");
  const rv = E.RIVALS[0];
  assert.equal(first.reward, ECON.rivalReward(rv.level, true));
  assert.ok(first.progress.beaten.includes("sal"));
  assert.ok(first.lines.some((l) => /Badge earned: Weapon slot/.test(l)));
  assert.ok(first.lines.some((l) => /blueprint/i.test(l)), "the first win always drops a blueprint");
  assert.ok(first.progress.balance >= start + first.reward);
  // repeat wins: small reward, at most LIMITS.rivalRepeatsPerDay a day
  app.game.act(c.address, (p, now) => { p.rivalRepeats = { day: ECON.dayKey(now), n: LIMITS.rivalRepeatsPerDay - 1 }; });
  const again = await winAgainst(c, f.id, "sal");
  assert.equal(again.reward, ECON.rivalReward(rv.level, false));
  const capped = await winAgainst(c, f.id, "sal");
  assert.equal(capped.reward, 0);
  assert.ok(capped.lines.some((l) => /rematch rewards are used up/.test(l)));
  assert.equal(app.store.ledgerSum(c.address), capped.progress.balance, "the ledger table matches the wallet");
});

test("items: only owned items come to battle, and a used one is used up", async () => {
  const c = await signIn(app.base);
  const f = await newFighter(c, { item: "potion", rules: [{ when: { kind: "my_hp_below", value: 90 }, do: { item: true } }] });
  const r = await c.post(`/api/fighters/${f.id}/battle`, { rival: "sal" });
  assert.equal(r.status, 200);
  assert.equal(r.body.me.item, null, "no potion in the inventory, so none in battle");
  assert.ok(!r.body.match.turns.some((t) => t.actions[0].kind === "item"));
  await c.post("/api/shop", { item: "potion" });
  const r2 = await c.post(`/api/fighters/${f.id}/battle`, { rival: "sal" });
  assert.equal(r2.body.me.item, "potion");
  const used = r2.body.match.turns.some((t) => t.actions[0].kind === "item");
  assert.equal(r2.body.progress.inventory.potion, used ? 0 : 1);
});

test("arena: publish ready fighters, challenges are server-run and rated; your own pay nothing", async () => {
  const alice = await signIn(app.base), bob = await signIn(app.base);
  const fa = await newFighter(alice, { name: "ace" });
  const fb = await newFighter(bob, { name: "bolt" });
  assert.equal((await alice.post(`/api/fighters/${fa.id}/publish`)).status, 200);
  const list = (await client(app.base).get("/api/arena")).body;
  const entry = list.entries.find((x) => x.owner === alice.address && x.fighter.id === fa.id);
  assert.ok(entry && entry.fighter.name === "ACE");
  const r = await bob.post(`/api/fighters/${fb.id}/battle`, { owner: alice.address, fighter: fa.id });
  assert.equal(r.status, 200, r.text);
  const pay = { win: 15, draw: 6, loss: 2 }[r.body.result];
  assert.equal(r.body.reward, pay);
  assert.equal(r.body.progress.balance, ECON.START + pay + (r.body.lines.some((l) => /Duplicate blueprint/.test(l)) ? Number(r.body.lines.find((l) => /Duplicate/.test(l)).match(/\+(\d+)/)[1]) : 0));
  const ratings = (await client(app.base).get("/api/arena")).body.ratings;
  assert.ok(ratings[`${bob.address}/${fb.id}`] && ratings[`${alice.address}/${fa.id}`], "both sides are rated");
  // your own fighter: no Cycles, not rated
  const own = await alice.post(`/api/fighters/${fa.id}/battle`, { owner: alice.address, fighter: fa.id });
  assert.equal(own.status, 200);
  assert.equal(own.body.reward, 0);
  const after = (await client(app.base).get("/api/arena")).body.ratings[`${alice.address}/${fa.id}`];
  assert.equal(after.w + after.l + after.d, 1, "only Bob's challenge counts");
  assert.equal((await bob.post(`/api/fighters/${fb.id}/battle`, { owner: alice.address, fighter: "nope" })).status, 404);
  // leaving the arena
  assert.equal((await alice.del(`/api/fighters/${fa.id}/publish`)).status, 200);
  assert.ok(!(await client(app.base).get("/api/arena")).body.entries.some((x) => x.fighter.id === fa.id));
});

test("arena: at most six fighters each; deleting a fighter takes it out", async () => {
  const c = await signIn(app.base);
  const ids = [];
  for (let i = 0; i < LIMITS.arena + 1; i++) ids.push((await newFighter(c, { name: `f${i}` })).id);
  for (const id of ids.slice(0, LIMITS.arena)) assert.equal((await c.post(`/api/fighters/${id}/publish`)).status, 200);
  assert.equal((await c.post(`/api/fighters/${ids.at(-1)}/publish`)).status, 400);
  assert.equal((await c.post(`/api/fighters/${ids[0]}/publish`)).status, 200, "republishing one that's in is fine");
  assert.equal((await c.del(`/api/fighters/${ids[0]}`)).status, 200);
  assert.ok(!(await c.get("/api/arena")).body.entries.some((x) => x.fighter.id === ids[0]));
  assert.equal((await c.put(`/api/fighters/${ids[0]}`, { name: "x", moves: BASIC_MOVES })).status, 404);
});

test("stats: points come with levels; moving spent points costs a reset", async () => {
  const c = await signIn(app.base);
  const f = await newFighter(c);
  const g = levelUp(c, f.id, 200);
  assert.ok(g.level >= 3);
  const save = (stats, respec) => c.put(`/api/fighters/${f.id}`, { name: "quill", moves: BASIC_MOVES, stats, respec });
  assert.equal((await save({ power: 2, vitality: 0, speed: 0 })).status, 200);
  const r = await save({ power: 0, vitality: 2, speed: 0 });
  assert.equal(r.status, 400); assert.match(r.body.error, /reset/);
  const before = await balanceOf(c);
  const r2 = await save({ power: 0, vitality: 2, speed: 0 }, true);
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.body.fighter.stats, { power: 0, vitality: 2, speed: 0 });
  assert.equal(r2.body.progress.balance, before - ECON.PRICES.respec);
  const r3 = await save({ power: 0, vitality: 2, speed: 1 }, true);
  assert.equal(r3.body.progress.balance, before - ECON.PRICES.respec, "adding points never costs a reset");
});

// ---------- the web layer ----------
test("requests: JSON only, size-limited, same-site writes, unknown routes", async () => {
  const c = await signIn(app.base);
  assert.equal((await c.call("POST", "/api/shop", "item=potion", { "content-type": "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await c.call("POST", "/api/shop", "{not json", { "content-type": "application/json" })).status, 400);
  assert.equal((await c.call("POST", "/api/shop", JSON.stringify({ item: "potion", pad: "x".repeat(70000) }))).status, 413);
  assert.equal((await c.call("POST", "/api/shop", { item: "potion" }, { origin: "http://evil.test" })).status, 403);
  assert.equal((await c.call("POST", "/api/shop", { item: "potion" }, { origin: ORIGIN })).status, 200);
  assert.equal((await c.get("/api/nope")).status, 404);
  assert.equal((await c.call("PATCH", "/api/shop", {})).status, 405);
});

test("rate limit: too many requests get 429", async () => {
  const small = await startServer({ perMinute: 5, authPerMinute: 2 });
  try {
    const anon = client(small.base);
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await anon.get("/api/arena")).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  } finally { await small.close(); }
  const auth = await startServer({ authPerMinute: 2 });
  try {
    const anon = client(auth.base);
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await anon.get("/api/auth/nonce")).status);
    assert.deepEqual(codes, [200, 200, 429], "sign-in has a tighter limit");
  } finally { await auth.close(); }
});

test("website: the game page and its files, nothing else from disk", async () => {
  const anon = client(app.base);
  const page = await anon.get("/");
  assert.equal(page.status, 200);
  assert.match(page.text, /<script src="platform-web\.js"><\/script>/);
  assert.match(page.text, /<script src="app\.js"><\/script>/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await anon.get("/engine.js")).status, 200);
  for (const p of ["/package.json", "/.env", "/../package.json", "/%2e%2e/src/server.mjs", "/src/server.mjs", "/fighter-lab.db"]) {
    assert.equal((await anon.get(p)).status, 404, p);
  }
});
