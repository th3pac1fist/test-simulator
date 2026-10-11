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
