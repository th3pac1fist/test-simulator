// Run: node --test apps/fighter-lab/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = require("./engine.js");
const A = require("./agent.js");
const BALANCED = ["fight", "talk", "strategize", "shield"];

/** A fake `sample`: answers with `answer(prompt, n)` after a short delay; records every call. */
function fakeSample(answer, { delay = 2 } = {}) {
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  const json = async (prompt, opts) => {
    const n = calls.length;
    calls.push({ prompt, opts });
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((res, rej) => {
        const t = setTimeout(res, delay);
        opts?.signal?.addEventListener("abort", () => { clearTimeout(t); rej({ code: "cancelled", message: "aborted" }); });
      });
      return await answer(prompt, n);
    } finally { inFlight--; }
  };
  const fn = async () => { throw new Error("use json"); };
  fn.json = json;
  return { sample: fn, calls, get maxInFlight() { return maxInFlight; } };
}
const nameOf = (prompt) => /You are the battle brain of (.+?), a fighter/.exec(prompt)[1];
const firstMove = (prompt) => /YOUR MOVES[^\n]*\n- (\w+):/.exec(prompt)[1];

function pair() {
  const me = E.createFighter({ name: "HERO", moves: BALANCED }, E.rng(1));
  me.persona = "Patient. Read them first.";
  const foe = E.rivalFighter("velvet");
  foe.persona = "SECRET-PERSONA-123"; foe.playbook = "- SECRET-PLAYBOOK";
  return { me, foe };
}

test("an all-AI battle finishes, with Claude's moves and lines on every turn", async () => {
  const { me, foe } = pair();
  const f = fakeSample((p) => ({ move: firstMove(p), line: `${nameOf(p)} SECRET-LINE says hi` }));
  const seen = [];
  const out = await A.runAiBattle({ a: me, b: foe, sample: f.sample, rng: E.rng(3), onTurn: (t) => seen.push(t) });
  assert.ok(out.match.turns.length >= 1 && out.match.turns.length <= 12);
  assert.equal(seen.length, out.match.turns.length);
  for (const t of out.match.turns) for (const a of t.actions) { assert.equal(a.source, "ai"); assert.match(a.line, /says hi/); }
  assert.equal(out.stats.instinct, 0);
  assert.equal(f.calls.length, 2 * out.match.turns.length);
  assert.ok(f.maxInFlight <= 2, "never more than 2 Claude requests at once");
  for (const c of f.calls) { assert.equal(c.opts.cache, false); assert.equal(c.opts.modelTier, "quick"); }
});

test("a fighter's prompt never contains the opponent's persona, playbook or lines", async () => {
  const { me, foe } = pair();
  const f = fakeSample((p) => ({ move: firstMove(p), line: "SECRET-LINE" }));
  await A.runAiBattle({ a: me, b: foe, sample: f.sample, rng: E.rng(3) });
  const heroPrompts = f.calls.filter((c) => nameOf(c.prompt) === "HERO").map((c) => c.prompt);
  assert.ok(heroPrompts.length > 0);
  for (const p of heroPrompts) {
    assert.ok(!p.includes("SECRET-PERSONA-123") && !p.includes("SECRET-PLAYBOOK") && !p.includes("SECRET-LINE"));
    assert.ok(p.includes("Patient. Read them first."));
  }
  // and each fighter does get its own persona
  assert.ok(f.calls.some((c) => nameOf(c.prompt) === "VELVET" && c.prompt.includes("SECRET-PERSONA-123")));
});

test("both picks for a turn are made from the same completed turns", async () => {
  const { me, foe } = pair();
  const f = fakeSample((p) => ({ move: firstMove(p), line: "" }));
  await A.runAiBattle({ a: me, b: foe, sample: f.sample, rng: E.rng(3) });
  for (let k = 0; k < f.calls.length; k += 2) {
    const turnOf = (p) => +/NOW: turn (\d+)/.exec(p)[1];
    const histOf = (p) => (p.match(/^T\d+: you /gm) || []).length;
    const [x, y] = [f.calls[k].prompt, f.calls[k + 1].prompt];
    assert.equal(turnOf(x), turnOf(y));
    assert.equal(histOf(x), turnOf(x) - 1);
    assert.equal(histOf(y), turnOf(y) - 1);
  }
});

test("bad answers fall back to instincts for that turn only", async () => {
  const { me, foe } = pair();
  const f = fakeSample((p, n) => {
    if (nameOf(p) !== "HERO") return { move: firstMove(p), line: "ok" };
    if (n % 3 === 0) throw { code: "invalid_json", message: "no json" };
    if (n % 3 === 1) return { move: "laser-eyes", line: "x" };
    return { move: "BULWARK", line: "by name" }; // move given by its name, not its id
  });
  const out = await A.runAiBattle({ a: me, b: foe, sample: f.sample, rng: E.rng(3) });
  const hero = out.match.turns.map((t) => t.actions[0]);
  assert.ok(hero.some((a) => a.source === "instinct"));
  assert.ok(hero.some((a) => a.source === "ai" && a.skill === "shield"));
  assert.ok(out.stats.reasons.invalid_json || out.stats.reasons.invalid_reply);
  assert.equal(out.stoppedReason, null);
  assert.ok(out.match.turns.every((t) => t.actions[1].source === "ai"));
});

test("rate limiting switches the rest of the battle to instincts, without retrying", async () => {
  const { me, foe } = pair();
  let n = 0;
  const f = fakeSample((p) => { if (++n === 5) throw { code: "rate_limited", message: "slow down" }; return { move: firstMove(p), line: "" }; });
  const out = await A.runAiBattle({ a: me, b: foe, sample: f.sample, rng: E.rng(3) });
  assert.equal(out.stoppedReason, "rate_limited");
  assert.ok(f.calls.length <= 6, `stopped calling Claude (made ${f.calls.length} calls)`);
  const last = out.match.turns.at(-1);
  assert.ok(last.actions.every((a) => a.source === "instinct"));
});

test("Claude declined: every move comes from instincts and the battle still finishes", async () => {
  const { me, foe } = pair();
  const f = fakeSample(() => { throw { code: "not_granted", message: "no" }; });
  const out = await A.runAiBattle({ a: me, b: foe, sample: f.sample, rng: E.rng(3) });
  assert.equal(out.stoppedReason, "not_granted");
  assert.ok(f.calls.length <= 2);
  assert.ok(out.match.turns.length >= 1);
});

test("no sample at all means an instinct battle", async () => {
  const { me, foe } = pair();
  const out = await A.runAiBattle({ a: me, b: foe, sample: null, rng: E.rng(3) });
  assert.equal(out.stats.ai, 0);
  assert.ok(out.match.turns.every((t) => t.actions.every((a) => a.source === "instinct")));
});

test("Stop cancels the battle and pending Claude requests", async () => {
  const { me, foe } = pair();
  const ctl = new AbortController();
  const f = fakeSample((p) => ({ move: firstMove(p), line: "" }), { delay: 30 });
  const run = A.runAiBattle({ a: me, b: foe, sample: f.sample, rng: E.rng(3), signal: ctl.signal,
    onTurn: (t) => { if (t.turn === 2) ctl.abort(); } });
  await assert.rejects(run, (e) => e instanceof A.Cancelled);
  const callsAtStop = f.calls.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(f.calls.length, callsAtStop, "no requests after Stop");
});

test("pace() holds the next turn until the page is ready", async () => {
  const { me, foe } = pair();
  const f = fakeSample((p) => ({ move: firstMove(p), line: "" }), { delay: 0 });
  let release;
  let paced = 0;
  const run = A.runAiBattle({ a: me, b: foe, sample: f.sample, rng: E.rng(3),
    pace: () => { paced++; return paced <= 2 ? Promise.resolve() : new Promise((r) => (release = r)); } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.calls.length, 4, "only 2 turns requested while the page is busy");
  // let it run to the end
  const drain = setInterval(() => release && release(), 1);
  await run; clearInterval(drain);
});

test("the original fighters are not modified by a battle", async () => {
  const { me, foe } = pair();
  const before = JSON.stringify([me, foe]);
  const f = fakeSample((p) => ({ move: firstMove(p), line: "" }));
  await A.runAiBattle({ a: me, b: foe, sample: f.sample, rng: E.rng(3), learnA: true });
  assert.equal(JSON.stringify([me, foe]), before);
});

test("prompts stay small even with maximum-length text", () => {
  const { me, foe } = pair();
  me.persona = "p".repeat(5000); me.playbook = "- x\n".repeat(2000);
  const st = E.newBattle(me, foe);
  const r = E.rng(1);
  while (!st.over) E.resolveTurn(st, [E.instinctChoice(st, 0, r), E.instinctChoice(st, 1, r)], r);
  st.over = false; st.turn = 12;
  const p = A.turnPrompt(st, 0);
  assert.ok(p.length < 8000, `prompt is ${p.length} chars`);
});

test("parseTurn accepts ids or names and cleans the line", () => {
  assert.deepEqual(A.parseTurn({ move: "Strike", line: '  "Take\nthat!"  ' }, BALANCED), { skill: "fight", line: "Take that!" });
  assert.deepEqual(A.parseTurn('{"move":"shield"}', BALANCED), { skill: "shield", line: "" });
  assert.equal(A.parseTurn({ move: "code" }, BALANCED), null);
  assert.equal(A.parseTurn("nope", BALANCED), null);
  assert.equal(A.parseTurn({ move: "talk", line: "x".repeat(300) }, BALANCED).line.length, 88);
});

test("the coach rewrites the playbook within limits", async () => {
  const { me } = pair();
  const report = E.train(me, "brawler", 10, { rng: E.rng(2) }).report;
  const prompt = A.coachPrompt(me, A.gymSummary(report));
  assert.match(prompt, /BRAWLER/); assert.match(prompt, /INSTINCTS LEARNED/);
  const long = Array.from({ length: 20 }, (_, i) => `lesson ${i}`).join("\n");
  const out = A.parseCoach({ playbook: long, comment: "c".repeat(500) });
  assert.equal(out.playbook.split("\n").length, 8);
  assert.ok(out.playbook.split("\n").every((l) => l.startsWith("- ")));
  assert.equal(out.comment.length, 200);
  assert.equal(A.parseCoach({ playbook: "" }), null);
  const f = fakeSample(() => ({ playbook: "- Block brawlers with BULWARK", comment: "Nice." }));
  assert.deepEqual(await A.coach(f.sample, me, "x"), { playbook: "- Block brawlers with BULWARK", comment: "Nice." });
  assert.equal(f.calls[0].opts.cache, false);
});
