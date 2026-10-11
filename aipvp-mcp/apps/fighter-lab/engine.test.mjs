// Run: node --test apps/fighter-lab/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const E = createRequire(import.meta.url)("./engine.js");
const BALANCED = ["fight", "talk", "strategize", "shield"];

test("style cycle: each style beats the next and loses to the previous", () => {
  assert.equal(E.typeMult("aggro", "social"), 2);
  assert.equal(E.typeMult("social", "mind"), 2);
  assert.equal(E.typeMult("mind", "guard"), 2);
  assert.equal(E.typeMult("guard", "aggro"), 2);
  assert.equal(E.typeMult("social", "aggro"), 0.5);
  assert.equal(E.typeMult("aggro", "mind"), 1);
  assert.equal(E.typeMult("aggro", "aggro"), 1);
});

test("same seed, same fight", () => {
  const f = E.createFighter({ name: "A", moves: BALANCED }, E.rng(1));
  const a = E.exhibition(f, "brawler", 42).match;
  const b = E.exhibition(f, "brawler", 42).match;
  assert.deepEqual(a, b);
  assert.ok(a.turns.length >= 1 && a.turns.length <= 12);
  assert.ok(["win", "loss", "draw"].includes(a.result));
});

test("hp tracks damage and a knockout ends the match", () => {
  const { match } = E.exhibition(E.createFighter({ moves: BALANCED }), "brawler", 5);
  let hp = match.agents.map((a) => a.max);
  for (const t of match.turns) {
    hp = hp.map((h, i) => Math.max(0, Math.round((h - t.actions[1 - i].points) * 100) / 100));
    assert.deepEqual(t.hp, hp);
  }
  if (match.ko) assert.ok(match.turns.at(-1).hp.includes(0));
});

test("levels and mastery have caps and diminishing returns", () => {
  assert.equal(E.levelForXp(0), 1);
  assert.equal(E.levelForXp(1e9), E.MAX_LEVEL);
  for (let l = 2; l <= E.MAX_LEVEL; l++) assert.ok(E.xpForLevel(l) > E.xpForLevel(l - 1));
  assert.ok(E.masteryBonus(400) - E.masteryBonus(0) > E.masteryBonus(800) - E.masteryBonus(400));
  assert.ok(E.masteryBonus(1e6) <= 0.5);
});

test("training makes a fighter measurably stronger against each style", () => {
  for (const partner of ["brawler", "talker", "schemer", "turtle"]) {
    let f = E.createFighter({ name: "ROOKIE", moves: BALANCED }, E.rng(7));
    const before = E.evaluate(f, partner, 300, 3);
    const r = E.rng(11);
    for (let i = 0; i < 20; i++) f = E.train(f, partner, 10, { rng: r }).fighter;
    const after = E.evaluate(f, partner, 300, 3);
    assert.ok(after - before >= 0.25, `${partner}: ${before} -> ${after}`);
  }
});

test("the brain learns a pattern, not just a favourite move", () => {
  let f = E.createFighter({ name: "ROOKIE", moves: BALANCED }, E.rng(7));
  const before = E.evaluate(f, "cycler", 300, 3);
  const r = E.rng(5);
  for (let i = 0; i < 40; i++) f = E.train(f, "cycler", 10, { rng: r }).fighter;
  const after = E.evaluate(f, "cycler", 300, 3);
  assert.ok(after - before >= 0.2, `cycler: ${before} -> ${after}`);
  // The cycler goes aggro -> social -> mind -> guard. After each style the brain should
  // pick the counter to the style that comes NEXT, which means it predicted the rotation.
  const map = Object.fromEntries(E.brainMap(f).map((row) => [row.vs, E.SKILLS[row.best].style]));
  assert.deepEqual([map.aggro, map.social, map.mind, map.guard], ["aggro", "social", "mind", "guard"]);
});

test("design matters: no Guard moves means no answer to a brawler", () => {
  const trained = (moves) => {
    let f = E.createFighter({ name: "X", moves }, E.rng(7));
    const r = E.rng(11);
    for (let i = 0; i < 20; i++) f = E.train(f, "brawler", 10, { rng: r }).fighter;
    return E.evaluate(f, "brawler", 300, 3);
  };
  assert.ok(trained(BALANCED) > trained(["fight", "deceive", "talk", "negotiate"]) + 0.15);
});

test("train() returns a copy, a report and a capped history", () => {
  const f = E.createFighter({ name: "A", moves: BALANCED }, E.rng(1));
  const snapshot = JSON.stringify(f);
  const { fighter, report } = E.train(f, "talker", 10, { rng: E.rng(2) });
  assert.equal(JSON.stringify(f), snapshot);
  assert.equal(report.win + report.loss + report.draw, 10);
  assert.equal(report.curve.length, 10);
  assert.ok(report.xpGained > 0 && fighter.xp === report.xpGained);
  assert.ok(fighter.uses.fight + fighter.uses.talk + fighter.uses.strategize + fighter.uses.shield > 0);
  let g = fighter;
  for (let i = 0; i < 70; i++) g = E.train(g, "talker", 1, { rng: E.rng(i) }).fighter;
  assert.equal(g.history.length, 60);
  assert.ok(JSON.stringify(g).length < 20000, "fighter document stays small");
});

test("coaches stay locked until their level", () => {
  const f = E.createFighter({ moves: BALANCED });
  assert.throws(() => E.train(f, "vex", 1), /level 5/);
  assert.ok(E.availablePartners(1).find((p) => p.id === "kade").locked);
  assert.ok(!E.availablePartners(20).find((p) => p.id === "kade").locked);
});

test("redesign keeps what a kept move learned", () => {
  let f = E.createFighter({ moves: BALANCED }, E.rng(1));
  f = E.train(f, "brawler", 30, { rng: E.rng(2) }).fighter;
  const g = E.redesign(f, { moves: ["shield", "code", "talk", "observe"] });
  for (let c = 0; c < 15; c++) {
    assert.equal(g.brain.W[c][0], f.brain.W[c][3]); // shield
    assert.equal(g.brain.W[c][2], f.brain.W[c][1]); // talk
  }
  assert.equal(g.uses.shield, f.uses.shield);
  assert.equal(g.uses.code, 0);
  assert.throws(() => E.redesign(f, { moves: ["fight", "fight", "talk", "code"] }));
});

test("aipvp command is shell-safe", () => {
  const f = E.createFighter({ name: "O'BRIEN", moves: BALANCED });
  assert.equal(E.aipvpCommand(f),
    "aipvp agent create --name 'O'\\''BRIEN' --skills fight,talk,strategize,shield --aggression 0.50 --caution 0.50 --creativity 0.50 --loyalty 0.50");
});

test("stepping a battle by hand gives the same result as fight()", () => {
  const f = E.createFighter({ name: "A", moves: BALANCED }, E.rng(1));
  const foe = E.partnerFighter("cycler", f);
  const whole = E.fight(E.clone(f), E.clone(foe), { rng: E.rng(5) });
  const r = E.rng(5), st = E.newBattle(E.clone(f), E.clone(foe));
  while (!st.over) E.resolveTurn(st, [E.instinctChoice(st, 0, r), E.instinctChoice(st, 1, r)], r);
  assert.deepEqual(E.finishBattle(st), whole);
  assert.throws(() => E.resolveTurn(st, [{ skill: "fight" }, { skill: "fight" }], r), /over/);
});

test("a move the fighter doesn't know is rejected", () => {
  const st = E.newBattle(E.createFighter({ moves: BALANCED }), E.createFighter({ moves: BALANCED }));
  assert.throws(() => E.resolveTurn(st, [{ skill: "code" }, { skill: "fight" }], E.rng(1)), /doesn't know/);
});

test("old saved fighters are upgraded without losing progress", () => {
  const old = E.createFighter({ name: "OLD", moves: BALANCED }, E.rng(1));
  delete old.persona; delete old.playbook; delete old.rev; delete old.battleRecord; old.version = 1; old.xp = 500;
  const g = E.upgradeFighter(old);
  assert.equal(g.persona, ""); assert.equal(g.playbook, ""); assert.equal(g.rev, 0);
  assert.deepEqual(g.battleRecord, { w: 0, l: 0, d: 0 });
  assert.equal(g.xp, 500); assert.deepEqual(g.brain, old.brain);
});

test("real battles give 3x XP and a battle record", () => {
  const f = E.createFighter({ moves: BALANCED });
  const match = { winner: 0, agents: [{ level: 1 }, { level: 1 }] };
  const out = E.awardBattle(f, match, 0);
  assert.equal(out.result, "win"); assert.equal(out.xp, 90); assert.equal(out.fighter.battleRecord.w, 1);
  assert.equal(E.awardBattle(f, { winner: null, agents: match.agents }, 0).result, "draw");
});

test("rivals are deterministic and climb in level", () => {
  assert.deepEqual(E.rivalFighter("sal"), E.rivalFighter("sal"));
  const levels = E.RIVALS.map((r) => E.rivalFighter(r.id).level);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b));
  assert.ok(E.rivalFighter("kade").persona.length > 0);
});

test("published fighters from other players are sanitized", () => {
  const mine = E.toPublic(E.createFighter({ name: "PUB", moves: BALANCED }));
  const ok = E.sanitizePublic(mine, "u_1");
  assert.equal(ok.name, "PUB"); assert.equal(ok.owner, "u_1");
  const hostile = {
    ...mine, name: "<img src=x onerror=alert(1)>", persona: "x".repeat(5000), playbook: "a\u0000b\nc",
    level: 9999, uses: { fight: 1e12, talk: "lots" }, design: { hue: "red", body: "<script>", spikes: 99, armor: "yes" },
    personality: { aggression: 7 }, brain: { W: [[1, 2]], b: [] },
  };
  const h = E.sanitizePublic(hostile, "u_2");
  assert.equal(h.name, "IMG SRCX ONERR"); // cut to 16 characters, then unsafe characters removed
  assert.ok(!/[<>]/.test(h.name));
  assert.equal(h.persona.length, E.PERSONA_MAX);
  assert.equal(h.playbook, "a b\nc");
  assert.equal(h.level, E.MAX_LEVEL);
  assert.equal(h.uses.fight, 1e6); assert.equal(h.uses.talk, 0);
  assert.deepEqual([h.design.hue, h.design.body, h.design.spikes, h.design.armor], [200, "round", 3, false]);
  assert.equal(h.personality.aggression, 1);
  assert.equal(h.brain.W.length, 15); // malformed brain replaced with a fresh one
  // and the engine can fight with it
  assert.ok(E.fight(E.createFighter({ moves: BALANCED }), h, { rng: E.rng(1) }).turns.length > 0);
  for (const bad of [null, [], "x", { ...mine, id: "../etc" }, { ...mine, moves: ["fight", "fight", "talk", "code"] }, { ...mine, moves: ["fight", "talk", "code", "__proto__"] }])
    assert.equal(E.sanitizePublic(bad, "u"), null);
});

test("arena results: only your own fights count, Elo replays in time order", () => {
  const A = { owner: "u_a", id: "fa", name: "AYE" }, B = { owner: "u_b", id: "fb", name: "BEE" };
  assert.equal(E.sanitizeResult({ at: 1, a: B, b: A, winner: 0 }, "u_a"), null); // u_a can't record B's fights
  const r1 = E.sanitizeResult({ at: 1, a: A, b: B, winner: 0 }, "u_a");
  const r2 = E.sanitizeResult({ at: 2, a: B, b: A, winner: 1 }, "u_b");
  const table = E.arenaRatings([r2, r1, r1]); // out of order, duplicated
  assert.equal(table["u_a/fa"].w, 2); assert.equal(table["u_b/fb"].l, 2);
  assert.ok(table["u_a/fa"].rating > 1000 && table["u_b/fb"].rating < 1000);
  assert.equal(table["u_a/fa"].rating + table["u_b/fb"].rating, 2000);
});
