// Run the Pro build optimizer from the command line, on a saved fighter (JSON, as stored in data/users/<id>) or a level-4 sample.
//   node tools/optimize.cjs [fighter.json|-] [balance=100] [effort=full|quick]
const E = require("../engine.js");
const O = require("../optimizer.js");
const fs = require("fs");
let f;
if (process.argv[2] && process.argv[2] !== "-") { const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); f = E.upgradeFighter(raw.data || raw); }
else { f = E.createFighter({ name: "QUILLISH", moves: ["fight", "talk", "strategize", "shield"] }, E.rng(4)); f.level = 4; f.xp = E.xpForLevel(4); }
const balance = Number(process.argv[3] || 100), effort = process.argv[4] || "full";
(async () => {
  const t = Date.now(); let lastLabel = "";
  const res = await O.optimize({ fighter: f, library: [], inventory: {}, balance, beaten: [], arena: [], seed: 7, effort,
    onProgress: (x, label) => { if (label !== lastLabel) { lastLabel = label; process.stderr.write(`  ${Math.round(x * 100)}% ${label}\n`); } } });
  console.log("time", (Date.now() - t) / 1000, "s, evaluated", res.evaluated, "kept current:", res.keptCurrent);
  const b = res.build;
  console.log("BUILD:", b.names.join(", "), "| passive:", b.passive && b.passive.name, "| item:", b.item, "| stats:", JSON.stringify(b.stats), "| rules:", b.rules.map((r) => E.describeRule(r, { item: b.item, custom: Object.fromEntries(b.skills.filter(Boolean).map((s) => [s.id, s])) })).join(" "), "| cost:", b.cost);
  for (const x of b.forge) console.log("  forge", x.skill.name, "(" + x.cost + "):", E.describeSkill(x.skill));
  const show = (s) => `overall ${s.overall} | rivals ${s.rivals.map((r) => r.label + " " + r.rate).join(", ")} | partners ${s.partners.map((r) => r.label + " " + r.rate).join(", ")} | meta ${s.meta}`;
  console.log("NEW: ", show(res.score), "| field", res.score.field); console.log("OLD: ", show(res.baseline), "| field", res.baseline.field);
  if (res.saveUpFor) console.log("SAVE UP FOR:", res.saveUpFor.build.names.join(", "), res.saveUpFor.build.cost, "Cycles, overall", res.saveUpFor.score.overall);
  console.log("REASONS:\n  " + res.reasons.join("\n  "));
  console.log("TRAINING:", res.training.map((t) => t.tip).join(" "));
  console.log("PATH:", JSON.stringify(res.path.map((p) => ({ L: p.level, forge: p.forge.map((x) => `${x.name}${x.replaces ? " replaces " + x.replaces : " (upgrade)"} ${x.cost}c`), stats: p.stats, rival: p.rival }))));
})().catch((e) => { console.error(e); process.exit(1); });
