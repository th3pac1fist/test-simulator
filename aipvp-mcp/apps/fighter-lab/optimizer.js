/* Fighter Lab Pro build: searches for the strongest fair build for one fighter.
 * Fair means legal at the fighter's level (every skill re-validated), only from effect families the
 * player has unlocked, within the rulebook's clauses, and affordable with the player's Cycles. Builds are scored by simulated battles against the rival ladder, the gym
 * partners, published arena fighters and a meta pool of the other finalists.
 * Pure logic, no DOM; async so the page stays responsive, cancellable, deterministic per seed. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./engine.js"), require("./economy.js"));
  else root.FighterOptimizer = factory(root.FighterEngine, root.FighterEconomy);
})(typeof self !== "undefined" ? self : this, function (E, ECON) {
  "use strict";

  // ---------- what can be forged: archetypes, fitted to the level cap ----------
  // Each archetype is written at the top of its effects' ranges; fitSkill scales it down to the
  // fighter's power limit, so the same idea grows stronger as the fighter levels up.
  const ARCHETYPES = {
    big:    { why: "the hardest single hit you can forge at this level", effects: [{ type: "damage", power: 6, hits: 1 }],
              names: { aggro: "BLAST", social: "TIRADE", mind: "HACK", guard: "RAM" } },
    multi:  { why: "several hits, strong once the power limit allows", effects: [{ type: "damage", power: 6, hits: 2 }],
              names: { aggro: "FLURRY", social: "BARRAGE", mind: "SALVO", guard: "DOUBLE BASH" } },
    drain:  { why: "heals you as it hits", effects: [{ type: "damage", power: 6, hits: 1 }, { type: "drain", pct: 0.6 }],
              names: { aggro: "LEECH", social: "CHARM SAP", mind: "SIPHON", guard: "ABSORB" } },
    burn:   { why: "keeps hurting after it lands", effects: [{ type: "damage", power: 6, hits: 1 }, { type: "burn", chance: 1, damage: 4, turns: 4 }],
              names: { aggro: "FIREBALL", social: "SCORCH", mind: "OVERHEAT", guard: "EMBER WALL" } },
    stun:   { why: "can cancel their next action", effects: [{ type: "damage", power: 6, hits: 1 }, { type: "stun", chance: 0.6 }],
              names: { aggro: "HAMMER", social: "SHOUT", mind: "SHOCK", guard: "BASH" } },
    weaken: { why: "cuts their damage for a few turns", effects: [{ type: "damage", power: 6, hits: 1 }, { type: "weaken", pct: 0.5, turns: 3 }],
              names: { aggro: "CRIPPLE", social: "TAUNT", mind: "CONFUSE", guard: "PARRY" } },
    focus:  { why: "sets up a much bigger next hit", effects: [{ type: "damage", power: 6, hits: 1 }, { type: "focus", mult: 2 }],
              names: { aggro: "WIND UP", social: "RALLY", mind: "CALCULATE", guard: "BRACE" } },
    wall:   { why: "a big shield that acts first", effects: [{ type: "shield", amount: 12, turns: 3 }, { type: "damage", power: 6, hits: 1 }],
              names: { aggro: "BARRAGE WALL", social: "DEFLECT", mind: "FIREWALL", guard: "AEGIS" } },
  };
  const PASSIVE_ARCHETYPES = {
    regen:  { name: "LIFE BLOOM", style: "guard", why: "heals every couple of turns", effects: [{ type: "regen", heal: 6, every: 1 }] },
    thorns: { name: "THORNS", style: "guard", why: "hurts them whenever they hit you", effects: [{ type: "thorns", pct: 0.4 }] },
    wall:   { name: "IRON HIDE", style: "guard", why: "starts every battle with a shield", effects: [{ type: "start_shield", amount: 12 }] },
    flow:   { name: "DYNAMO", style: "mind", why: "extra energy for big skills", effects: [{ type: "energy_flow", amount: 2, every: 1 }] },
    boost:  { name: "MASTERY", style: "aggro", why: "boosts one style's damage", effects: [{ type: "style_boost", style: "aggro", pct: 0.5 }], perStyle: true },
  };
  const WEAPON_ARCHETYPES = {
    flame:  { name: "FLAME SWORD", style: "aggro", why: "its Aggro skills can set them on fire", effects: [{ type: "rider", style: "aggro", status: "burn", chance: 0.6 }, { type: "edge", style: "aggro", pct: 0.4 }] },
    axe:    { name: "WAR AXE", style: "aggro", why: "critical hits", effects: [{ type: "crit", chance: 0.3 }, { type: "edge", style: "aggro", pct: 0.4 }] },
    tower:  { name: "TOWER SHIELD", style: "guard", why: "blocks part of the first hit every turn", effects: [{ type: "guard", amount: 6 }, { type: "edge", style: "guard", pct: 0.4 }] },
    fang:   { name: "VAMPIRE FANG", style: "social", why: "heals you a little on every hit", effects: [{ type: "lifesteal", pct: 0.3 }, { type: "edge", style: "social", pct: 0.4 }] },
    cloak:  { name: "SEER'S CLOAK", style: "mind", why: "makes you harder to hit", effects: [{ type: "evade", pct: 0.2 }, { type: "edge", style: "mind", pct: 0.4 }] },
    dagger: { name: "VENOM DAGGER", style: "mind", why: "its Mind skills can poison", effects: [{ type: "rider", style: "mind", status: "poison", chance: 0.6 }, { type: "edge", style: "mind", pct: 0.4 }] },
    blade:  { name: "BLADE", style: "aggro", why: "more damage with one style", effects: [{ type: "edge", style: "aggro", pct: 0.4 }], perStyle: true },
  };
  const ITEM_RULES = {
    potion: [[{ when: { kind: "my_hp_below", value: 35 }, do: { item: true } }], [{ when: { kind: "my_hp_below", value: 50 }, do: { item: true } }]],
    ether: [[{ when: { kind: "my_energy_below", value: 2 }, do: { item: true } }]],
    antidote: [[{ when: { kind: "i_have", value: "burn" }, do: { item: true } }, { when: { kind: "i_have", value: "poison" }, do: { item: true } }]],
    smoke: [[{ when: { kind: "phase_is", value: "endgame" }, do: { item: true } }], [{ when: { kind: "my_hp_below", value: 50 }, do: { item: true } }]],
  };
  const SPLITS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5], [1 / 3, 1 / 3, 1 / 3], [0.5, 0.25, 0.25], [0.25, 0.5, 0.25], [0.25, 0.25, 0.5]];
  const EFFORT = {
    full:  { screenTrain: 80, screenGames: 16, finalTrain: 220, finalGames: 40, finalSeeds: 3, topLoadouts: 3, finalists: 4, meta: 60, pathMilestones: 3, field: 8 },
    quick: { screenTrain: 30, screenGames: 6, finalTrain: 60, finalGames: 12, finalSeeds: 1, topLoadouts: 2, finalists: 2, meta: 16, pathMilestones: 2, field: 3 },
  };

  function weaponSkill(arch, level, style) {
    const a = WEAPON_ARCHETYPES[arch];
    const effects = a.effects.map((e) => (a.perStyle ? { ...e, style } : { ...e }));
    const name = a.perStyle ? `${E.STYLE_INFO[style].label.toUpperCase()} ${a.name}` : a.name;
    const v = E.fitSkill({ name, kind: "weapon", style: a.perStyle ? style : a.style, element: "none", effects }, level);
    if (!v.skill || v.overBudget) return null;
    return { ...v.skill, id: `pro_w_${arch}${a.perStyle ? "_" + style : ""}` };
  }
  function archetypeSkill(arch, style, level, key) {
    const a = ARCHETYPES[arch];
    const v = E.fitSkill({ name: a.names[style], kind: "active", style, element: "none", effects: a.effects.map((e) => ({ ...e })) }, level);
    if (!v.skill || v.overBudget) return null;
    return { ...v.skill, id: key };
  }
  function passiveSkill(arch, level, style) {
    const a = PASSIVE_ARCHETYPES[arch];
    const effects = a.effects.map((e) => (e.type === "style_boost" ? { ...e, style } : { ...e }));
    const name = a.perStyle ? `${E.STYLE_INFO[style].label.toUpperCase()} MASTERY` : a.name;
    const v = E.fitSkill({ name, kind: "passive", style: a.perStyle ? style : a.style, element: "none", effects }, level);
    if (!v.skill || v.overBudget) return null;
    return { ...v.skill, id: `pro_p_${arch}${a.perStyle ? "_" + style : ""}` };
  }

  /** Everything this fighter could use at `level`, with what each costs in Cycles. */
  function options(ctx) {
    const { level, library = [], fighter } = ctx;
    const unlocked = ctx.unlocked || E.unlockedFamilies({ beaten: ctx.beaten || [], codex: ctx.codex || [] });
    const open = (sk) => sk && E.lockedIn(sk, unlocked).length === 0;   // forging needs the effect families unlocked
    const owned = new Map();
    for (const s of library) owned.set(s.id, s);
    for (const [id, s] of Object.entries(fighter.custom || {})) if (!owned.has(id)) owned.set(id, s);
    const legal = (s) => { const v = E.validateSkill(s, { level }); return v.skill && !v.overBudget ? { ...v.skill, id: s.id } : null; };
    const skills = { aggro: [], social: [], mind: [], guard: [] };
    for (const [id, s] of Object.entries(E.BASIC)) skills[s.style].push({ id, skill: null, style: s.style, cost: 0, label: s.name, kind: "basic" });
    if (fighter.passive && !owned.has(fighter.passive.id)) owned.set(fighter.passive.id, fighter.passive);
    if (fighter.weapon && !owned.has(fighter.weapon.id)) owned.set(fighter.weapon.id, fighter.weapon);
    for (const s of owned.values()) {
      if (s.kind !== "active") continue;
      const ok = legal(s);
      if (ok) skills[ok.style].push({ id: ok.id, skill: ok, style: ok.style, cost: 0, label: ok.name, kind: "owned" });
    }
    for (const style of E.STYLES) for (const arch of Object.keys(ARCHETYPES)) {
      const sk = archetypeSkill(arch, style, level, `pro_${arch}_${style}`);
      if (sk && open(sk)) skills[style].push({ id: sk.id, skill: sk, style, cost: ECON.forgeCost(sk), label: sk.name, kind: "forge", arch });
    }
    const passives = [{ id: null, skill: null, cost: 0, label: "none", kind: "none" }];
    for (const p of E.STARTER_PASSIVES) if (p.budget <= E.maxPassiveBudget(level)) passives.push({ id: p.id, skill: p, cost: 0, label: p.name, kind: "starter" });
    for (const s of owned.values()) if (s.kind === "passive") { const ok = legal(s); if (ok) passives.push({ id: ok.id, skill: ok, cost: 0, label: ok.name, kind: "owned" }); }
    for (const arch of Object.keys(PASSIVE_ARCHETYPES)) {
      const styles = PASSIVE_ARCHETYPES[arch].perStyle ? E.STYLES : [null];
      for (const st of styles) { const p = passiveSkill(arch, level, st); if (p && open(p)) passives.push({ id: p.id, skill: p, cost: ECON.forgeCost(p), label: p.name, kind: "forge", arch }); }
    }
    const weapons = [{ id: null, skill: null, cost: 0, label: "none", kind: "none" }];
    for (const s of owned.values()) if (s.kind === "weapon") { const ok = legal(s); if (ok) weapons.push({ id: ok.id, skill: ok, cost: 0, label: ok.name, kind: "owned" }); }
    if (unlocked.has("weapon:slot")) for (const arch of Object.keys(WEAPON_ARCHETYPES)) {
      for (const st of WEAPON_ARCHETYPES[arch].perStyle ? E.STYLES : [null]) {
        const w = weaponSkill(arch, level, st);
        if (w && open(w)) weapons.push({ id: w.id, skill: w, cost: ECON.forgeCost(w), label: w.name, kind: "forge", arch });
      }
    }
    const items = [null, ...Object.keys(E.ITEMS)];
    return { skills, passives, weapons, items, unlocked };
  }

  function statOptions(level, current) {
    const n = E.statPointsFor(level), out = [], seen = new Set();
    for (const [p, v, s] of SPLITS) {
      const st = { power: Math.floor(n * p), vitality: Math.floor(n * v), speed: Math.floor(n * s) };
      let left = n - st.power - st.vitality - st.speed;
      for (const k of ["power", "vitality", "speed"]) if (left > 0 && (k === "power" ? p : k === "vitality" ? v : s) > 0) { st[k]++; left--; }
      if (left > 0) st.vitality += left;
      const key = `${st.power}/${st.vitality}/${st.speed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ stats: st, respec: st.power < current.power || st.vitality < current.vitality || st.speed < current.speed });
    }
    return out;
  }

  // ---------- builds ----------
  function costOf(b, ctx) {
    let c = 0;
    const seen = new Set();
    for (const o of b.slots) if (!seen.has(o.id)) { seen.add(o.id); c += o.cost; }
    if (b.passive) c += b.passive.cost;
    if (b.weapon) c += b.weapon.cost;
    if (b.item && !(ctx.inventory[b.item] > 0)) c += ECON.itemPrice(b.item);
    if (b.respec) c += ECON.PRICES.respec;
    return c;
  }
  const keyOf = (b) => [b.slots.map((o) => o.id).join(","), b.passive ? b.passive.id : "-", b.weapon ? b.weapon.id : "-", b.item || "-", b.stats ? `${b.stats.power}/${b.stats.vitality}/${b.stats.speed}` : "-", JSON.stringify(b.rules || [])].join("|");

  function toFighter(base, b, level) {
    const custom = {};
    for (const o of b.slots) if (o.skill) custom[o.id] = o.skill;
    let f = E.redesign(base, { moves: b.slots.map((o) => o.id), custom, passive: b.passive ? b.passive.skill : null, weapon: b.weapon ? b.weapon.skill : null, item: b.item || null });
    if (f.level !== level) { f.level = level; f.xp = E.xpForLevel(level); }
    f = E.setStats({ ...f, stats: { power: 0, vitality: 0, speed: 0 } }, b.stats || E.statsOf(base));
    f.rules = E.sanitizeRules(b.rules || [], f.moves);
    return f;
  }

  /** Does a build follow the rulebook's loadout clauses? */
  function legalBuild(b) {
    const custom = {};
    for (const o of b.slots) if (o.skill) custom[o.id] = o.skill;
    return E.validateLoadout({ moves: b.slots.map((o) => o.id), custom, passive: b.passive ? b.passive.skill : null, weapon: b.weapon ? b.weapon.skill : null }).length === 0;
  }

  // ---------- simulation ----------
  const pts = (m) => (m.result === "win" ? 1 : m.result === "draw" ? 0.5 : 0);
  function trainBurst(f, n, seed) {
    const partners = E.PARTNERS.filter((p) => ["brawler", "talker", "schemer", "turtle", "cycler"].includes(p.id));
    const r = E.rng(seed);
    for (let i = 0; i < n; i++) E.fight(f, E.partnerFighter(partners[i % partners.length].id, f), { rng: r, learnA: true });
    f.brain = E.compactBrain(f.brain);
    return f;
  }
  function vs(f, foe, games, seed) {
    const r = E.rng(seed);
    let s = 0;
    for (let i = 0; i < games; i++) s += pts(E.fight(E.clone(f), E.clone(foe), { rng: r }));
    return s / games;
  }

  /** A stand-in for other players: random legal builds of this level and budget, each trained like a player would. */
  function syntheticField(level, balance, n, seed) {
    const beaten = E.RIVALS.filter((rv) => rv.level < level).map((rv) => rv.id);
    const opts = options({ level, library: [], beaten, fighter: E.createFighter({ moves: ["fight", "talk", "strategize", "shield"] }) });
    const r = E.rng(seed), out = [];
    const statOpts = statOptions(level, { power: 0, vitality: 0, speed: 0 });
    for (let k = 0; k < n; k++) {
      let slots, cost, tries = 0;
      do {
        slots = E.STYLES.map((st) => { const list = opts.skills[st]; return list[Math.floor(r() * list.length)]; });
        cost = slots.reduce((a, o) => a + o.cost, 0);
      } while ((cost > Math.max(balance, 60) || !legalBuild({ slots })) && ++tries < 80);
      if (!legalBuild({ slots })) slots = E.STYLES.map((st) => opts.skills[st].find((o) => o.kind === "basic"));
      const custom = {};
      for (const o of slots) if (o.skill) custom[o.id] = o.skill;
      const passive = opts.passives[Math.floor(r() * opts.passives.length)];
      const item = r() < 0.5 ? Object.keys(E.ITEMS)[Math.floor(r() * 4)] : null;
      const weapon = opts.weapons.length > 1 && r() < 0.6 ? opts.weapons[1 + Math.floor(r() * (opts.weapons.length - 1))].skill : null;
      let f = E.createFighter({ name: `FIELD ${k + 1}`, moves: slots.map((o) => o.id), custom, passive: passive.skill, item, weapon }, E.rng(seed + k));
      f.level = level; f.xp = E.xpForLevel(level);
      f = E.setStats(f, statOpts[Math.floor(r() * statOpts.length)].stats);
      if (item) f.rules = E.sanitizeRules(ITEM_RULES[item][0], f.moves);
      out.push(trainBurst(f, 150, seed + 50 + k));
    }
    return out;
  }

  /** Opponents the build is scored against. Partners are rebuilt per candidate (they match your level). */
  function benchmark(ctx) {
    const { level, beaten = [], arena = [] } = ctx;
    const idx = E.RIVALS.findIndex((r) => !beaten.includes(r.id));
    const ids = new Set();
    if (idx < 0) ids.add(E.RIVALS[E.RIVALS.length - 1].id);
    else { ids.add(E.RIVALS[idx].id); if (E.RIVALS[idx + 1]) ids.add(E.RIVALS[idx + 1].id); }
    if (idx > 0) ids.add(E.RIVALS[idx - 1].id);
    else if (idx < 0) ids.add(E.RIVALS[E.RIVALS.length - 2].id);
    const rivals = [...ids].map((id) => ({ id, label: E.RIVALS.find((r) => r.id === id).name, fighter: E.rivalFighter(id) }));
    const partners = E.PARTNERS.filter((p) => p.id !== "mirror" && p.unlock <= level).map((p) => ({ id: p.id, label: p.name }));
    const arenaFoes = arena.slice(0, 10).map((f, i) => ({ id: `arena${i + 1}`, label: `Arena fighter #${i + 1}`, fighter: f }));
    const field = (ctx.field || []).map((f, i) => ({ id: `field${i + 1}`, label: `Field build #${i + 1}`, fighter: f }));
    return { rivals, partners, arena: arenaFoes, field };
  }

  /** Win rates of a fighter against the benchmark. `games` per opponent. */
  function score(f, bench, games, seed, quick) {
    const rv = (quick ? bench.rivals.slice(0, 1) : bench.rivals).map((o, k) => ({ id: o.id, label: o.label, rate: vs(f, o.fighter, games, seed + 11 * k) }));
    const pa = (quick ? bench.partners.filter((p) => ["brawler", "talker", "schemer", "turtle", "cycler"].includes(p.id)) : bench.partners)
      .map((o, k) => ({ id: o.id, label: o.label, rate: vs(f, E.partnerFighter(o.id, f), games, seed + 101 + 13 * k) }));
    const ar = quick ? [] : bench.arena.map((o, k) => ({ id: o.id, label: o.label, rate: vs(f, o.fighter, games, seed + 307 + 17 * k) }));
    const fd = (quick ? bench.field.slice(0, 3) : bench.field).map((o, k) => ({ id: o.id, label: o.label, rate: vs(f, o.fighter, games, seed + 503 + 19 * k) }));
    return { rivals: rv, partners: pa, arena: ar, field: fd };
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
  function overall(s, meta) {
    const rival = mean(s.rivals.map((x) => x.rate));
    const arenaSide = [mean(s.partners.map((x) => x.rate)), mean(s.arena.map((x) => x.rate)), mean((s.field || []).map((x) => x.rate)), meta ?? null].filter((x) => x !== null);
    return 0.5 * rival + 0.5 * mean(arenaSide);
  }

  // ---------- the search ----------
  class Cancelled extends Error { constructor() { super("Cancelled"); this.code = "cancelled"; } }
  function makeYield(signal) {
    let last = Date.now();
    return async () => {
      if (signal && signal.aborted) throw new Cancelled();
      if (Date.now() - last > 25) { await new Promise((r) => setTimeout(r, 0)); last = Date.now(); if (signal && signal.aborted) throw new Cancelled(); }
    };
  }

  /**
   * Find the best fair build.
   * ctx: { fighter, level?, library, inventory, balance, beaten, arena: [sanitized fighters], seed, effort: "full"|"quick", signal, onProgress(frac, label) }
   */
  async function optimize(ctx) {
    const base = E.upgradeFighter(E.clone(ctx.fighter));
    const level = ctx.level || base.level || 1;
    const P = EFFORT[ctx.effort || "full"];
    const seed = (ctx.seed ?? 1) >>> 0;
    const c = { ...ctx, level, inventory: ctx.inventory || {}, balance: Math.max(0, ctx.balance ?? 0), library: ctx.library || [],
                unlocked: ctx.unlocked || E.unlockedFamilies({ beaten: ctx.beaten || [], codex: ctx.codex || [] }) };
    const tick = makeYield(ctx.signal);
    const opts = options({ ...c, fighter: base });
    const bench = benchmark({ ...c, field: syntheticField(level, c.balance, P.field, seed + 77) });
    const curStats = E.statsOf(base);
    const statOpts = statOptions(level, curStats);
    let evaluated = 0, total = 1;
    const progress = (label) => ctx.onProgress && ctx.onProgress(Math.min(0.99, evaluated / total), label);

    const cache = new Map();
    async function quickScore(b) {
      const k = keyOf(b);
      if (cache.has(k)) return cache.get(k);
      if (!legalBuild(b)) { cache.set(k, -1); return -1; }   // breaks a clause: never a candidate
      await tick();
      const f = trainBurst(toFighter(base, b, level), P.screenTrain, seed + 1);
      const s = score(f, bench, P.screenGames, seed + 2, true);
      const v = overall(s);
      cache.set(k, v);
      evaluated++;
      return v;
    }
    const styleSlots = (moves) => moves.map((m) => { const sk = E.skillOf(base, m); return opts.skills[sk.style].find((o) => o.id === m) || { id: m, skill: base.custom && base.custom[m] ? { ...base.custom[m], id: m } : null, style: sk.style, cost: 0, label: sk.name, kind: "owned" }; });
    const curPassive = base.passive ? (opts.passives.find((p) => p.id === base.passive.id) || { id: base.passive.id, skill: base.passive, cost: 0, label: base.passive.name, kind: "owned" }) : null;
    const curWeapon = base.weapon ? (opts.weapons.find((w) => w.id === base.weapon.id) || { id: base.weapon.id, skill: base.weapon, cost: 0, label: base.weapon.name, kind: "owned" }) : null;
    const current = { slots: styleSlots(base.moves), passive: curPassive && curPassive.id ? curPassive : null, weapon: curWeapon, item: base.item || null, stats: curStats, rules: base.rules || [], respec: false };

    // Stage 1: basic loadouts that cover all four styles
    const basic = (st) => opts.skills[st].filter((o) => o.kind === "basic");
    const loadouts = [];
    for (const a of basic("aggro")) for (const s of basic("social")) for (const m of basic("mind")) for (const g of basic("guard")) loadouts.push([a, s, m, g]);
    const swaps = E.STYLES.reduce((n, st) => n + opts.skills[st].filter((o) => o.kind !== "basic").length, 0);
    total = loadouts.length + P.topLoadouts * swaps + 81 + 16 * (P.topLoadouts - 1) + (P.finalists + 1) * (opts.passives.length + opts.weapons.length + 8 + statOpts.length + 1) + (P.finalists + 2) * P.finalSeeds + P.pathMilestones * 12;
    // screening uses an even spread (or the current points, if moving them would need a reset)
    const even = statOpts.find((o) => o.stats.power && o.stats.vitality && o.stats.speed && !o.respec) || statOpts.find((o) => !o.respec);
    const neutralStats = even || { stats: curStats, respec: false };
    const plain = (slots) => ({ slots, passive: null, weapon: null, item: null, stats: neutralStats.stats, rules: [], respec: neutralStats.respec });
    progress("Screening loadouts");
    const s1 = [];
    for (const slots of loadouts) { s1.push({ slots, v: await quickScore(plain(slots)) }); progress("Screening loadouts"); }
    s1.sort((x, y) => y.v - x.v);
    const tops = s1.slice(0, P.topLoadouts);

    // Stage 2: swap in forged and owned skills, one slot at a time, then combine the best swaps
    progress("Trying forged skills");
    const singles = [];
    for (const t of tops) {
      for (let k = 0; k < 4; k++) {
        for (const o of opts.skills[E.STYLES[k]]) {
          if (o.kind === "basic") continue;
          const slots = t.slots.slice(); slots[k] = o;
          const v = await quickScore(plain(slots));
          singles.push({ base: t, k, o, gain: v - t.v });
          progress("Trying forged skills");
        }
      }
    }
    const combos = [];
    for (const [ti, t] of tops.entries()) {
      const width = ti === 0 ? 2 : 1;   // the best loadout gets the two best swaps per slot, the others one
      const perSlot = [0, 1, 2, 3].map((k) => [t.slots[k], ...singles.filter((x) => x.base === t && x.k === k && x.gain > 0).sort((a, b) => b.gain - a.gain).slice(0, width).map((x) => x.o)]);
      for (const a of perSlot[0]) for (const s of perSlot[1]) for (const m of perSlot[2]) for (const g of perSlot[3]) {
        const slots = [a, s, m, g];
        const b = plain(slots);
        if (costOf(b, c) > c.balance + 80 || !legalBuild(b)) continue;   // far beyond reach, or breaks a clause
        combos.push({ slots, v: await quickScore(b), cost: costOf(b, c) });
        progress("Combining skills");
      }
    }
    combos.sort((x, y) => y.v - x.v);
    const pickDistinct = (list, n, pred) => { const out = [], seen = new Set(); for (const x of list) { const k = x.slots.map((o) => o.id).join(); if (seen.has(k) || !pred(x)) continue; seen.add(k); out.push(x); if (out.length >= n) break; } return out; };
    const affordableLoadouts = pickDistinct(combos, P.finalists, (x) => x.cost <= c.balance);
    const dreamLoadouts = pickDistinct(combos, 1, (x) => x.cost > c.balance);

    // Stage 3: passive, item + rules, stats and a finisher rule, one at a time (coordinate descent)
    async function extras(slots, budget) {
      let b = plain(slots);
      let best = await quickScore(b);
      const tryAll = async (variants, label) => {
        for (const vb of variants) {
          if (costOf(vb, c) > budget) continue;
          const v = await quickScore(vb);
          if (v > best + 0.005) { best = v; b = vb; }
          progress(label);
        }
      };
      await tryAll(opts.passives.map((p) => ({ ...b, passive: p.id ? p : null })), "Choosing a passive");
      if (opts.weapons.length > 1) await tryAll(opts.weapons.map((w) => ({ ...b, weapon: w.id ? w : null })), "Choosing a weapon");
      const itemVariants = [];
      for (const it of Object.keys(E.ITEMS)) for (const rules of ITEM_RULES[it]) itemVariants.push({ ...b, item: it, rules });
      await tryAll(itemVariants.map((x) => ({ ...x, passive: b.passive, weapon: b.weapon })), "Choosing an item and rules");
      await tryAll(statOpts.map((o) => ({ ...b, stats: o.stats, respec: o.respec })), "Spending stat points");
      const finisher = biggestHit(b.slots);
      if (finisher) await tryAll([{ ...b, rules: [...b.rules, { when: { kind: "their_hp_below", value: 25 }, do: { skill: finisher } }] }], "Adding a finisher rule");
      return { b, v: best };
    }
    const cands = [];
    for (const l of affordableLoadouts) cands.push(await extras(l.slots, c.balance));
    const dreams = [];
    for (const l of dreamLoadouts) dreams.push(await extras(l.slots, Infinity));

    // Stage 4: finals with the full benchmark, several seeds, plus a round-robin meta pool
    progress("Final tests");
    const finalists = [{ b: current, isCurrent: true }, ...cands.map((x) => ({ b: x.b })), ...dreams.map((x) => ({ b: x.b, dream: true }))];
    const seen = new Set();
    const uniq = finalists.filter((x) => { const k = keyOf(x.b); if (seen.has(k)) return false; seen.add(k); return true; });
    for (const x of uniq) {
      x.seeds = [];
      for (let k = 0; k < P.finalSeeds; k++) {
        await tick();
        const f = trainBurst(toFighter(base, x.b, level), P.finalTrain, seed + 1000 + k);
        x.seeds.push({ f, s: score(f, bench, P.finalGames, seed + 2000 + 37 * k, false) });
        evaluated++; progress("Final tests");
      }
      x.fighter = x.seeds[0].f;
    }
    for (const x of uniq) {
      const others = uniq.filter((y) => y !== x);
      let m = 0;
      for (const y of others) { await tick(); m += vs(x.fighter, y.fighter, P.meta, seed + 3000); }
      x.meta = others.length ? m / others.length : null;
      x.score = mergeScores(x.seeds.map((z) => z.s));
      x.overall = overall(x.score, x.meta);
      x.cost = costOf(x.b, c);
    }
    const best = uniq.filter((x) => !x.dream && !x.isCurrent).sort((a, b) => b.overall - a.overall)[0];
    const cur = uniq.find((x) => x.isCurrent);
    // a current build that breaks a clause can't be kept, however well it scores
    const winner = best && (best.overall > cur.overall || !legalBuild(current)) ? best : cur;
    const dream = uniq.filter((x) => x.dream).sort((a, b) => b.overall - a.overall)[0];

    progress("Planning practice");
    const practice = await practicePlan(base, winner.b, level, seed, tick);
    progress("Planning the level-up path");
    const path = await levelPath(base, winner.b, { ...c, tick, P, seed });
    ctx.onProgress && ctx.onProgress(1, "Done");
    return {
      level, evaluated: evaluated, keptCurrent: winner === cur,
      build: describeBuild(winner.b, c),
      score: summarize(winner),
      baseline: summarize(cur),
      saveUpFor: dream && dream.overall > winner.overall + 0.03 ? { build: describeBuild(dream.b, c), score: summarize(dream) } : null,
      reasons: reasons(winner, cur, c),
      training: trainingPlan(winner),
      practice,
      path,
    };
  }

  function biggestHit(slots) {
    let best = null, bestP = 0;
    for (const o of slots) {
      const sk = o.skill || E.BASIC[o.id];
      const p = sk.effects.filter((e) => e.type === "damage").reduce((a, e) => a + e.power * (e.hits || 1), 0);
      if (p > bestP) { bestP = p; best = o.id; }
    }
    return best;
  }
  function mergeScores(list) {
    const merge = (key) => list[0][key].map((o, i) => ({ ...o, rate: mean(list.map((s) => s[key][i].rate)) }));
    return { rivals: merge("rivals"), partners: merge("partners"), arena: merge("arena"), field: merge("field") };
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  function summarize(x) {
    return {
      overall: r2(x.overall), meta: x.meta === null ? null : r2(x.meta), cost: x.cost,
      rivals: x.score.rivals.map((o) => ({ id: o.id, label: o.label, rate: r2(o.rate) })),
      partners: x.score.partners.map((o) => ({ id: o.id, label: o.label, rate: r2(o.rate) })),
      arena: x.score.arena.map((o) => ({ id: o.id, label: o.label, rate: r2(o.rate) })),
      field: r2(mean(x.score.field.map((o) => o.rate)) ?? 0),
    };
  }
  function describeBuild(b, c) {
    const forge = [];
    for (const o of b.slots) if (o.kind === "forge") forge.push({ ref: o.id, skill: o.skill, cost: o.cost, why: ARCHETYPES[o.arch].why });
    if (b.passive && b.passive.kind === "forge") forge.push({ ref: b.passive.id, skill: b.passive.skill, cost: b.passive.cost, why: PASSIVE_ARCHETYPES[b.passive.arch].why });
    if (b.weapon && b.weapon.kind === "forge") forge.push({ ref: b.weapon.id, skill: b.weapon.skill, cost: b.weapon.cost, why: WEAPON_ARCHETYPES[b.weapon.arch].why });
    return {
      moves: b.slots.map((o) => o.id), names: b.slots.map((o) => o.label),
      skills: b.slots.map((o) => o.skill || null),
      passive: b.passive ? b.passive.skill : null, weapon: b.weapon ? b.weapon.skill : null, item: b.item || null,
      buyItem: !!(b.item && !(c.inventory[b.item] > 0)),
      stats: { ...b.stats }, respec: !!b.respec, rules: E.clone(b.rules || []),
      forge, cost: costOf(b, c),
    };
  }
  function reasons(x, cur, c) {
    const b = x.b, out = [];
    const styles = new Set(b.slots.map((o) => o.style));
    if (styles.size === 4) out.push("Covers all four styles, so it always has a counter to what they just did.");
    for (const o of b.slots) if (o.kind === "forge") out.push(`${o.label}: ${ARCHETYPES[o.arch].why}.`);
    if (b.slots.some((o) => o.id === "shield")) out.push("BULWARK acts first and blocks damage, which wins the close turns.");
    if (b.passive) out.push(`${b.passive.label}: ${b.passive.kind === "forge" ? PASSIVE_ARCHETYPES[b.passive.arch].why : E.describeSkill(b.passive.skill).replace(/^Passive: /, "").replace(/\.$/, "")}.`);
    if (b.weapon) out.push(`${b.weapon.label}: ${b.weapon.kind === "forge" ? WEAPON_ARCHETYPES[b.weapon.arch].why : E.describeSkill(b.weapon.skill).replace(/^Weapon: /, "").replace(/\.$/, "")}.`);
    if (b.item) out.push(`${E.ITEMS[b.item].name} with a rule (${E.describeRule(b.rules.find((r) => r.do.item) || { when: { kind: "phase_is", value: "endgame" }, do: { item: true } }, { item: b.item }).replace(/^If /, "if ").replace(/\.$/, "")}), so it's never wasted or forgotten.`);
    const s = b.stats, n = s.power + s.vitality + s.speed;
    if (n) out.push(`Stats ${s.power} Power / ${s.vitality} Vitality / ${s.speed} Speed.${s.power && s.vitality ? " Power and Vitality multiply each other, so a spread beats piling into one." : ""}`);
    const up = Math.round((x.overall - cur.overall) * 100);
    if (x !== cur) out.push(`Overall score ${Math.round(x.overall * 100)} vs ${Math.round(cur.overall * 100)} for the current build (${up >= 0 ? "+" : ""}${up}).`);
    return out;
  }
  function trainingPlan(x) {
    const weak = x.score.partners.filter((p) => p.rate < 0.85).sort((a, b) => a.rate - b.rate).slice(0, 2);
    const tips = weak.map((p) => ({ partner: p.id, label: p.label, rate: r2(p.rate), tip: `Practice against ${p.label} (wins ${Math.round(p.rate * 100)}% now). Spar by hand there to teach the counters faster.` }));
    if (!tips.length) tips.push({ partner: "mirror", label: "MIRROR", rate: null, tip: "Your gym partners are handled. Train against MIRROR (a copy of this build) to sharpen the instincts, then climb the ladder." });
    const rv = x.score.rivals.slice().sort((a, b) => a.rate - b.rate)[0];
    if (rv && rv.rate < 0.6) tips.push({ partner: null, label: rv.label, rate: r2(rv.rate), tip: `${rv.label} is the hard matchup (${Math.round(rv.rate * 100)}%). Buy a scouting report before that fight.` });
    return tips;
  }

  /** How much practice the new files need before rival and arena battles, and about how many drill rounds that is. */
  async function practicePlan(base, b, level, seed, tick) {
    const out = [];
    const f0 = toFighter(base, b, level);
    for (const o of b.slots) {
      if (!o.skill || E.isProven(f0, o.skill)) continue;
      await tick();
      const probe = E.train(E.clone(f0), "brawler", 3, { rng: E.rng(seed + 9), drill: o.id }).fighter;
      const perRound = Math.max(1, (E.practiceCount(probe, o.skill) - E.practiceCount(f0, o.skill)) / 3);
      const need = E.practiceNeeded(o.skill) - E.practiceCount(f0, o.skill);
      out.push({ ref: o.id, name: o.skill.name, kind: "active", need, rounds: Math.ceil(need / perRound), how: "drill" });
    }
    for (const g of [b.passive, b.weapon]) {
      if (!g || !g.skill || E.isProven(f0, g.skill)) continue;
      const need = E.practiceNeeded(g.skill) - E.practiceCount(f0, g.skill);
      out.push({ ref: g.id, name: g.skill.name, kind: g.skill.kind, need, rounds: need, how: "practice battles" });
    }
    return out;
  }

  /** Look-ahead: at each milestone level, re-forge this build's skills at the higher power limit,
   *  test the best new skill for each basic slot there, and suggest how to spend the new points. */
  async function levelPath(base, b, k) {
    const { level, tick, P, seed, library } = k;
    const marks = [];
    for (let L = Math.ceil((level + 1) / 5) * 5; L <= E.MAX_LEVEL && marks.length < P.pathMilestones; L += 5) if (L > level) marks.push(L);
    const totalPts = Math.max(1, b.stats.power + b.stats.vitality + b.stats.speed);
    const out = [];
    for (const L of marks) {
      const beaten = [...new Set([...(k.beaten || []), ...E.RIVALS.filter((r) => r.level < L).map((r) => r.id)])];
      const optsL = options({ level: L, library, fighter: base, beaten, codex: k.codex || [] });
      // badges you'd earn on the way to this level
      const prev = out.length ? out[out.length - 1].level : level;
      const badges = E.RIVALS.filter((r) => r.level < L && r.level >= prev && !(k.beaten || []).includes(r.id)).map((r) => ({
        rival: r.name, level: r.level, unlocks: Object.entries(E.FAMILIES).filter(([, rv]) => rv === r.id).map(([key]) => E.familyLabel(key)),
      }));
      const benchL = benchmark({ level: L, beaten, arena: [], field: syntheticField(L, 200, 3, seed + 7000 + L) });
      const n = E.statPointsFor(L);
      const stats = { power: Math.round(n * b.stats.power / totalPts), vitality: Math.round(n * b.stats.vitality / totalPts), speed: 0 };
      stats.speed = Math.max(0, n - stats.power - stats.vitality);
      const refit = (o) => {
        if (o.kind !== "forge") return o;
        const sk = archetypeSkill(o.arch, o.style, L, o.id);
        return sk ? { ...o, skill: sk, label: sk.name, cost: ECON.forgeCost(sk) } : o;
      };
      const passive = b.passive && b.passive.kind === "forge" ? (optsL.passives.find((p) => p.id === b.passive.id) || b.passive) : b.passive;
      const weapon = b.weapon && b.weapon.kind === "forge" ? (optsL.weapons.find((w) => w.id === b.weapon.id) || b.weapon) : b.weapon;
      const bL = { ...b, slots: b.slots.map(refit), passive, weapon, stats, respec: false };
      const at = async (x) => {
        await tick();
        const f = trainBurst(toFighter(base, x, L), P.screenTrain, seed + 5000 + L);
        return overall(score(f, benchL, P.screenGames, seed + 6000 + L, true));
      };
      const keep = await at(bL);
      let best = null;
      for (let i = 0; i < 4; i++) {
        if (bL.slots[i].kind === "forge") continue;
        for (const o of optsL.skills[bL.slots[i].style]) {
          if (o.kind !== "forge" || bL.slots.some((x) => x.arch === o.arch)) continue;
          const slots = bL.slots.slice(); slots[i] = o;
          if (!legalBuild({ ...bL, slots })) continue;
          const v = await at({ ...bL, slots });
          if (v > keep + 0.02 && (!best || v > best.v)) best = { v, i, o };
        }
      }
      const forge = [];
      b.slots.forEach((o, i) => {
        const now = bL.slots[i];
        if (o.kind === "forge" && now.skill.budget > o.skill.budget + 0.05)
          forge.push({ name: now.skill.name, style: now.style, budget: now.skill.budget, was: o.skill.budget, cost: now.cost, upgrade: true, describe: E.describeSkill(now.skill) });
      });
      if (best) forge.unshift({ name: best.o.skill.name, style: best.o.style, budget: best.o.skill.budget, cost: best.o.cost, upgrade: false, replaces: bL.slots[best.i].label, describe: E.describeSkill(best.o.skill), gain: r2(best.v - keep) });
      const rival = E.RIVALS.find((r) => r.level >= L) || E.RIVALS[E.RIVALS.length - 1];
      out.push({ level: L, cap: E.maxSkillBudget(L), forge, stats, rival: rival.name, badges });
    }
    return out;
  }

  return { optimize, options, statOptions, benchmark, syntheticField, legalBuild, ARCHETYPES, PASSIVE_ARCHETYPES, WEAPON_ARCHETYPES, ITEM_RULES, EFFORT, Cancelled, costOf };
});
