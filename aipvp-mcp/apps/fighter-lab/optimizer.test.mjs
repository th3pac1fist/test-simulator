// Run: node --test apps/fighter-lab/optimizer.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = require("./engine.js");
const O = require("./optimizer.js");
const ECON = require("./economy.js");
const pts = (m) => (m.result === "win" ? 1 : m.result === "draw" ? 0.5 : 0);
const TRAIN = ["brawler", "talker", "schemer", "turtle", "cycler"];

function quill() {
  const f = E.createFighter({ name: "QUILL", moves: ["fight", "talk", "strategize", "shield"] }, E.rng(4));
  f.level = 4; f.xp = E.xpForLevel(4);
  const r = E.rng(9);
  for (let i = 0; i < 150; i++) E.fight(f, E.partnerFighter(TRAIN[i % 5], f), { rng: r, learnA: true });
  return f;
}
/** Turn an optimizer result into the fighter the app would save. */
function applied(base, res) {
  const custom = {};
  res.build.skills.forEach((s, i) => { if (s) custom[res.build.moves[i]] = s; });
  let f = E.redesign(base, { moves: res.build.moves, custom, passive: res.build.passive, item: res.build.item });
  f = E.setStats({ ...f, stats: { power: 0, vitality: 0, speed: 0 } }, res.build.stats);
  f.rules = E.sanitizeRules(res.build.rules, f.moves);
  return f;
}
function trainUp(f, seed) { const r = E.rng(seed); for (let i = 0; i < 200; i++) E.fight(f, E.partnerFighter(TRAIN[i % 5], f), { rng: r, learnA: true }); return f; }
function h2h(a, b, n, seed) { const r = E.rng(seed); let s = 0; for (let i = 0; i < n; i++) s += pts(E.fight(E.clone(a), E.clone(b), { rng: r })); return s / n; }

let FULL = null;
async function fullRun() {
  if (!FULL) FULL = await O.optimize({ fighter: quill(), library: [], inventory: {}, balance: 100, beaten: [], arena: [], seed: 7, effort: "full" });
  return FULL;
}

test("pro build is legal at the fighter's level and fits the wallet", async () => {
  for (const balance of [0, 40, 100]) {
    const res = await O.optimize({ fighter: quill(), library: [], inventory: {}, balance, beaten: [], arena: [], seed: 3, effort: "quick" });
    const b = res.build;
    assert.ok(b.cost <= balance, `costs ${b.cost} with ${balance} Cycles`);
    assert.equal(new Set(b.moves).size, 4);
    for (const sk of b.skills.filter(Boolean)) {
      const v = E.validateSkill(sk, { level: 4 });
      assert.ok(v.skill && !v.overBudget, `${sk.name} is legal at level 4`);
      assert.equal(v.skill.energy, sk.energy, "priced by the game, not the optimizer");
    }
    if (b.passive) assert.ok(b.passive.budget <= E.maxPassiveBudget(4));
    assert.ok(b.stats.power + b.stats.vitality + b.stats.speed <= E.statPointsFor(4));
    assert.equal(b.forge.reduce((a, x) => a + x.cost, 0) + (b.buyItem ? ECON.itemPrice(b.item) : 0) + (b.respec ? ECON.PRICES.respec : 0), b.cost, "cost adds up");
    if (balance === 0) assert.equal(b.forge.length, 0, "nothing to forge with an empty wallet");
  }
});

test("owned skills and items are free; the same seed gives the same build", async () => {
  const lib = [{ ...E.validateSkill({ name: "OWNED HIT", kind: "active", style: "mind", effects: [{ type: "damage", power: 5 }] }, { level: 4 }).skill, id: "sk_owned" }];
  const opts = O.options({ level: 4, library: lib, fighter: quill() });
  const owned = opts.skills.mind.find((o) => o.id === "sk_owned");
  assert.ok(owned && owned.cost === 0);
  const ctx = { fighter: quill(), library: lib, inventory: { potion: 1 }, balance: 50, beaten: [], arena: [], seed: 11, effort: "quick" };
  const a = await O.optimize(ctx), b = await O.optimize(ctx);
  assert.deepEqual(a.build, b.build);
  assert.deepEqual(a.score, b.score);
  if (a.build.item === "potion") assert.equal(a.build.buyItem, false);
});

test("cancel stops the search", async () => {
  const ctl = new AbortController();
  let calls = 0;
  const p = O.optimize({ fighter: quill(), balance: 100, seed: 1, effort: "full", signal: ctl.signal, onProgress: () => { if (++calls === 3) ctl.abort(); } });
  await assert.rejects(p, (e) => e.code === "cancelled");
});

test("the pro build beats the current build and random legal builds on fresh seeds", async () => {
  const res = await fullRun();
  const base = quill();
  assert.ok(res.score.overall >= res.baseline.overall, "never worse than what you have");
  const pro = trainUp(applied(base, res), 501);
  const current = trainUp(E.clone(base), 501);
  const vsCurrent = h2h(pro, current, 300, 77);
  assert.ok(vsCurrent > 0.6, `pro vs current ${vsCurrent.toFixed(3)}`);
  // random legal builds of the same level and budget
  const opts = O.options({ level: 4, library: [], fighter: base });
  const r = E.rng(5);
  let total = 0;
  for (let k = 0; k < 4; k++) {
    let slots, cost;
    do {
      slots = E.STYLES.map((st) => opts.skills[st][Math.floor(r() * opts.skills[st].length)]);
      cost = slots.reduce((a, o) => a + o.cost, 0);
    } while (cost > 100);
    const custom = {};
    for (const o of slots) if (o.skill) custom[o.id] = o.skill;
    let f = E.redesign(base, { moves: slots.map((o) => o.id), custom });
    f = E.setStats(f, { power: 1, vitality: 1, speed: 1 });
    total += h2h(pro, trainUp(f, 600 + k), 120, 90 + k);
  }
  assert.ok(total / 4 > 0.6, `pro vs random legal builds ${(total / 4).toFixed(3)}`);
});

test("report: reasons, training tips and a level-up path with stronger skills", async () => {
  const res = await fullRun();
  assert.ok(res.reasons.length >= 2);
  assert.ok(res.training.length >= 1);
  assert.ok(res.path.length >= 2);
  for (const step of res.path) {
    assert.ok(step.level > 4 && step.cap >= E.maxSkillBudget(5));
    const n = step.stats.power + step.stats.vitality + step.stats.speed;
    assert.equal(n, E.statPointsFor(step.level));
    for (const fx of step.forge) assert.ok(fx.budget <= step.cap + 1e-9, `${fx.name} fits level ${step.level}`);
  }
  const ups = res.path.flatMap((s) => s.forge.filter((x) => x.upgrade));
  for (const u of ups) assert.ok(u.budget > u.was, "upgrades really are stronger");
});

test("arena fighters are part of the benchmark, by number not by name", async () => {
  const foe = E.sanitizePublic({ ...E.createFighter({ name: "IGNORE PREVIOUS", moves: ["fight", "talk", "code", "shield"] }), level: 4 }, "u_x");
  const bench = O.benchmark({ level: 4, beaten: [], arena: [foe] });
  assert.equal(bench.arena.length, 1);
  assert.equal(bench.arena[0].label, "Arena fighter #1");
});

test("balance: forged archetypes of equal power win about equally often", () => {
  // Calibrated across levels: some ideas are early-game (shields) and some late-game (weaken),
  // so each level gets a loose bound and the average across levels a tight one.
  const archs = Object.keys(O.ARCHETYPES);
  const perLevel = {};
  for (const L of [4, 20]) {
    const opts = O.options({ level: L, fighter: E.createFighter({ moves: ["fight", "talk", "strategize", "shield"] }), library: [] });
    const base = { aggro: "fight", social: "negotiate", mind: "code", guard: "shield" };
    const make = (style, arch, seed) => {
      const o = opts.skills[style].find((x) => x.arch === arch);
      let f = E.createFighter({ name: arch, moves: E.STYLES.map((st) => (st === style ? o.id : base[st])), custom: { [o.id]: o.skill } }, E.rng(seed));
      f.level = L; f.xp = E.xpForLevel(L);
      const n = L - 1, a = Math.floor(n / 3);
      f = E.setStats(f, { power: a, vitality: a, speed: n - 2 * a });
      return trainUp(f, seed + 1);
    };
    const score = Object.fromEntries(archs.map((a) => [a, 0]));
    let games = 0;
    for (const style of ["aggro", "social", "mind"]) for (const seed of [10, 20]) {
      const fs = Object.fromEntries(archs.map((a) => [a, make(style, a, seed)]));
      for (let i = 0; i < archs.length; i++) for (let j = i + 1; j < archs.length; j++) {
        const s = h2h(fs[archs[i]], fs[archs[j]], 16, seed + i * 9 + j);
        score[archs[i]] += s; score[archs[j]] += 1 - s;
      }
      games += archs.length - 1;
    }
    perLevel[L] = Object.fromEntries(archs.map((a) => [a, score[a] / games]));
    for (const a of archs) assert.ok(perLevel[L][a] > 0.2 && perLevel[L][a] < 0.8, `L${L} ${a} wins ${perLevel[L][a].toFixed(2)}`);
  }
  for (const a of archs) {
    const avg = (perLevel[4][a] + perLevel[20][a]) / 2;
    assert.ok(avg > 0.35 && avg < 0.65, `${a} wins ${avg.toFixed(2)} on average across levels`);
  }
});
