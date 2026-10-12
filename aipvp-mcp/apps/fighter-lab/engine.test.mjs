// Run: node --test apps/fighter-lab/engine.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const E = createRequire(import.meta.url)("./engine.js");
const BALANCED = ["fight", "talk", "strategize", "shield"];
const score = (m) => (m.result === "win" ? 1 : m.result === "draw" ? 0.5 : 0);
const FIREBALL = { name: "Fireball", style: "aggro", element: "fire", effects: [{ type: "damage", power: 3 }, { type: "burn", chance: 0.3, damage: 2, turns: 3 }] };
/** a fresh fighter whose instincts have no preferences (for fair comparisons) */
const neutral = (f) => { f.brain.W = f.brain.W.map((row) => row.map((v, i) => (i === E.ITEM_SLOT ? -1.5 : 0))); return f; };

// ---------------------------------------------------------------- rules
test("style cycle: each style beats the next and loses to the previous", () => {
  assert.equal(E.typeMult("aggro", "social"), 2);
  assert.equal(E.typeMult("guard", "aggro"), 2);
  assert.equal(E.typeMult("social", "aggro"), 0.5);
  assert.equal(E.typeMult("aggro", "mind"), 1);
  assert.equal(E.typeMult("aggro", null), 1); // items and rests have no style
});

test("same seed, same fight", () => {
  const f = E.createFighter({ name: "A", moves: BALANCED }, E.rng(1));
  assert.deepEqual(E.exhibition(f, "brawler", 42).match, E.exhibition(f, "brawler", 42).match);
});

test("energy: start at 3, +2 a turn, capped at 10, spent by skills", () => {
  const a = E.createFighter({ moves: ["code", "talk", "search", "observe"] }), b = E.createFighter({ moves: ["talk", "search", "observe", "fight"] });
  const st = E.newBattle(a, b), r = E.rng(1);
  assert.equal(st.side[0].energy, 3);
  E.resolveTurn(st, [{ kind: "skill", skill: "code" }, { kind: "skill", skill: "talk" }], r);   // COMPILE costs 2
  assert.equal(st.side[0].energy, 1 + 2);
  for (let i = 0; i < 6; i++) E.resolveTurn(st, [{ kind: "skill", skill: "talk" }, { kind: "skill", skill: "talk" }], r);
  assert.equal(st.side[0].energy, 10);
  assert.throws(() => { const s2 = E.newBattle(a, b); s2.side[0].energy = 1; E.resolveTurn(s2, [{ kind: "skill", skill: "code" }, { kind: "skill", skill: "talk" }], r); }, /can't do that/);
});

test("cooldowns block a skill for the right number of turns", () => {
  const v = E.validateSkill({ id: "big", name: "BIG", style: "aggro", effects: [{ type: "damage", power: 6 }] });
  assert.equal(v.skill.cooldown, 1);
  const a = E.createFighter({ moves: ["big", "talk", "search", "observe"], custom: { big: v.skill } });
  const st = E.newBattle(a, E.createFighter({ moves: BALANCED })), r = E.rng(2);
  st.side[0].energy = 10;
  E.resolveTurn(st, [{ kind: "skill", skill: "big" }, { kind: "skill", skill: "talk" }], r);
  assert.equal(E.legalMask(st, 0)[0], 0, "on cooldown the next turn");
  E.resolveTurn(st, [{ kind: "skill", skill: "talk" }, { kind: "skill", skill: "talk" }], r);
  assert.equal(E.legalMask(st, 0)[0], 1, "available again after that");
});

test("burn and poison tick at the end of the turn; regen heals every N turns", () => {
  const burn = E.validateSkill({ id: "torch", name: "TORCH", style: "aggro", effects: [{ type: "damage", power: 0.5 }, { type: "burn", chance: 1, damage: 3, turns: 2 }] }).skill;
  const a = E.createFighter({ moves: ["torch", "talk", "search", "observe"], custom: { torch: burn } });
  const b = E.createFighter({ moves: BALANCED });
  b.passive = E.validateSkill({ name: "WIND", kind: "passive", effects: [{ type: "regen", heal: 2, every: 2 }] }).skill;
  const st = E.newBattle(a, b), r = E.rng(3);
  st.side[0].energy = 10;
  const t1 = E.resolveTurn(st, [{ kind: "skill", skill: "torch" }, { kind: "skill", skill: "talk" }], r);
  assert.ok(t1.events.some((e) => e.kind === "burn" && e.amount === 3));
  const t2 = E.resolveTurn(st, [{ kind: "skill", skill: "talk" }, { kind: "skill", skill: "talk" }], r);
  assert.ok(t2.events.some((e) => e.kind === "burn"));
  assert.ok(t2.events.some((e) => e.kind === "regen" && e.who === b.name), "passive regen on turn 2");
  const t3 = E.resolveTurn(st, [{ kind: "skill", skill: "talk" }, { kind: "skill", skill: "talk" }], r);
  assert.ok(!t3.events.some((e) => e.kind === "burn"), "burn lasted 2 turns");
});

test("shields absorb damage and act first; stun cancels an action and grants immunity", () => {
  const stunner = E.validateSkill({ id: "zap", name: "ZAP", style: "mind", effects: [{ type: "damage", power: 1 }, { type: "stun", chance: 0.6 }] }).skill;
  assert.equal(stunner.priority, 1);
  const a = E.createFighter({ moves: ["zap", "talk", "search", "observe"], custom: { zap: stunner } });
  const b = E.createFighter({ moves: ["fight", "talk", "search", "shield"] });
  const always = () => 0.01; // every roll succeeds
  const st = E.newBattle(a, b);
  st.side[0].energy = 10;
  const t = E.resolveTurn(st, [{ kind: "skill", skill: "zap" }, { kind: "skill", skill: "fight" }], always);
  assert.equal(t.actions[0].order, 1, "priority skill acts first");
  assert.ok(t.actions[1].stunned, "the stun cancelled STRIKE this turn");
  assert.equal(t.actions[1].points, 0);
  const t2 = E.resolveTurn(st, [{ kind: "skill", skill: "zap" }, { kind: "skill", skill: "shield" }], always);
  assert.ok(!t2.actions[1].stunned, "can't be stunned twice in a row");
  assert.ok(t2.actions[0].notes.some((n) => /can't be stunned/.test(n)) || t2.actions[1].applied.includes("shield"));
  const st2 = E.newBattle(E.createFighter({ moves: ["fight", "talk", "search", "observe"] }), b);
  const t3 = E.resolveTurn(st2, [{ kind: "skill", skill: "fight" }, { kind: "skill", skill: "shield" }], E.rng(9));
  assert.equal(t3.actions[1].order, 1, "BULWARK acts first");
  assert.ok(t3.actions[0].absorbed > 0, "and its shield absorbs the strike");
});

test("items: one per battle, acts first, potion heals", () => {
  const a = E.createFighter({ moves: BALANCED, item: "potion" });
  const st = E.newBattle(a, E.createFighter({ moves: BALANCED })), r = E.rng(4);
  st.side[0].hp = 20;
  assert.equal(E.legalMask(st, 0)[E.ITEM_SLOT], 1);
  const t = E.resolveTurn(st, [{ kind: "item" }, { kind: "skill", skill: "fight" }], r);
  assert.equal(t.actions[0].order, 1);
  assert.equal(t.actions[0].healed, Math.round(E.ITEMS.potion.heal * st.side[0].max * 100) / 100);
  assert.equal(E.legalMask(st, 0)[E.ITEM_SLOT], 0, "used up");
});

test("battle rules fire before instincts and only when legal", () => {
  const f = E.createFighter({ moves: BALANCED, item: "potion" });
  f.rules = E.sanitizeRules([{ when: { kind: "my_hp_below", value: 30 }, do: { item: true } }, { when: { kind: "their_last_style", value: "aggro" }, do: { skill: "shield" } }], f.moves);
  const st = E.newBattle(f, E.createFighter({ moves: BALANCED })), r = E.rng(5);
  st.side[0].hp = 10;
  assert.equal(E.instinctChoice(st, 0, r).kind, "item");
  st.side[0].itemLeft = false; st.side[1].last = "aggro";
  const c = E.instinctChoice(st, 0, r);
  assert.equal(c.skill, "shield"); assert.equal(c.source, "rule");
  st.side[0].energy = 0;   // BULWARK costs 1: the rule can't fire, instincts decide
  assert.notEqual(E.instinctChoice(st, 0, r).source, "rule");
  assert.deepEqual(E.sanitizeRules([{ when: { kind: "hack" }, do: { skill: "fight" } }, { when: { kind: "my_hp_below", value: 999 }, do: { skill: "code" } }], BALANCED), []);
  assert.match(E.describeRule(f.rules[0], f), /If my hp is below 30%, use my item \(POTION\)\./);
});

test("speed decides who acts first when priority is equal", () => {
  const a = E.createFighter({ moves: BALANCED }), b = E.createFighter({ moves: BALANCED });
  a.level = 5; a.stats = { power: 0, vitality: 0, speed: 4 };
  for (let s = 0; s < 20; s++) {
    const st = E.newBattle(a, b);
    const t = E.resolveTurn(st, [{ kind: "skill", skill: "fight" }, { kind: "skill", skill: "talk" }], E.rng(s));
    assert.equal(t.actions[0].order, 1);
  }
  assert.throws(() => E.setStats(a, { power: 3, vitality: 3, speed: 0 }), /Only 4 stat points/);
});

// ---------------------------------------------------------------- skills
test("skill pricing: fireball and second wind", () => {
  const fb = E.validateSkill(FIREBALL).skill;
  assert.equal(fb.energy, 2); assert.equal(fb.cooldown, 0);
  assert.match(E.describeSkill(fb), /3 damage, 30% chance to burn/);
  const wind = E.validateSkill({ name: "Second wind", kind: "passive", effects: [{ type: "regen", heal: 4, every: 2 }] }, { level: 1 });
  assert.ok(wind.overBudget && /Too powerful for level 1/.test(wind.errors[0]));
  const lvl = [...Array(50).keys()].map((i) => i + 1).find((l) => E.maxPassiveBudget(l) >= wind.skill.budget);
  assert.ok(lvl > 1 && lvl <= 50, "unlocks with level");
  assert.ok(!E.validateSkill({ name: "Small wind", kind: "passive", effects: [{ type: "regen", heal: 2, every: 3 }] }, { level: 1 }).overBudget);
  // "heals every two turns" is forgeable from level 1, and a passive lasts all battle
  const bloom = E.validateSkill({ name: "Life bloom", kind: "passive", effects: [{ type: "regen", heal: 1, every: 2 }] }, { level: 1 });
  assert.ok(bloom.skill && !bloom.overBudget);
  assert.equal(E.describeSkill(bloom.skill), "Passive: heals 1 HP every 2 turns.");
});

test("cheaper trades energy for cooldown, and prices can't be set by hand", () => {
  const raw = { name: "NUKE", style: "mind", effects: [{ type: "damage", power: 6 }], energy: 0, cooldown: 0 };
  const a = E.validateSkill(raw).skill, b = E.validateSkill({ ...raw, cheaper: 2 }).skill;
  assert.ok(a.energy > 0, "energy 0 in the file is ignored");
  assert.equal(b.energy, a.energy - 2); assert.equal(b.cooldown, a.cooldown + 2);
});

test("hostile skill files are cleaned or rejected", () => {
  const v = E.validateSkill({ name: "<script>alert(1)</script>", style: "chaos", element: "plasma",
    effects: [{ type: "damage", power: 9999, hits: 50 }, { type: "nuke", power: 9 }, { type: "stun", chance: 5 }, { type: "damage", power: 1 }, { type: "heal", amount: -50 }] });
  assert.ok(!/[<>]/.test(v.skill.name));
  assert.equal(v.skill.style, "aggro"); assert.equal(v.skill.element, "none");
  const dmg = v.skill.effects.find((e) => e.type === "damage");
  assert.deepEqual([dmg.power, dmg.hits], [6, 3]);
  assert.equal(v.skill.effects.find((e) => e.type === "stun").chance, 0.6);
  assert.ok(v.skill.effects.length <= 3);
  assert.ok(v.errors.length >= 2);
  assert.equal(E.validateSkill(null).skill, null);
  assert.equal(E.validateSkill({ effects: [] }).skill, null);
  assert.equal(E.validateSkill({ effects: [{ type: "drain", pct: 0.5 }] }).skill, null, "drain needs damage");
  assert.equal(E.validateSkill({ id: "fight", effects: [{ type: "damage", power: 2 }] }).skill.id === "fight", false, "can't overwrite a basic skill");
});

test("balance: no basic skill dominates (random loadouts, random play)", () => {
  const r = E.rng(42), ids = E.SKILL_NAMES, tally = Object.fromEntries(ids.map((i) => [i, [0, 0]]));
  const mk = (m) => neutral(E.createFighter({ moves: m }, r));
  for (let g = 0; g < 2500; g++) {
    const A = [...ids].sort(() => r() - 0.5).slice(0, 4), B = [...ids].sort(() => r() - 0.5).slice(0, 4);
    const m = E.fight(mk(A), mk(B), { rng: r });
    for (const x of A) { tally[x][0] += score(m); tally[x][1]++; }
    for (const x of B) { tally[x][0] += 1 - score(m); tally[x][1]++; }
  }
  for (const id of ids) { const w = tally[id][0] / tally[id][1]; assert.ok(w > 0.38 && w < 0.62, `${id} ${w.toFixed(2)}`); }
});

test("balance: skills with equal power budgets win about equally often", () => {
  const r = E.rng(7);
  const fit = (tpl, knob, target) => {
    let lo = 0.01, hi = 100;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2, s = JSON.parse(JSON.stringify(tpl)); s.effects[knob[0]][knob[1]] = mid;
      if (E.validateSkill(s).skill.budget < target) lo = mid; else hi = mid;
    }
    const s = JSON.parse(JSON.stringify(tpl)); s.effects[knob[0]][knob[1]] = lo; return E.validateSkill(s).skill;
  };
  const tpls = {
    hit: [[{ type: "damage", power: 5 }], [0, "power"]], fire: [[{ type: "damage", power: 3 }, { type: "burn", chance: 0.5, damage: 2, turns: 3 }], [0, "power"]],
    stun: [[{ type: "damage", power: 3 }, { type: "stun", chance: 0.4 }], [0, "power"]], aegis: [[{ type: "shield", amount: 6, turns: 2 }, { type: "heal", amount: 4 }], [1, "amount"]],
    leech: [[{ type: "damage", power: 3.5 }, { type: "drain", pct: 0.5 }], [0, "power"]], hex: [[{ type: "damage", power: 3 }, { type: "weaken", pct: 0.4, turns: 2 }], [0, "power"]],
    venom: [[{ type: "damage", power: 3 }, { type: "poison", chance: 1, stacks: 2 }], [0, "power"]], flurry: [[{ type: "damage", power: 1.8, hits: 3 }], [0, "power"]],
  };
  const sk = {};
  for (const [k, [effects, knob]] of Object.entries(tpls)) { sk[k] = fit({ id: k, name: k, style: "mind", effects }, knob, 5.5); sk[k].id = k; }
  const res = Object.fromEntries(Object.keys(sk).map((k) => [k, [0, 0]]));
  for (let g = 0; g < 120; g++) for (const a of Object.keys(sk)) for (const b of Object.keys(sk)) {
    if (a === b) continue;
    const m = E.fight(neutral(E.createFighter({ moves: ["fight", "talk", "shield", a], custom: { [a]: sk[a] } }, r)),
                      neutral(E.createFighter({ moves: ["fight", "talk", "shield", b], custom: { [b]: sk[b] } }, r)), { rng: r });
    res[a][0] += score(m); res[a][1]++; res[b][0] += 1 - score(m); res[b][1]++;
  }
  for (const [k, [s, n]] of Object.entries(res)) assert.ok(s / n > 0.38 && s / n < 0.64, `${k} ${(s / n).toFixed(2)}`);
});

// ---------------------------------------------------------------- learning
// stat and item balance: trained fighters, identical except for the thing being compared
const TRAIN5 = ["brawler", "talker", "schemer", "turtle", "cycler"];
function trained(moves, level, { stats, item, rules } = {}, seed = 1) {
  let f = E.createFighter({ name: "T", moves, item: item || null }, E.rng(seed));
  f.level = level; f.xp = E.xpForLevel(level);
  if (stats) f = E.setStats(f, stats);
  if (rules) f.rules = E.sanitizeRules(rules, f.moves);
  const r = E.rng(seed + 3);
  for (let i = 0; i < 200; i++) E.fight(f, E.partnerFighter(TRAIN5[i % 5], f), { rng: r, learnA: true });
  return f;
}
const H2H_LOADOUTS = [["fight", "negotiate", "code", "shield"], ["fight", "talk", "strategize", "shield"], ["deceive", "debate", "code", "analyze"], ["fight", "debate", "search", "observe"]];
function headToHead(makeA, makeB, seeds, n = 50, loadouts = H2H_LOADOUTS) {
  let s = 0, k = 0;
  for (const mv of loadouts) for (const seed of seeds) {
    const a = makeA(mv, seed), b = makeB(mv, seed), r = E.rng(seed * 97);
    for (let i = 0; i < n; i++) { s += score(E.fight(E.clone(a), E.clone(b), { rng: r })); k++; }
  }
  return s / k;
}

test("balance: Power and Vitality are worth about the same at every level, and Speed matters", () => {
  for (const level of [4, 15, 35]) {
    const n = level - 1;
    const pv = headToHead((mv, sd) => trained(mv, level, { stats: { power: n, vitality: 0, speed: 0 } }, sd),
                          (mv, sd) => trained(mv, level, { stats: { power: 0, vitality: n, speed: 0 } }, sd), [1, 2, 3, 4, 5]);
    assert.ok(Math.abs(pv - 0.5) <= 0.08, `L${level}: all-Power vs all-Vitality ${pv.toFixed(3)}`);
  }
  // Speed is a real stat: dodging beats putting nothing anywhere
  const sp = headToHead((mv, sd) => trained(mv, 15, { stats: { power: 0, vitality: 0, speed: 14 } }, sd),
                        (mv, sd) => trained(mv, 15, {}, sd), [1, 2]);
  assert.ok(sp > 0.6, `L15: all-Speed vs no points ${sp.toFixed(3)}`);
  assert.equal(E.maxHp(4, 0), 64);
  assert.equal(E.maxHp(4, 10), Math.round(64 * (1 + 10 * E.STAT_PCT.vitality)), "Vitality is a share of base HP");
});

test("balance: a Potion with a low-HP rule helps but doesn't decide battles", () => {
  const rules = [{ when: { kind: "my_hp_below", value: 35 }, do: { item: true } }];
  const withPotion = headToHead((mv, sd) => trained(mv, 4, { item: "potion", rules }, sd), (mv, sd) => trained(mv, 4, {}, sd), [1, 2, 3]);
  const withSmoke = headToHead((mv, sd) => trained(mv, 4, { item: "smoke", rules: [{ when: { kind: "phase_is", value: "endgame" }, do: { item: true } }] }, sd), (mv, sd) => trained(mv, 4, {}, sd), [1, 2, 3]);
  assert.ok(withPotion > 0.5 && withPotion < 0.68, `potion vs no item ${withPotion.toFixed(3)} (was about 0.9 with a flat 25 HP)`);
  assert.ok(Math.abs(withPotion - withSmoke) < 0.12, `potion ${withPotion.toFixed(3)} vs smoke ${withSmoke.toFixed(3)}`);
});

test("speed dodges: a dodged attack lands nothing, and dodging is capped", () => {
  const a = E.createFighter({ moves: BALANCED }), b = E.setStats({ ...E.createFighter({ moves: BALANCED }), level: 50, xp: E.xpForLevel(50) }, { power: 0, vitality: 0, speed: 49 });
  let dodged = 0, n = 400;
  const r = E.rng(5);
  for (let i = 0; i < n; i++) {
    const st = E.newBattle(E.clone(a), E.clone(b));
    const t = E.resolveTurn(st, [{ kind: "skill", skill: "fight" }, { kind: "skill", skill: "talk" }], r);
    const mine = t.actions[0];
    if (mine.notes.some((x) => /dodges/.test(x))) { dodged++; assert.equal(mine.points, 0); }
  }
  assert.ok(Math.abs(dodged / n - E.STAT_PCT.dodgeCap) < 0.07, `dodge rate ${(dodged / n).toFixed(2)} at the cap`);
});

test("rule: my energy is below X (for Ether)", () => {
  const f = E.createFighter({ moves: BALANCED, item: "ether" });
  f.rules = E.sanitizeRules([{ when: { kind: "my_energy_below", value: 2 }, do: { item: true } }], f.moves);
  const st = E.newBattle(f, E.createFighter({ moves: BALANCED }));
  assert.equal(E.ruleChoice(st, 0), null, "starts with 3 energy");
  st.side[0].energy = 1;
  assert.equal(E.ruleChoice(st, 0).kind, "item");
});

test("fitSkill shrinks turns and ticks when scaling numbers isn't enough", () => {
  const v = E.fitSkill({ name: "Renew", kind: "active", style: "guard", effects: [{ type: "regen", heal: 3, every: 1, turns: 4 }, { type: "damage", power: 1.5 }] }, 4);
  assert.ok(v.skill && !v.overBudget && v.scaled, v.errors.join(" "));
  assert.ok(v.skill.budget <= E.maxSkillBudget(4) && v.skill.budget > E.maxSkillBudget(4) * 0.8, `uses most of the budget: ${v.skill.budget}`);
  assert.ok(v.skill.effects.some((e) => e.type === "regen"), "keeps the idea");
});

test("training makes a fighter measurably stronger against each style", () => {
  for (const partner of ["brawler", "talker", "schemer", "turtle"]) {
    let f = E.createFighter({ name: "ROOKIE", moves: BALANCED }, E.rng(7));
    const before = E.evaluate(f, partner, 200, 3);
    const r = E.rng(11);
    for (let i = 0; i < 20; i++) f = E.train(f, partner, 10, { rng: r }).fighter;
    const after = E.evaluate(f, partner, 200, 3);
    assert.ok(after - before >= 0.25, `${partner}: ${before} -> ${after}`);
  }
});

test("instincts learn a rotating opponent's pattern", () => {
  let f = E.createFighter({ name: "ROOKIE", moves: BALANCED }, E.rng(7));
  const before = E.evaluate(f, "cycler", 200, 3);
  const r = E.rng(11);
  for (let i = 0; i < 40; i++) f = E.train(f, "cycler", 10, { rng: r }).fighter;
  assert.ok(E.evaluate(f, "cycler", 200, 3) - before >= 0.3);
  const map = Object.fromEntries(E.brainMap(f).map((row) => [row.vs, E.skillOf(f, row.best).style]));
  // the cycler goes aggro -> social -> mind -> guard: after each, the counter to the NEXT style
  assert.deepEqual([map.aggro, map.social, map.mind, map.guard], ["aggro", "social", "mind", "guard"]);
});

test("design matters: no Guard skill means no answer to a brawler", () => {
  const trained = (moves) => {
    let f = E.createFighter({ name: "X", moves }, E.rng(7));
    const r = E.rng(11);
    for (let i = 0; i < 20; i++) f = E.train(f, "brawler", 10, { rng: r }).fighter;
    return E.evaluate(f, "brawler", 200, 3);
  };
  assert.ok(trained(BALANCED) > trained(["fight", "deceive", "talk", "negotiate"]) + 0.3);
});

test("spar by hand: instincts imitate your choices", () => {
  const f = E.createFighter({ name: "PUPIL", moves: BALANCED }, E.rng(1));
  const spar = E.newSpar(f, "turtle");
  const ctx = E.ctxIndex(0, null, false);
  const before = E.policy(spar.state.side[0].f.brain, ctx, [1, 1, 1, 1, 0])[1];
  E.sparTurn(spar, 1, E.rng(1));   // PERSUADE on turn 1
  const after = E.policy(spar.state.side[0].f.brain, ctx, [1, 1, 1, 1, 0])[1];
  assert.ok(after > before, `${before} -> ${after}`);
  while (!spar.state.over) E.sparTurn(spar, 1, E.rng(2));
  const out = E.finishSpar(f, spar);
  assert.ok(out.xp > 0 && out.fighter.xp === out.xp);
  assert.ok(out.fighter.uses.talk > 0);
  assert.throws(() => { const s = E.newSpar(f, "turtle"); s.state.side[0].energy = 0; E.sparTurn(s, 2); }, /isn't available/);
});

test("train() returns a copy, a report and a capped history", () => {
  const f = E.createFighter({ name: "A", moves: BALANCED }, E.rng(1));
  const snapshot = JSON.stringify(f);
  const { fighter, report } = E.train(f, "talker", 10, { rng: E.rng(2) });
  assert.equal(JSON.stringify(f), snapshot);
  assert.equal(report.win + report.loss + report.draw, 10);
  assert.ok(report.xpGained > 0 && fighter.xp === report.xpGained);
  let g = fighter;
  for (let i = 0; i < 70; i++) g = E.train(g, "talker", 1, { rng: E.rng(i) }).fighter;
  assert.equal(g.history.length, 60);
  assert.ok(JSON.stringify(g).length < 30000, "fighter document stays small");
});

test("coaches stay locked until their level", () => {
  const f = E.createFighter({ moves: BALANCED });
  assert.throws(() => E.train(f, "vex", 1), /level 5/);
  assert.ok(!E.availablePartners(20).find((p) => p.id === "kade").locked);
});

// ---------------------------------------------------------------- fighters, migration
test("redesign keeps what a kept skill learned, and equips custom skills", () => {
  let f = E.createFighter({ moves: BALANCED }, E.rng(1));
  f = E.train(f, "brawler", 30, { rng: E.rng(2) }).fighter;
  const fb = E.validateSkill({ ...FIREBALL, id: "fireball" }).skill;
  const g = E.redesign(f, { moves: ["shield", "fireball", "talk", "observe"], custom: { fireball: fb } });
  for (let c = 0; c < 30; c++) { assert.equal(g.brain.W[c][0], f.brain.W[c][3]); assert.equal(g.brain.W[c][2], f.brain.W[c][1]); }
  assert.equal(E.skillOf(g, "fireball").name, "FIREBALL");
  assert.equal(g.uses.fireball, 0);
  assert.throws(() => E.redesign(f, { moves: ["fight", "fight", "talk", "code"] }));
});

test("fighters saved by rules v2 are upgraded without losing progress", () => {
  const W = Array.from({ length: 15 }, (_, c) => [c / 10, 0.5, -0.5, 1]);
  const old = { id: "fold1", name: "OLDIE", moves: BALANCED, level: 6, xp: 1000, personality: { aggression: 0.5, caution: 0.5, creativity: 0.5, loyalty: 0.5 },
                design: {}, uses: { fight: 50 }, brain: { W, b: Array(15).fill(0) }, record: { w: 3, l: 1, d: 0 }, version: 2, persona: "p", playbook: "- x" };
  const g = E.upgradeFighter(old);
  assert.equal(g.version, 3);
  assert.equal(g.brain.W.length, 30); assert.equal(g.brain.W[0].length, 5);
  assert.equal(g.brain.W[3][0], W[1][0], "old weights copied to both HP halves");
  assert.deepEqual([g.xp, g.level, g.uses.fight, g.persona], [1000, 6, 50, "p"]);
  assert.deepEqual(g.stats, { power: 0, vitality: 0, speed: 0 });
  assert.equal(E.unspentPoints(g), 5);
  assert.ok(E.fight(g, E.createFighter({ moves: BALANCED }), { rng: E.rng(1) }).turns.length > 0);
});

test("stepping a battle by hand equals fight()", () => {
  const f = E.createFighter({ name: "A", moves: BALANCED }, E.rng(1));
  const foe = E.partnerFighter("cycler", f);
  const whole = E.fight(E.clone(f), E.clone(foe), { rng: E.rng(5) });
  const r = E.rng(5), st = E.newBattle(E.clone(f), E.clone(foe));
  while (!st.over) E.resolveTurn(st, [E.instinctChoice(st, 0, r), E.instinctChoice(st, 1, r)], r);
  assert.deepEqual(E.finishBattle(st), whole);
});

test("real battles give 3x XP; rivals are deterministic with kits", () => {
  const f = E.createFighter({ moves: BALANCED });
  assert.equal(E.awardBattle(f, { winner: 0, agents: [{ level: 1 }, { level: 1 }] }, 0).xp, 90);
  assert.deepEqual(E.rivalFighter("sal"), E.rivalFighter("sal"));
  const kade = E.rivalFighter("kade");
  assert.equal(E.skillOf(kade, "inferno").name, "INFERNO");
  assert.ok(kade.passive && kade.item === "potion" && kade.rules.length === 1);
  const levels = E.RIVALS.map((r) => E.rivalFighter(r.id).level);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b));
});

// ---------------------------------------------------------------- arena
test("published fighters are re-validated: skills re-priced, stats and rules checked", () => {
  const fb = E.validateSkill({ ...FIREBALL, id: "fireball" }).skill;
  const mine = E.createFighter({ name: "PUB", moves: ["fireball", "talk", "code", "shield"], custom: { fireball: fb } });
  const pub = { ...E.toPublic(mine), level: 20 };                      // a level-20 fighter may carry stronger skills
  pub.custom.fireball.energy = 0;                                      // hand-edited to be free
  pub.custom.fireball.effects[0].power = 999;                         // and overpowered
  const ok = E.sanitizePublic(pub, "u_1");
  assert.equal(ok.custom.fireball.effects[0].power, 6);
  assert.ok(ok.custom.fireball.energy > 0, "re-priced");
  assert.equal(E.sanitizePublic({ ...pub, level: 1 }, "u_1").custom.fireball, undefined, "the same skill is too strong at level 1");
  const cheat = { ...E.toPublic(mine), level: 1, stats: { power: 40, vitality: 0, speed: 0 }, rules: [{ when: { kind: "x" }, do: {} }],
                  custom: { fireball: { name: "OP", style: "aggro", effects: [{ type: "damage", power: 6, hits: 3 }, { type: "stun", chance: 0.6 }] } } };
  const c = E.sanitizePublic(cheat, "u_2");
  assert.deepEqual(c.stats, { power: 0, vitality: 0, speed: 0 }, "too many stat points: reset");
  assert.deepEqual(c.rules, []);
  assert.ok(!c.custom.fireball, "a skill too strong for its level is dropped");
  assert.equal(c.moves.length, 4);
  assert.ok(E.fight(E.createFighter({ moves: BALANCED }), c, { rng: E.rng(1) }).turns.length > 0);
  const hostile = { ...E.toPublic(mine), name: "<img src=x onerror=alert(1)>", brain: { W: [[1]] }, design: { hue: "red" } };
  const h = E.sanitizePublic(hostile, "u_3");
  assert.ok(!/[<>]/.test(h.name)); assert.equal(h.brain.W.length, 30); assert.equal(h.design.hue, 200);
  for (const bad of [null, [], "x", { ...pub, id: "../etc" }, { ...pub, moves: ["fight"] }]) assert.equal(E.sanitizePublic(bad, "u"), null);
});

test("arena results: only your own fights count, Elo replays in time order", () => {
  const A = { owner: "u_a", id: "fa", name: "AYE" }, B = { owner: "u_b", id: "fb", name: "BEE" };
  assert.equal(E.sanitizeResult({ at: 1, a: B, b: A, winner: 0 }, "u_a"), null);
  const r1 = E.sanitizeResult({ at: 1, a: A, b: B, winner: 0 }, "u_a");
  const r2 = E.sanitizeResult({ at: 2, a: B, b: A, winner: 1 }, "u_b");
  const table = E.arenaRatings([r2, r1, r1]);
  assert.equal(table["u_a/fa"].w, 2);
  assert.equal(table["u_a/fa"].rating + table["u_b/fb"].rating, 2000);
});

test("aipvp command is shell-safe", () => {
  const f = E.createFighter({ name: "O'BRIEN", moves: BALANCED });
  assert.equal(E.aipvpCommand(f),
    "aipvp agent create --name 'O'\\''BRIEN' --skills fight,talk,strategize,shield --aggression 0.50 --caution 0.50 --creativity 0.50 --loyalty 0.50");
});
