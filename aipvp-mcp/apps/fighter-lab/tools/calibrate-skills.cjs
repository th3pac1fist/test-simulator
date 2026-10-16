// Calibrate skill effect prices (PRICE in engine.js): forged archetypes of equal power should win about equally.
// Round-robins at levels 4 and 20, then nudges each effect's price toward 50% wins. Copy the final PRICE into engine.js.
//   node tools/calibrate-skills.cjs [rounds=4]      env: START='{"drain":0.7,...}' STEP=1.3
const E = require("../engine.js");
const O = require("../optimizer.js");
const TRAIN = ["brawler", "talker", "schemer", "turtle", "cycler"];
const pts = (r) => (r === "win" ? 1 : r === "draw" ? 0.5 : 0);
const archs = Object.keys(O.ARCHETYPES);
function roundRobin(L, seeds) {
  const opts = O.options({ level: L, fighter: E.createFighter({ moves: ["fight", "talk", "strategize", "shield"] }), library: [], unlocked: new Set(Object.keys(E.FAMILIES)) });
  const make = (style, arch, seed) => {
    const base = { aggro: "fight", social: "negotiate", mind: "code", guard: "observe" };   // plain guard: no clause clashes
    const o = opts.skills[style].find((x) => x.arch === arch);
    const moves = E.STYLES.map((st) => (st === style ? o.id : base[st]));
    let f = E.createFighter({ name: arch, moves, custom: { [o.id]: o.skill } }, E.rng(seed)); f.level = L; f.xp = E.xpForLevel(L);
    const n = L - 1, a = Math.floor(n / 3); f = E.setStats(f, { power: a, vitality: a, speed: n - 2 * a });
    const r = E.rng(seed + 1); for (let i = 0; i < 200; i++) E.fight(f, E.partnerFighter(TRAIN[i % 5], f), { rng: r, learnA: true });
    return f;
  };
  const score = Object.fromEntries(archs.map((a) => [a, 0])), games = Object.fromEntries(archs.map((a) => [a, 0]));
  for (const style of ["mind", "social", "aggro"]) for (const seed of seeds) {
    const fs = Object.fromEntries(archs.map((a) => [a, make(style, a, seed * 10)]));
    for (let i = 0; i < archs.length; i++) for (let j = i + 1; j < archs.length; j++) {
      const r = E.rng(seed * 100 + i * 9 + j); let s = 0; const N = 30;
      for (let k = 0; k < N; k++) s += pts(E.fight(E.clone(fs[archs[i]]), E.clone(fs[archs[j]]), { rng: r }).result);
      score[archs[i]] += s; score[archs[j]] += N - s; games[archs[i]] += N; games[archs[j]] += N;
    }
  }
  return Object.fromEntries(archs.map((a) => [a, score[a] / games[a]]));
}
const KEY = { drain: ["drain"], burn: ["burn"], stun: ["stun"], weaken: ["weaken"], focus: ["focus"], wall: ["shieldBase", "shieldTurn"] };
const rounds = Number(process.argv[2] || 4);
if (process.env.START) Object.assign(E.PRICE, JSON.parse(process.env.START));
const STEP = Number(process.env.STEP || 1.6);
for (let round = 0; round <= rounds; round++) {
  const a = roundRobin(4, [1, 2]), b = roundRobin(20, [1, 2]);
  const w = Object.fromEntries(archs.map((k) => [k, (a[k] + b[k]) / 2]));
  console.log(`round ${round}: ` + archs.map((k) => `${k} ${w[k].toFixed(2)} (${a[k].toFixed(2)}/${b[k].toFixed(2)})`).join("  "));
  console.log("  PRICE", JSON.stringify(Object.fromEntries(Object.entries(E.PRICE).map(([k, v]) => [k, Math.round(v * 1000) / 1000]))));
  if (round === rounds) break;
  for (const [arch, keys] of Object.entries(KEY)) for (const k of keys) E.PRICE[k] *= Math.exp(STEP * (w[arch] - 0.5));
}
