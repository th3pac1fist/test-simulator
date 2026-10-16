// Item balance: each item with its best rule, against the same fighter without an item and against early rivals.
//   node tools/item-balance.cjs [potionHeal=0.15]      env: ITEMS_ONLY=1 skips the stat section
const E = require("../engine.js");
if (process.argv[2]) E.ITEMS.potion.heal = Number(process.argv[2]);
const TRAIN = ["brawler", "talker", "schemer", "turtle", "cycler"];
const LOADOUTS = [["fight", "negotiate", "code", "shield"], ["fight", "talk", "strategize", "shield"], ["deceive", "debate", "code", "analyze"]];
function make(moves, lv, opt, seed) {
  let f = E.createFighter({ name: "T", moves, item: opt.item || null, passive: opt.passive || null }, E.rng(seed)); f.level = lv; f.xp = E.xpForLevel(lv);
  if (opt.stats) f = E.setStats(f, opt.stats);
  if (opt.rules) f.rules = E.sanitizeRules(opt.rules, f.moves);
  const r = E.rng(seed + 3);
  for (let i = 0; i < 200; i++) E.fight(f, E.partnerFighter(TRAIN[i % 5], f), { rng: r, learnA: true });
  return f;
}
const pts = (r) => (r === "win" ? 1 : r === "draw" ? 0.5 : 0);
function h2h(a, b, n, seed) { const r = E.rng(seed); let s = 0; for (let i = 0; i < n; i++) s += pts(E.fight(E.clone(a), E.clone(b), { rng: r }).result); return s / n; }
if (!process.env.ITEMS_ONLY) {
console.log("== Power vs Vitality head-to-head (all points one way; same loadout and training)");
for (const lv of [4, 15, 35]) {
  const n = lv - 1; let tot = 0, k = 0;
  for (const mv of LOADOUTS) for (const seed of [1, 2]) { const A = make(mv, lv, { stats: { power: n, vitality: 0, speed: 0 } }, 10 * seed); const B = make(mv, lv, { stats: { power: 0, vitality: n, speed: 0 } }, 10 * seed); tot += h2h(A, B, 150, 77 * seed); k++; }
  const sp = (() => { let t = 0, c = 0; for (const mv of LOADOUTS) { const A = make(mv, lv, { stats: { power: n, vitality: 0, speed: 0 } }, 5); const C = make(mv, lv, { stats: { power: 0, vitality: 0, speed: n } }, 5); t += h2h(A, C, 150, 9); c++; } return t / c; })();
  console.log(`L${lv}: power vs vitality ${(tot / k).toFixed(3)}  power vs speed ${sp.toFixed(3)}`);
}
}
console.log("== Items with their best rule vs the same fighter with no item (head-to-head and vs field)");
const RULES = {
  potion: [[{ when: { kind: "my_hp_below", value: 35 }, do: { item: true } }], [{ when: { kind: "my_hp_below", value: 50 }, do: { item: true } }], []],
  ether: [[{ when: { kind: "my_energy_below", value: 2 }, do: { item: true } }], [{ when: { kind: "phase_is", value: "endgame" }, do: { item: true } }], []],
  antidote: [[{ when: { kind: "i_have", value: "burn" }, do: { item: true } }], [{ when: { kind: "i_have", value: "poison" }, do: { item: true } }], []],
  smoke: [[{ when: { kind: "their_last_style", value: "aggro" }, do: { item: true } }], [{ when: { kind: "my_hp_below", value: 50 }, do: { item: true } }], [{ when: { kind: "phase_is", value: "endgame" }, do: { item: true } }], []],
};
const field = ["sal", "velvet", "grid"].map((id) => E.rivalFighter(id));
for (const lv of [4, 15]) {
  const res = {};
  for (const [item, opts] of Object.entries({ none: [[]], ...RULES })) {
    let best = -1, bestRule = null;
    for (const rules of opts) {
      let tot = 0, k = 0;
      for (const mv of LOADOUTS) {
        const me = make(mv, lv, { item: item === "none" ? null : item, rules }, 3);
        const base = make(mv, lv, {}, 3);
        tot += h2h(me, base, 120, 5); k++;
        for (const foe of field) { const r = E.rng(11); let s = 0; for (let i = 0; i < 60; i++) s += pts(E.fight(E.clone(me), E.clone(foe), { rng: r }).result); tot += s / 60; k++; }
      }
      const sc = tot / k; if (sc > best) { best = sc; bestRule = rules[0] ? `${rules[0].when.kind}=${rules[0].when.value}` : "no rule"; }
    }
    res[item] = `${best.toFixed(3)} (${bestRule})`;
  }
  console.log(`L${lv}`, JSON.stringify(res));
}
