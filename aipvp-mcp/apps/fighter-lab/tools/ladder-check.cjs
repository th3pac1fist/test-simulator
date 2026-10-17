// Rival ladder check. "basic": a typically trained player with basic skills one level below each rival.
// "pro": Pro builds at levels 14 and 19 with the badges a player would have by then.
//   node tools/ladder-check.cjs [basic|pro]
const E = require("../engine.js");
const O = require("../optimizer.js");
const TRAIN = ["brawler", "talker", "schemer", "turtle", "cycler"];
const pts = (r) => (r === "win" ? 1 : r === "draw" ? 0.5 : 0);
function trained(level, seed, rounds) {
  let f = E.createFighter({ name: "P", moves: ["fight", "talk", "strategize", "shield"] }, E.rng(seed));
  f.level = level; f.xp = E.xpForLevel(level);
  const n = level - 1, a = Math.floor(n / 3);
  f = E.setStats(f, { power: a, vitality: a, speed: n - 2 * a });
  const r = E.rng(seed + 9);
  for (let i = 0; i < rounds; i++) E.fight(f, E.partnerFighter(TRAIN[i % 5], f), { rng: r, learnA: true });
  return f;
}
async function main(mode) {
  if (mode === "pro") {
    for (const [L, beaten] of [[14, ["sal", "velvet", "grid"]], [19, ["sal", "velvet", "grid", "bastion"]]]) {
      const res = await O.optimize({ fighter: trained(L, 2, 500), balance: 250, beaten, seed: 5, effort: "full" });
      console.log(`L${L} pro build: ${res.build.names.join(", ")} | weapon ${res.build.weapon ? res.build.weapon.name : "none"} | passive ${res.build.passive ? res.build.passive.name : "none"} | cost ${res.build.cost}`);
      console.log("   pro:", res.score.rivals.map((x) => `${x.label} ${x.rate}`).join(", "), "| basic only:", res.baseline.rivals.map((x) => `${x.label} ${x.rate}`).join(", "));
    }
    return;
  }
  const out = [];
  for (const rv of E.RIVALS.slice(0, 6)) {
    const lv = Math.max(1, rv.level - 1);
    let tot = 0;
    for (const seed of [1, 2, 3, 4]) {
      const f = trained(lv, seed, 300), foe = E.rivalFighter(rv.id), r = E.rng(seed * 13);
      for (let i = 0; i < 100; i++) tot += pts(E.fight(E.clone(f), E.clone(foe), { rng: r }).result);
    }
    out.push(`${rv.id}(L${rv.level}) ${(tot / 400).toFixed(2)}`);
  }
  console.log("basic-skills player one level below each rival:", out.join("  "));
}
main(process.argv[2] || "basic").catch((e) => { console.error(e); process.exit(1); });
