// Calibrate weapon prices (WPRICE in engine.js): single-effect weapons of the same power should win about equally.
//   node tools/calibrate-weapons.cjs [rounds=3]     env: START='{"edge":6.8,...}' STEP=1.0 BUDGET=1.5
const E = require("../engine.js");
const TRAIN = ["brawler", "talker", "schemer", "turtle", "cycler"];
const pts = (r) => (r === "win" ? 1 : r === "draw" ? 0.5 : 0);
if (process.env.START) Object.assign(E.WPRICE, JSON.parse(process.env.START));
const STEP = Number(process.env.STEP || 1.3), BUDGET = Number(process.env.BUDGET || 1.5);
const W = {
  edge: (b) => ({ type: "edge", style: "aggro", pct: b / E.WPRICE.edge }),
  rider: (b) => ({ type: "rider", style: "aggro", status: "burn", chance: b / E.WPRICE.rider }),
  crit: (b) => ({ type: "crit", chance: b / E.WPRICE.crit }),
  lifesteal: (b) => ({ type: "lifesteal", pct: b / E.WPRICE.lifesteal }),
  guard: (b) => ({ type: "guard", amount: b / E.WPRICE.guard }),
  evade: (b) => ({ type: "evade", pct: b / E.WPRICE.evade }),
};
const keys = Object.keys(W);
function roundRobin(L) {
  const make = (k, seed, mv) => {
    const w = E.validateSkill({ name: k, kind: "weapon", effects: [W[k](BUDGET)] }).skill;
    let f = E.createFighter({ name: k, moves: mv, weapon: { ...w, id: "w_" + k } }, E.rng(seed)); f.level = L; f.xp = E.xpForLevel(L);
    const n = L - 1, a = Math.floor(n / 3); f = E.setStats(f, { power: a, vitality: a, speed: n - 2 * a });
    const r = E.rng(seed + 1); for (let i = 0; i < 200; i++) E.fight(f, E.partnerFighter(TRAIN[i % 5], f), { rng: r, learnA: true });
    return { f, budget: w.budget };
  };
  const score = Object.fromEntries(keys.map((k) => [k, 0])), games = Object.fromEntries(keys.map((k) => [k, 0]));
  const budgets = {};
  for (const mv of [["fight", "negotiate", "code", "shield"], ["fight", "debate", "strategize", "analyze"]]) for (const seed of [1, 2, 3]) {
    const fs = Object.fromEntries(keys.map((k) => { const x = make(k, seed * 10, mv); budgets[k] = x.budget; return [k, x.f]; }));
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const r = E.rng(seed * 100 + i * 9 + j); let s = 0; const N = 30;
      for (let k = 0; k < N; k++) s += pts(E.fight(E.clone(fs[keys[i]]), E.clone(fs[keys[j]]), { rng: r }).result);
      score[keys[i]] += s; score[keys[j]] += N - s; games[keys[i]] += N; games[keys[j]] += N;
    }
  }
  return { w: Object.fromEntries(keys.map((k) => [k, score[k] / games[k]])), budgets };
}
const rounds = Number(process.argv[2] || 3);
for (let round = 0; round <= rounds; round++) {
  const a = roundRobin(5), b = roundRobin(25);
  const w = Object.fromEntries(keys.map((k) => [k, (a.w[k] + b.w[k]) / 2]));
  console.log(`round ${round}: ` + keys.map((k) => `${k} ${w[k].toFixed(2)} (${a.w[k].toFixed(2)}/${b.w[k].toFixed(2)}) b${a.budgets[k]}`).join("  "));
  console.log("  WPRICE", JSON.stringify(Object.fromEntries(Object.entries(E.WPRICE).map(([k, v]) => [k, Math.round(v * 1000) / 1000]))));
  if (round === rounds) break;
  for (const k of keys) E.WPRICE[k] *= Math.exp(STEP * (w[k] - 0.5));
}
