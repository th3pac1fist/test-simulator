/* Fighter Lab economy: Cycles, the in-game currency.
 * An append-only ledger (the balance is always the sum of entries), prices, free daily gym rounds
 * and rewards with anti-farming caps. No cash value, not transferable. Pure logic, no DOM. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./engine.js"));
  else root.FighterEconomy = factory(root.FighterEngine);
})(typeof self !== "undefined" ? self : this, function (E) {
  "use strict";

  const START = 100;
  const LEDGER_KEEP = 200;                 // older entries fold into `carried`
  const FREE_ROUNDS_PER_DAY = 30, ROUND_COST = 1;
  const ARENA_REWARDS_PER_DAY = 5;
  const PRICES = {
    overclock: 15,     // compute: one battle on Claude's bigger model
    coach: 5,          // compute: one coach review
    scout: 8,          // compute: a pre-battle scouting report
    draft: 5,          // compute: Claude drafts a skill file
    respec: 20,        // reset stat points
  };
  const itemPrice = (id) => (E.ITEMS[id] ? E.ITEMS[id].price : Infinity);
  /** Forging a skill costs more the stronger it is. */
  function forgeCost(skill) {
    const b = skill && Number.isFinite(skill.budget) ? skill.budget : 0;
    return Math.round(skill && skill.kind === "passive" ? 10 + b * 10 : 5 + b * 6);
  }

  /** Local calendar day, so free rounds reset at the player's midnight. */
  function dayKey(now) {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function newWallet(now = Date.now()) {
    return { carried: 0, ledger: [{ at: now, amount: START, reason: "Starting balance" }], day: dayKey(now), roundsUsed: 0, arenaRewards: 0, seq: 1 };
  }
  /** Wallets come from the player's own save, but a damaged save must not break the game. */
  function sanitizeWallet(w, now = Date.now()) {
    if (!w || typeof w !== "object" || !Array.isArray(w.ledger)) return newWallet(now);
    const ledger = w.ledger.filter((e) => e && Number.isFinite(e.amount) && Number.isFinite(e.at))
      .map((e) => ({ at: e.at, amount: Math.round(e.amount), reason: E.cleanText(String(e.reason || ""), 80, false), ...(e.ref ? { ref: String(e.ref).slice(0, 64) } : {}) }))
      .slice(-LEDGER_KEEP);
    const out = {
      carried: Number.isFinite(w.carried) ? Math.round(w.carried) : 0, ledger,
      day: typeof w.day === "string" ? w.day : dayKey(now),
      roundsUsed: Math.max(0, Math.round(Number(w.roundsUsed) || 0)), arenaRewards: Math.max(0, Math.round(Number(w.arenaRewards) || 0)),
      seq: Math.max(0, Math.round(Number(w.seq) || ledger.length)),
    };
    return rollDay(out, now);
  }
  function balance(w) { return w.carried + w.ledger.reduce((a, e) => a + e.amount, 0); }
  function rollDay(w, now) {
    const day = dayKey(now);
    return w.day === day ? w : { ...w, day, roundsUsed: 0, arenaRewards: 0 };
  }
  function add(w, amount, reason, ref, now) {
    if (!Number.isFinite(amount) || amount === 0) return w;
    let ledger = [...w.ledger, { at: now, amount: Math.round(amount), reason, ...(ref ? { ref } : {}) }];
    let carried = w.carried;
    if (ledger.length > LEDGER_KEEP) {
      const drop = ledger.slice(0, ledger.length - LEDGER_KEEP);
      carried += drop.reduce((a, e) => a + e.amount, 0);
      ledger = ledger.slice(-LEDGER_KEEP);
    }
    return { ...w, ledger, carried, seq: (w.seq || 0) + 1 };
  }
  function credit(w, amount, reason, ref, now = Date.now()) {
    if (!(amount > 0)) throw new Error("Credits must be positive.");
    return add(rollDay(w, now), amount, reason, ref, now);
  }
  function canAfford(w, amount) { return balance(w) >= amount; }
  /** Spend, or throw with a message the player can act on. The balance never goes negative. */
  function spend(w, amount, reason, ref, now = Date.now()) {
    if (!(amount > 0)) throw new Error("Prices must be positive.");
    if (!canAfford(w, amount)) throw new Error(`Not enough Cycles: ${reason} costs ${amount}, you have ${balance(w)}.`);
    return add(rollDay(w, now), -amount, reason, ref, now);
  }

  /** What `rounds` of gym practice cost today. */
  function gymQuote(w, rounds, now = Date.now()) {
    const x = rollDay(w, now);
    const free = Math.max(0, Math.min(rounds, FREE_ROUNDS_PER_DAY - x.roundsUsed));
    const paid = rounds - free;
    return { free, paid, cost: paid * ROUND_COST, freeLeft: FREE_ROUNDS_PER_DAY - x.roundsUsed - free };
  }
  function payForGym(w, rounds, now = Date.now()) {
    const q = gymQuote(w, rounds, now);
    let x = rollDay(w, now);
    if (q.cost > 0) x = spend(x, q.cost, `Gym time: ${q.paid} round${q.paid > 1 ? "s" : ""}`, null, now);
    return { wallet: { ...x, roundsUsed: x.roundsUsed + rounds }, quote: q };
  }

  /** Rival rewards: a big one for the first win, a small one for repeat wins. */
  function rivalReward(rivalLevel, firstWin) { return firstWin ? 40 + rivalLevel * 8 : 5 + rivalLevel; }
  /** Arena rewards, capped per day; beating your own fighters pays nothing. */
  function arenaReward(w, result, ownFighter, now = Date.now()) {
    const x = rollDay(w, now);
    if (ownFighter || x.arenaRewards >= ARENA_REWARDS_PER_DAY) return 0;
    return result === "win" ? 15 : result === "draw" ? 6 : 2;
  }
  function payArena(w, result, ownFighter, ref, now = Date.now()) {
    const amount = arenaReward(w, result, ownFighter, now);
    let x = rollDay(w, now);
    if (amount > 0) x = { ...credit(x, amount, `Arena ${result}`, ref, now), arenaRewards: x.arenaRewards + 1 };
    return { wallet: x, amount };
  }

  // ---------- Codex: unlock an effect family early (the rival badge is the cheap path) ----------
  function codexPrice(familyKey) {
    const rv = E.RIVALS.find((r) => r.id === E.FAMILIES[familyKey]);
    return rv ? 60 + 15 * rv.level : 0;
  }

  // ---------- Drops: ready-made blueprints from real wins (never from practice) ----------
  // Each is written at the top of its effects' ranges and fitted to the winner's level, so it's always legal.
  const BLUEPRINTS = [
    { name: "EMBER BOLT", kind: "active", style: "aggro", element: "fire", effects: [{ type: "damage", power: 6 }, { type: "burn", chance: 1, damage: 4, turns: 4 }] },
    { name: "IRON WALL", kind: "active", style: "guard", element: "earth", effects: [{ type: "shield", amount: 12, turns: 3 }, { type: "damage", power: 6 }] },
    { name: "MENDING LIGHT", kind: "active", style: "guard", element: "light", effects: [{ type: "heal", amount: 20 }, { type: "damage", power: 3 }] },
    { name: "HEAVY BLOW", kind: "active", style: "mind", element: "tech", effects: [{ type: "damage", power: 6, hits: 2 }] },
    { name: "SAPPING WORD", kind: "active", style: "social", element: "shadow", effects: [{ type: "damage", power: 6 }, { type: "weaken", pct: 0.5, turns: 3 }] },
    { name: "DRAIN PULSE", kind: "active", style: "social", element: "tech", effects: [{ type: "damage", power: 6 }, { type: "energy_drain", amount: 3 }] },
    { name: "DEEP FOCUS", kind: "active", style: "mind", element: "spirit", effects: [{ type: "damage", power: 6 }, { type: "focus", mult: 2 }] },
    { name: "CHARGE UP", kind: "active", style: "mind", element: "storm", effects: [{ type: "damage", power: 6 }, { type: "energy_gain", amount: 3 }] },
    { name: "RENEWAL", kind: "active", style: "guard", element: "water", effects: [{ type: "regen", heal: 8, every: 1, turns: 6 }, { type: "cleanse" }] },
    { name: "LIFE LEECH", kind: "active", style: "social", element: "shadow", effects: [{ type: "damage", power: 6 }, { type: "drain", pct: 0.6 }] },
    { name: "THUNDER CLAP", kind: "active", style: "aggro", element: "storm", effects: [{ type: "damage", power: 6 }, { type: "stun", chance: 0.6 }] },
    { name: "VENOM STRIKE", kind: "active", style: "mind", element: "poison", effects: [{ type: "damage", power: 6 }, { type: "poison", chance: 1, stacks: 2 }] },
    { name: "WARM SPRING", kind: "passive", style: "guard", element: "water", effects: [{ type: "regen", heal: 6, every: 1 }] },
    { name: "STONE SKIN", kind: "passive", style: "guard", element: "earth", effects: [{ type: "start_shield", amount: 12 }] },
    { name: "SHARP TONGUE", kind: "passive", style: "social", element: "light", effects: [{ type: "style_boost", style: "social", pct: 0.5 }] },
    { name: "DYNAMO", kind: "passive", style: "mind", element: "tech", effects: [{ type: "energy_flow", amount: 2, every: 1 }] },
    { name: "BRAMBLE HIDE", kind: "passive", style: "guard", element: "earth", effects: [{ type: "thorns", pct: 0.4 }] },
    { name: "FLAME SWORD", kind: "weapon", style: "aggro", element: "fire", effects: [{ type: "rider", style: "aggro", status: "burn", chance: 0.6 }, { type: "edge", style: "aggro", pct: 0.4 }] },
    { name: "WAR AXE", kind: "weapon", style: "aggro", element: "earth", effects: [{ type: "crit", chance: 0.3 }, { type: "edge", style: "aggro", pct: 0.4 }] },
    { name: "TOWER SHIELD", kind: "weapon", style: "guard", element: "earth", effects: [{ type: "guard", amount: 6 }, { type: "edge", style: "guard", pct: 0.4 }] },
    { name: "VAMPIRE FANG", kind: "weapon", style: "social", element: "shadow", effects: [{ type: "lifesteal", pct: 0.3 }, { type: "edge", style: "social", pct: 0.4 }] },
    { name: "SEER'S CLOAK", kind: "weapon", style: "mind", element: "spirit", effects: [{ type: "evade", pct: 0.2 }, { type: "edge", style: "mind", pct: 0.4 }] },
    { name: "VENOM DAGGER", kind: "weapon", style: "mind", element: "poison", effects: [{ type: "rider", style: "mind", status: "poison", chance: 0.6 }, { type: "edge", style: "mind", pct: 0.4 }] },
  ];
  const DROP_CHANCE = { rivalFirst: 1, rival: 0.2, arena: 0.15 };
  const RARITY = {
    common: { levelBack: 8, refund: 10 },   // fitted a few levels below yours: a bit weaker than you could forge
    rare: { levelBack: 3, refund: 20 },
    epic: { levelBack: 0, refund: 35 },     // full power for your level; weapons come at this rarity
  };
  function rarityFor(opponentLevel, r) {
    const epic = Math.min(0.35, 0.05 + opponentLevel / 120), rare = 0.35;
    const u = r();
    return u < epic ? "epic" : u < epic + rare ? "rare" : "common";
  }
  /**
   * Maybe drop a blueprint after a real win.
   * ctx: { source: "rivalFirst"|"rival"|"arena", opponentLevel, level, unlocked: Set, owned: [files], prefer: familyKey?, rng }
   * Returns null, or { file, rarity, duplicate, refund }.
   */
  function rollDrop(ctx) {
    const r = ctx.rng || Math.random;
    if (!(r() < (DROP_CHANCE[ctx.source] ?? 0))) return null;
    let rarity = rarityFor(ctx.opponentLevel || 1, r);
    const keysOf = (t) => [...(t.kind === "weapon" ? ["weapon:slot"] : []), ...t.effects.map((e) => E.familyOf(t.kind, e))];
    let pool = BLUEPRINTS.filter((t) => keysOf(t).every((k) => ctx.unlocked.has(k)));
    if (ctx.prefer) { const fav = pool.filter((t) => keysOf(t).includes(ctx.prefer)); if (fav.length) pool = fav; }
    if (rarity !== "epic") pool = pool.filter((t) => t.kind !== "weapon").length ? pool.filter((t) => t.kind !== "weapon") : pool;
    else if (pool.some((t) => t.kind === "weapon") && !ctx.prefer) pool = pool.filter((t) => t.kind === "weapon");
    if (!pool.length) return null;
    const t = pool[Math.floor(r() * pool.length)];
    const fitLevel = Math.max(1, (ctx.level || 1) - RARITY[rarity].levelBack);
    const v = E.fitSkill({ ...t, effects: t.effects.map((e) => ({ ...e })) }, fitLevel);
    if (!v.skill || v.overBudget) return null;
    const file = { ...v.skill, id: E.newId(r, "bp_"), from: "drop", rarity };
    const duplicate = (ctx.owned || []).some((x) => x && x.name === file.name && x.kind === file.kind);
    return { file, rarity, duplicate, refund: duplicate ? RARITY[rarity].refund : 0 };
  }

  return {
    codexPrice, BLUEPRINTS, DROP_CHANCE, RARITY, rollDrop,
    START, FREE_ROUNDS_PER_DAY, ROUND_COST, ARENA_REWARDS_PER_DAY, PRICES, LEDGER_KEEP,
    itemPrice, forgeCost, dayKey, newWallet, sanitizeWallet, balance, credit, spend, canAfford,
    gymQuote, payForGym, rivalReward, arenaReward, payArena,
  };
});
