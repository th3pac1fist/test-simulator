// Stat balance: all-Power vs all-Vitality vs all-Speed head-to-heads at levels 4, 15 and 35 (about 0.5 is balanced).
//   node tools/stats-balance.cjs [speedPct] [dodgeCap]      env: VIT=0.04
const E = require("../engine.js");
if (process.env.VIT) E.STAT_PCT.vitality = Number(process.env.VIT);
if (process.argv[2]) E.STAT_PCT.speed = Number(process.argv[2]); if (process.argv[3]) E.STAT_PCT.dodgeCap = Number(process.argv[3]);
const TRAIN = ["brawler", "talker", "schemer", "turtle", "cycler"];
const LOADOUTS = [["fight", "negotiate", "code", "shield"], ["fight", "talk", "strategize", "shield"], ["deceive", "debate", "code", "analyze"], ["fight", "debate", "search", "observe"]];
const pts = (r) => (r === "win" ? 1 : r === "draw" ? 0.5 : 0);
function make(moves, lv, stats, seed) { let f = E.createFighter({ name: "T", moves }, E.rng(seed)); f.level = lv; f.xp = E.xpForLevel(lv); f = E.setStats(f, stats); const r = E.rng(seed + 3); for (let i = 0; i < 200; i++) E.fight(f, E.partnerFighter(TRAIN[i % 5], f), { rng: r, learnA: true }); return f; }
for (const lv of [4, 15, 35]) {
  const n = lv - 1, D = { P: { power: n, vitality: 0, speed: 0 }, V: { power: 0, vitality: n, speed: 0 }, S: { power: 0, vitality: 0, speed: n } };
  const pair = (a, b) => { let s = 0, N = 0; for (const mv of LOADOUTS) for (const seed of [1, 2, 3, 4, 5, 6]) { const A = make(mv, lv, D[a], 10 * seed), B = make(mv, lv, D[b], 10 * seed); const r = E.rng(seed * 31 + lv); for (let i = 0; i < 80; i++) { s += pts(E.fight(E.clone(A), E.clone(B), { rng: r }).result); N++; } } return (s / N).toFixed(3); };
  console.log(`vit ${E.STAT_PCT.vitality} speed ${E.STAT_PCT.speed} cap ${E.STAT_PCT.dodgeCap} L${lv}: P vs V ${pair("P", "V")}  P vs S ${pair("P", "S")}  V vs S ${pair("V", "S")}`);
}
