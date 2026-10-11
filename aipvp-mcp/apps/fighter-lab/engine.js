/* Fighter Lab game engine (rules v3): skills with energy costs and cooldowns, status effects,
 * passives, items, battle rules, stats, learning instincts, training, rivals and arena helpers.
 * Pure logic with no DOM, so it runs in the browser (global `FighterEngine`) and in Node (require). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FighterEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // =====================================================================================
  // Styles: the type chart. Each style beats the next: aggro > social > mind > guard > aggro.
  // =====================================================================================
  const STYLES = ["aggro", "social", "mind", "guard"];
  const BEATS = { aggro: "social", social: "mind", mind: "guard", guard: "aggro" };
  const STYLE_INFO = {
    aggro:  { label: "Aggro",  blurb: "Raw force. Beats Social, loses to Guard." },
    social: { label: "Social", blurb: "Influence. Beats Mind, loses to Aggro." },
    mind:   { label: "Mind",   blurb: "Planning. Beats Guard, loses to Social." },
    guard:  { label: "Guard",  blurb: "Defense and intel. Beats Aggro, loses to Mind." },
  };
  const STYLE_COLOR = { aggro: "#c8402a", social: "#c2457e", mind: "#1d8079", guard: "#56677a" };
  function typeMult(attStyle, defStyle) {
    if (!attStyle || !defStyle) return 1;
    if (BEATS[attStyle] === defStyle) return 2;
    if (BEATS[defStyle] === attStyle) return 0.5;
    return 1;
  }

  const PHASES = [
    { id: "opening", until: 4, mult: 1 },
    { id: "midgame", until: 8, mult: 1.5 },
    { id: "endgame", until: 12, mult: 2 },
  ];
  const TURNS = 12;
  const MAX_LEVEL = 50;
  const TRAITS = ["aggression", "caution", "creativity", "loyalty"];
  const STYLE_TRAIT = { aggro: "aggression", guard: "caution", mind: "creativity", social: "loyalty" };
  const ENERGY = { start: 3, perTurn: 2, max: 10 };
  function phaseOf(turn) { return PHASES.findIndex((p) => turn <= p.until); }

  // =====================================================================================
  // Effects: the only building blocks a skill can use. Each has limits and a price.
  // =====================================================================================
  const STATUS_KEYS = ["burn", "poison", "weaken", "stun"];
  // Active effects (skills you use in battle)
  const EFFECTS = {
    damage:        { label: "Damage",        params: { power: [0.5, 6, 0.1], hits: [1, 3, 1] } },
    drain:         { label: "Life drain",    params: { pct: [0.1, 0.6, 0.05] } },
    burn:          { label: "Burn",          params: { chance: [0.1, 1, 0.05], damage: [1, 4, 1], turns: [1, 4, 1] } },
    poison:        { label: "Poison",        params: { chance: [0.1, 1, 0.05], stacks: [1, 2, 1] } },
    stun:          { label: "Stun",          params: { chance: [0.1, 0.6, 0.05] } },
    shield:        { label: "Shield",        params: { amount: [2, 12, 1], turns: [1, 3, 1] } },
    heal:          { label: "Heal",          params: { amount: [3, 20, 1] } },
    regen:         { label: "Regenerate",    params: { heal: [2, 8, 1], every: [1, 3, 1], turns: [2, 12, 1] } },
    weaken:        { label: "Weaken",        params: { pct: [0.1, 0.5, 0.05], turns: [1, 3, 1] } },
    focus:         { label: "Focus",         params: { mult: [1.2, 2, 0.1] } },
    cleanse:       { label: "Cleanse",       params: {} },
    energy_gain:   { label: "Gain energy",   params: { amount: [1, 3, 1] } },
    energy_drain:  { label: "Drain energy",  params: { amount: [1, 3, 1] } },
  };
  // Passive effects (always on)
  const PASSIVE_EFFECTS = {
    regen:         { label: "Regenerate",    params: { heal: [1, 6, 1], every: [1, 4, 1] } },
    energy_flow:   { label: "Energy flow",   params: { amount: [1, 2, 1], every: [1, 4, 1] } },
    start_shield:  { label: "Starting shield", params: { amount: [2, 12, 1] } },
    resist:        { label: "Resist",        params: { status: STATUS_KEYS } },
    thorns:        { label: "Thorns",        params: { pct: [0.05, 0.4, 0.05] } },
    style_boost:   { label: "Style mastery", params: { style: STYLES, pct: [0.05, 0.5, 0.05] } },
  };
  const ELEMENTS = ["none", "fire", "ice", "storm", "poison", "light", "shadow", "earth", "water", "tech", "spirit"];

  /** Power budget of one effect: roughly "damage-equivalent per use". */
  function effectBudget(e, totalPower) {
    switch (e.type) {
      case "damage": return e.power * (e.hits || 1);
      case "drain": return e.pct * totalPower * 0.45;
      case "burn": return e.chance * e.damage * e.turns * 0.55;
      case "poison": return e.chance * e.stacks * 2.8;
      case "stun": return e.chance * 4.2;
      case "shield": return e.amount * (0.3 + 0.15 * e.turns);
      case "heal": return e.amount * 0.65;
      case "regen": return e.heal * Math.floor(e.turns / e.every) * 0.65;
      case "weaken": return e.pct * e.turns * 2.2;
      case "focus": return (e.mult - 1) * 2.8;
      case "cleanse": return 1.2;
      case "energy_gain": return e.amount * 1.1;
      case "energy_drain": return e.amount * 0.35;
      default: return 0;
    }
  }
  function passiveBudget(e) {
    switch (e.type) {
      case "regen": return (e.heal / e.every) * 3.4;
      case "energy_flow": return (e.amount / e.every) * 0.9;
      case "start_shield": return e.amount * 0.34;
      case "resist": return e.status === "stun" ? 1.5 : 1;
      case "thorns": return e.pct * 11;
      case "style_boost": return e.pct * 4;
      default: return 0;
    }
  }
  /** The biggest skill a fighter of this level can forge. Grows with level. */
  function maxSkillBudget(level) { return round2(Math.min(12, 4.5 + 0.2 * (level - 1))); }
  function maxPassiveBudget(level) { return round2(Math.min(7, 2.5 + 0.1 * (level - 1))); }

  /**
   * Price a skill: budget -> energy cost and cooldown. `cheaper` (0-2) trades energy for cooldown.
   * Players never set the price themselves.
   */
  function priceSkill(skill, cheaper = 0) {
    if (skill.kind === "passive") {
      const budget = round2(skill.effects.reduce((a, e) => a + passiveBudget(e), 0));
      return { budget, energy: 0, cooldown: 0, priority: 0 };
    }
    const totalPower = skill.effects.filter((e) => e.type === "damage").reduce((a, e) => a + e.power * (e.hits || 1), 0);
    const budget = round2(skill.effects.reduce((a, e) => a + effectBudget(e, totalPower), 0));
    let energy = Math.max(0, Math.ceil((budget - 1.6) / 1.5));
    let cooldown = budget > 9 ? 3 : budget > 7 ? 2 : budget > 5 ? 1 : 0;
    const c = Math.max(0, Math.min(2, cheaper | 0, energy));
    energy -= c; cooldown += c;
    const priority = skill.effects.some((e) => e.type === "shield" || e.type === "stun") ? 1 : 0;
    return { budget, energy: Math.min(8, energy), cooldown: Math.min(4, cooldown), priority };
  }
  function describeEffect(e) {
    const pct = (x) => Math.round(x * 100) + "%";
    switch (e.type) {
      case "damage": return e.hits > 1 ? `${e.hits} hits of ${e.power} damage` : `${e.power} damage`;
      case "drain": return `heals you for ${pct(e.pct)} of damage dealt`;
      case "burn": return `${pct(e.chance)} chance to burn (${e.damage} damage a turn for ${e.turns} turns)`;
      case "poison": return `${pct(e.chance)} chance to poison (+${e.stacks} stack${e.stacks > 1 ? "s" : ""}, 1 damage per stack each turn)`;
      case "stun": return `${pct(e.chance)} chance to stun (they lose their next action)`;
      case "shield": return `shield of ${e.amount} for ${e.turns} turn${e.turns > 1 ? "s" : ""}`;
      case "heal": return `heals ${e.amount} HP`;
      case "regen": return `heals ${e.heal} HP every ${e.every === 1 ? "turn" : e.every + " turns"}${e.turns ? ` for ${e.turns} turns` : ""}`;   // passives last all battle
      case "weaken": return `weakens them (−${pct(e.pct)} damage for ${e.turns} turn${e.turns > 1 ? "s" : ""})`;
      case "focus": return `your next hit does ×${e.mult}`;
      case "cleanse": return "removes your burn, poison and weaken";
      case "energy_gain": return `+${e.amount} energy`;
      case "energy_drain": return `they lose ${e.amount} energy`;
      case "energy_flow": return `+${e.amount} energy every ${e.every} turns`;
      case "start_shield": return `starts each battle with a ${e.amount} shield`;
      case "resist": return `immune to ${e.status}`;
      case "thorns": return `reflects ${pct(e.pct)} of damage taken`;
      case "style_boost": return `+${pct(e.pct)} damage with ${STYLE_INFO[e.style].label} skills`;
      default: return e.type;
    }
  }
  function describeSkill(s) {
    const effects = s.effects.map(describeEffect).join(", ");
    if (s.kind === "passive") return `Passive: ${effects}.`;
    const cost = `${s.energy} energy${s.cooldown ? `, cooldown ${s.cooldown}` : ""}${s.priority ? ", acts first" : ""}`;
    return `${STYLE_INFO[s.style].label}. ${effects[0].toUpperCase() + effects.slice(1)}. (${cost})`;
  }

  // ---------- validating skill files (from the forge, from Claude, or from other players) ----------
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  function num(x, lo, hi, dflt) { const v = Number(x); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt; }
  function snap(v, step) { return round2(Math.round(v / step) * step); }
  function cleanText(x, max, multiline) {
    if (typeof x !== "string") return "";
    const re = multiline ? /[\u0000-\u0009\u000B-\u001F\u007F\u{2028}\u{2029}]/gu : /[\u0000-\u001F\u007F\u{2028}\u{2029}]/gu;
    return x.replace(re, " ").slice(0, max);
  }
  function cleanName(x) {
    const n = cleanText(x, 16, false).toUpperCase().replace(/[^A-Z0-9 '\-]/g, "").trim();
    return n || "???";
  }
  function cleanEffect(raw, table) {
    if (!raw || typeof raw !== "object") return null;
    const type = typeof raw.type === "string" ? raw.type : "";
    const def = Object.prototype.hasOwnProperty.call(table, type) ? table[type] : null;
    if (!def) return null;
    const e = { type };
    for (const [k, spec] of Object.entries(def.params)) {
      if (Array.isArray(spec) && typeof spec[0] === "string") {
        if (!spec.includes(raw[k])) return null;
        e[k] = raw[k];
      } else {
        const [lo, hi, step] = spec;
        e[k] = snap(num(raw[k], lo, hi, lo), step);
      }
    }
    return e;
  }
  /**
   * Turn untrusted input into a valid, priced skill, or explain why not.
   * Returns { skill, errors }. `level` caps the budget (omit for no cap, e.g. rivals).
   */
  function validateSkill(raw, opts = {}) {
    const errors = [];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { skill: null, errors: ["Not a skill file."] };
    const kind = raw.kind === "passive" ? "passive" : "active";
    const table = kind === "passive" ? PASSIVE_EFFECTS : EFFECTS;
    const rawEffects = Array.isArray(raw.effects) ? raw.effects.slice(0, 6) : [];
    const effects = [];
    for (const r of rawEffects) {
      const e = cleanEffect(r, table);
      if (!e) { errors.push(`Unknown or invalid effect: ${String(r && r.type).slice(0, 20)}`); continue; }
      if (effects.some((x) => x.type === e.type)) { errors.push(`Only one ${EFFECTS[e.type]?.label || e.type} per skill.`); continue; }
      effects.push(e);
    }
    if (effects.length > 3) { effects.length = 3; errors.push("A skill can have at most 3 effects."); }
    if (!effects.length) return { skill: null, errors: errors.length ? errors : ["A skill needs at least one effect."] };
    if (kind === "active" && effects.some((e) => e.type === "drain") && !effects.some((e) => e.type === "damage")) {
      return { skill: null, errors: ["Life drain needs a damage effect."] };
    }
    const style = STYLES.includes(raw.style) ? raw.style : "aggro";
    const element = ELEMENTS.includes(raw.element) ? raw.element : "none";
    const id = typeof raw.id === "string" && ID_RE.test(raw.id) && !BASIC[raw.id] ? raw.id : "sk_" + hash(JSON.stringify([kind, style, effects, raw.name])).toString(36);
    const skill = { id, name: cleanName(raw.name || "NEW SKILL"), kind, style, element, effects, cheaper: Math.round(num(raw.cheaper, 0, 2, 0)) };
    Object.assign(skill, priceSkill(skill, skill.cheaper));
    const cap = opts.level ? (kind === "passive" ? maxPassiveBudget(opts.level) : maxSkillBudget(opts.level)) : Infinity;
    if (skill.budget > cap) errors.push(`Too powerful for level ${opts.level}: power ${skill.budget}, limit ${cap}.`);
    return { skill, errors, overBudget: skill.budget > cap };
  }

  /** Scale a skill's numbers down until it fits a level's budget (used for Claude's drafts). */
  function fitSkill(raw, level) {
    const first = validateSkill(raw, { level });
    if (!first.skill || !first.overBudget) return first;
    const cap = first.skill.kind === "passive" ? maxPassiveBudget(level) : maxSkillBudget(level);
    const scaled = (k) => ({ ...first.skill, effects: first.skill.effects.map((e) => {
      const def = (first.skill.kind === "passive" ? PASSIVE_EFFECTS : EFFECTS)[e.type], out = { ...e };
      for (const [key, spec] of Object.entries(def.params)) {
        if (typeof spec[0] === "string" || key === "every" || key === "hits" || key === "turns") continue;
        out[key] = e[key] * k;
      }
      return out;
    }) });
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (validateSkill(scaled(mid), { level }).skill.budget <= cap) lo = mid; else hi = mid; }
    const v = validateSkill(scaled(lo), { level });
    if (v.overBudget) return first;
    return { ...v, errors: [`Scaled down to fit level ${level} (power ${v.skill.budget} of ${cap}).`], scaled: true };
  }

  // =====================================================================================
  // Basic skills: every fighter's starting move set (the 11 original moves, now with costs).
  // =====================================================================================
  const BASIC_DEFS = {
    fight:      { name: "STRIKE",   style: "aggro",  energy: 1, effects: [{ type: "damage", power: 3.0 }], fx: "burst", say: "{me} presses the attack on {them}." },
    deceive:    { name: "FEINT",    style: "aggro",  energy: 2, effects: [{ type: "damage", power: 2.2 }, { type: "weaken", pct: 0.25, turns: 1 }], fx: "ghost", say: "{me} feints, hiding the real plan from {them}." },
    talk:       { name: "PERSUADE", style: "social", energy: 0, effects: [{ type: "damage", power: 2.3 }], fx: "bubbles", say: "{me} tries to win {them} over." },
    negotiate:  { name: "BARGAIN",  style: "social", energy: 0, effects: [{ type: "damage", power: 1.8 }, { type: "energy_gain", amount: 1 }], fx: "coins", say: "{me} offers {them} a deal they can't refuse." },
    debate:     { name: "REBUTTAL", style: "social", energy: 1, effects: [{ type: "damage", power: 2.8 }], fx: "bubbles", say: "{me} picks apart {them}'s last argument." },
    strategize: { name: "GAMBIT",   style: "mind",   energy: 1, effects: [{ type: "damage", power: 1.8 }, { type: "focus", mult: 1.4 }], fx: "sparkle", say: "{me} sets up a plan three moves deep." },
    code:       { name: "COMPILE",  style: "mind",   energy: 2, effects: [{ type: "damage", power: 3.4 }], fx: "glyphs", say: "{me} writes a tool to settle it." },
    search:     { name: "LOOKUP",   style: "mind",   energy: 0, effects: [{ type: "damage", power: 2.3 }], fx: "glyphs", say: "{me} digs up the facts that matter." },
    shield:     { name: "BULWARK",  style: "guard",  energy: 1, effects: [{ type: "damage", power: 1.2 }, { type: "shield", amount: 4, turns: 1 }], fx: "barrier", say: "{me} digs in and defends." },
    observe:    { name: "SCAN",     style: "guard",  energy: 0, effects: [{ type: "damage", power: 2.0 }], fx: "scan", say: "{me} watches {them} closely." },
    analyze:    { name: "DISSECT",  style: "guard",  energy: 1, effects: [{ type: "damage", power: 1.9 }, { type: "energy_drain", amount: 1 }], fx: "scan", say: "{me} studies the pattern in {them}'s moves." },
  };
  const BASIC = {};
  for (const [id, d] of Object.entries(BASIC_DEFS)) {
    const priority = d.effects.some((e) => e.type === "shield" || e.type === "stun") ? 1 : 0;
    const totalPower = d.effects.filter((e) => e.type === "damage").reduce((a, e) => a + e.power, 0);
    BASIC[id] = { id, kind: "active", basic: true, element: "none", cooldown: 0, priority, cheaper: 0,
                  budget: round2(d.effects.reduce((a, e) => a + effectBudget(e, totalPower), 0)), ...d,
                  move: d.name, color: STYLE_COLOR[d.style] };
  }
  // Kept for older callers: SKILLS[id] has .move/.style/.power/.color/.fx/.say for basic skills.
  const SKILLS = Object.fromEntries(Object.entries(BASIC).map(([id, s]) => [id, { ...s, power: s.effects[0].power }]));
  const SKILL_NAMES = Object.keys(BASIC);
  const FX_BY_EFFECT = { burn: "burst", stun: "ghost", poison: "ghost", shield: "barrier", heal: "sparkle", regen: "sparkle", weaken: "ghost",
                         focus: "sparkle", energy_gain: "coins", energy_drain: "scan", drain: "bubbles", damage: "burst" };
  const ELEMENT_COLOR = { fire: "#e2552a", ice: "#58b6e0", storm: "#8a6ce0", poison: "#6aa832", light: "#e8c64a", shadow: "#5b4a7a",
                          earth: "#9a7046", water: "#3a7bd5", tech: "#2c8239", spirit: "#c08ad8" };

  /** Look up a skill by id for a fighter: basic skills, then the fighter's own custom skills. */
  function skillOf(f, id) {
    if (BASIC[id]) return BASIC[id];
    const c = f && f.custom && f.custom[id];
    if (!c) return null;
    const lead = c.effects.find((e) => e.type !== "damage") || c.effects[0];
    return { ...c, move: c.name, color: ELEMENT_COLOR[c.element] || STYLE_COLOR[c.style], fx: c.fx || FX_BY_EFFECT[lead.type] || "burst",
             say: "{me} uses " + c.name + "!" };
  }

  // =====================================================================================
  // Items (consumable, one per battle; using one takes your turn but acts first)
  // =====================================================================================
  const ITEMS = {
    potion:  { id: "potion",  name: "POTION",     blurb: "Heals 25 HP.", price: 12 },
    ether:   { id: "ether",   name: "ETHER",      blurb: "+4 energy.", price: 10 },
    antidote:{ id: "antidote",name: "ANTIDOTE",   blurb: "Cures burn, poison and weaken, and blocks new ones this turn.", price: 8 },
    smoke:   { id: "smoke",   name: "SMOKE BOMB", blurb: "Their damage is halved for 2 turns.", price: 10 },
  };
  const STARTER_PASSIVES = [
    { id: "ps_thick", name: "THICK SKIN", kind: "passive", style: "guard", element: "earth", effects: [{ type: "start_shield", amount: 8 }] },
    { id: "ps_wind", name: "SECOND WIND", kind: "passive", style: "guard", element: "spirit", effects: [{ type: "regen", heal: 2, every: 3 }] },
    { id: "ps_battery", name: "BATTERY", kind: "passive", style: "mind", element: "tech", effects: [{ type: "energy_flow", amount: 1, every: 3 }] },
  ].map((p) => validateSkill(p).skill);

  // =====================================================================================
  // Randomness, progression, stats
  // =====================================================================================
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(str) {
    let h = 2166136261;
    for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function newId(r = Math.random, prefix = "f") {
    return prefix + Math.floor(r() * 2 ** 32).toString(36) + Math.floor(r() * 2 ** 32).toString(36);
  }
  function xpForLevel(level) { return Math.round(40 * Math.pow(level - 1, 2)); }
  function levelForXp(xp) { let lv = 1; while (lv < MAX_LEVEL && xp >= xpForLevel(lv + 1)) lv++; return lv; }
  function statPointsFor(level) { return Math.max(0, level - 1); }
  function statsOf(f) {
    const s = (f && f.stats) || {};
    return { power: s.power | 0, vitality: s.vitality | 0, speed: s.speed | 0 };
  }
  function unspentPoints(f) { const s = statsOf(f); return Math.max(0, statPointsFor(f.level || 1) - s.power - s.vitality - s.speed); }
  function maxHp(level, vitality = 0) { return 55 + 3 * (level - 1) + 4 * vitality; }
  function levelBonus(level) { return 1 + 0.02 * (level - 1); }
  function masteryBonus(uses) { return 0.5 * (1 - Math.exp(-(uses || 0) / 400)); }
  function xpForMatch(result, myLevel, theirLevel) {
    const base = result === "win" ? 30 : result === "draw" ? 18 : 12;
    return Math.round(base * Math.max(0.5, 1 + 0.08 * (theirLevel - myLevel)));
  }

  // =====================================================================================
  // Instincts: a small learning policy over 5 actions (4 skill slots + item).
  // Context = phase (3) x opponent's last style (none + 4) x my HP low/high (2) = 30.
  // =====================================================================================
  const N_ACT = 5, N_CTX = 30, ITEM_SLOT = 4;
  const TEMP = 0.7, LEARN_RATE = 0.12, IMITATE_RATE = 0.5;
  function ctxIndex(phase, oppLastStyle, lowHp) { return (phase * 5 + (oppLastStyle ? 1 + STYLES.indexOf(oppLastStyle) : 0)) * 2 + (lowHp ? 1 : 0); }
  function newBrain(f) {
    const p = f.personality || {};
    const W = [];
    for (let c = 0; c < N_CTX; c++) {
      const low = c % 2 === 1;
      const row = f.moves.map((m) => { const s = skillOf(f, m); return round3(((p[STYLE_TRAIT[s ? s.style : "aggro"]] ?? 0.5) - 0.5) * 1.6); });
      row.push(low ? 0 : -1.5);  // item: an instinct to save it for when HP is low
      W.push(row);
    }
    return { W, b: Array(N_CTX).fill(0) };
  }
  function policy(brain, ctx, mask) {
    const w = brain.W[ctx];
    const vals = w.map((x, i) => (mask && !mask[i] ? -Infinity : x));
    const mx = Math.max(...vals);
    if (!Number.isFinite(mx)) return w.map(() => 0);
    const e = vals.map((x) => (Number.isFinite(x) ? Math.exp((x - mx) / TEMP) : 0)), s = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / s);
  }
  function pick(probs, r) {
    let u = r(), i = 0, last = -1;
    for (; i < probs.length; i++) { if (probs[i] > 0) { last = i; u -= probs[i]; if (u <= 0) return i; } }
    return last;
  }
  function learn(brain, ctx, choice, reward, mask) {
    const pi = policy(brain, ctx, mask), adv = reward - brain.b[ctx];
    const w = brain.W[ctx];
    for (let i = 0; i < w.length; i++) if (!mask || mask[i]) w[i] = clamp(w[i] + LEARN_RATE * adv * ((i === choice ? 1 : 0) - pi[i]), -6, 6);
    brain.b[ctx] += 0.05 * (reward - brain.b[ctx]);
  }
  /** Imitation learning: nudge instincts toward the choice a human trainer made here. */
  function imitate(brain, ctx, choice, mask) {
    const pi = policy(brain, ctx, mask), w = brain.W[ctx];
    for (let i = 0; i < w.length; i++) if (!mask || mask[i]) w[i] = clamp(w[i] + IMITATE_RATE * ((i === choice ? 1 : 0) - pi[i]), -6, 6);
  }
  function compactBrain(brain) { return { W: brain.W.map((row) => row.map(round3)), b: brain.b.map(round3) }; }
  function brainMap(f) {
    const rows = [];
    for (const opp of [null, ...STYLES]) {
      const avg = Array(N_ACT).fill(0);
      for (let ph = 0; ph < 3; ph++) policy(f.brain, ctxIndex(ph, opp, false), [1, 1, 1, 1, 0]).forEach((p, i) => (avg[i] += p / 3));
      const best = avg.indexOf(Math.max(...avg));
      rows.push({ vs: opp, probs: avg.map(round3), best: f.moves[best], confidence: round3(avg[best]) });
    }
    return rows;
  }

  // =====================================================================================
  // Fighters
  // =====================================================================================
  const DEFAULT_DESIGN = { hue: 200, accent: 40, body: "round", size: 0.6, spikes: 1, armor: false, eyes: "round", pattern: "plain" };
  const PERSONA_MAX = 300, PLAYBOOK_MAX = 1200, MAX_RULES = 4;

  function createFighter({ name, moves, personality, design, id, custom, passive, item } = {}, r = Math.random) {
    custom = custom || {};
    moves = (moves || ["fight", "talk", "strategize", "shield"]).slice(0, 4);
    const f0 = { custom };
    if (moves.length !== 4 || new Set(moves).size !== 4 || !moves.every((m) => skillOf(f0, m))) throw new Error("A fighter needs exactly 4 different skills.");
    personality = Object.fromEntries(TRAITS.map((t) => [t, clamp(personality?.[t] ?? 0.5, 0, 1)]));
    const f = {
      id: id || newId(r), name: String(name || "ROOKIE").slice(0, 16), design: { ...DEFAULT_DESIGN, ...(design || {}) },
      personality, moves, custom: pickCustom(custom, moves), passive: passive || null, item: item || null,
      stats: { power: 0, vitality: 0, speed: 0 }, rules: [],
      level: 1, xp: 0, record: { w: 0, l: 0, d: 0 }, battleRecord: { w: 0, l: 0, d: 0 },
      uses: Object.fromEntries(moves.map((m) => [m, 0])), history: [], sessions: 0, createdAt: Date.now(),
      persona: "", playbook: "", rev: 0, version: 3,
    };
    f.brain = newBrain(f);
    return f;
  }
  function pickCustom(custom, moves) {
    const out = {};
    for (const m of moves) if (!BASIC[m] && custom[m]) out[m] = clone(custom[m]);
    return out;
  }
  /** Change the loadout or looks; skills kept in the loadout keep their training. */
  function redesign(f, { name, moves, personality, design, custom, passive, item }) {
    const g = clone(f);
    if (name) g.name = String(name).slice(0, 16);
    if (design) g.design = { ...g.design, ...design };
    if (personality) g.personality = Object.fromEntries(TRAITS.map((t) => [t, clamp(personality[t] ?? g.personality[t], 0, 1)]));
    if (passive !== undefined) g.passive = passive;
    if (item !== undefined) g.item = item;
    const pool = { ...(f.custom || {}), ...(custom || {}) };
    if (moves && moves.join() !== f.moves.join()) {
      const probe = { custom: pool };
      if (moves.length !== 4 || new Set(moves).size !== 4 || !moves.every((m) => skillOf(probe, m))) throw new Error("A fighter needs exactly 4 different skills.");
      g.custom = pickCustom(pool, moves);
      const fresh = newBrain({ ...g, moves });
      moves.forEach((m, i) => {
        const old = f.moves.indexOf(m);
        if (old >= 0) for (let c = 0; c < N_CTX; c++) fresh.W[c][i] = f.brain.W[c][old];
      });
      for (let c = 0; c < N_CTX; c++) fresh.W[c][ITEM_SLOT] = f.brain.W[c][ITEM_SLOT];
      g.brain = fresh;
      g.moves = moves.slice();
      g.uses = Object.fromEntries(moves.map((m) => [m, f.uses[m] || 0]));
      g.rules = (g.rules || []).filter((rl) => rl.do.item || g.moves.includes(rl.do.skill));
    } else if (custom) {
      g.custom = pickCustom(pool, g.moves);
    }
    return g;
  }
  function setStats(f, stats) {
    const s = { power: Math.max(0, stats.power | 0), vitality: Math.max(0, stats.vitality | 0), speed: Math.max(0, stats.speed | 0) };
    if (s.power + s.vitality + s.speed > statPointsFor(f.level)) throw new Error(`Only ${statPointsFor(f.level)} stat points at level ${f.level}.`);
    return { ...clone(f), stats: s };
  }

  /** Bring a fighter saved by an older version up to rules v3, keeping its progress. */
  function upgradeFighter(f) {
    const g = clone(f);
    g.persona = typeof g.persona === "string" ? g.persona.slice(0, PERSONA_MAX) : "";
    g.playbook = typeof g.playbook === "string" ? g.playbook.slice(0, PLAYBOOK_MAX) : "";
    g.rev = Number.isFinite(g.rev) ? g.rev : 0;
    g.battleRecord = g.battleRecord || { w: 0, l: 0, d: 0 };
    g.record = g.record || { w: 0, l: 0, d: 0 };
    g.history = Array.isArray(g.history) ? g.history : [];
    g.custom = g.custom && typeof g.custom === "object" ? g.custom : {};
    // re-price custom skills on every load: a stored price is never trusted
    for (const [id, s] of Object.entries(g.custom)) {
      const v = validateSkill({ ...s, id });
      if (v.skill && v.skill.kind === "active") g.custom[id] = v.skill; else delete g.custom[id];
    }
    g.moves = (Array.isArray(g.moves) ? g.moves : []).map((m) => (skillOf(g, m) ? m : null));
    const spare = SKILL_NAMES.filter((m) => !g.moves.includes(m));
    g.moves = g.moves.map((m) => m || spare.shift()).slice(0, 4);
    while (g.moves.length < 4) g.moves.push(spare.shift());
    g.uses = g.uses || {};
    for (const m of g.moves) g.uses[m] = g.uses[m] || 0;
    g.stats = statsOf(g);
    if (g.stats.power + g.stats.vitality + g.stats.speed > statPointsFor(g.level || 1)) g.stats = { power: 0, vitality: 0, speed: 0 };
    g.rules = sanitizeRules(g.rules, g.moves);
    if (g.passive) { const v = validateSkill(g.passive); g.passive = v.skill && v.skill.kind === "passive" ? v.skill : null; } else g.passive = null;
    g.item = ITEMS[g.item] ? g.item : null;
    // instincts: older fighters had 15 contexts x 4 moves; v3 has 30 x 5
    const b = g.brain;
    const okV3 = b && Array.isArray(b.W) && b.W.length === N_CTX && b.W.every((row) => Array.isArray(row) && row.length === N_ACT);
    if (!okV3) {
      const fresh = newBrain(g);
      if (b && Array.isArray(b.W) && b.W.length === 15) {
        for (let c = 0; c < N_CTX; c++) {
          const old = b.W[Math.floor(c / 2)];
          if (Array.isArray(old)) for (let i = 0; i < 4; i++) if (Number.isFinite(old[i])) fresh.W[c][i] = old[i];
        }
      }
      g.brain = fresh;
    }
    g.version = 3;
    return g;
  }

  // ---------- battle rules (if-then, like Gladiabots) ----------
  const RULE_CONDITIONS = {
    my_hp_below:      { label: "My HP is below", value: [10, 90, 5], unit: "%" },
    their_hp_below:   { label: "Their HP is below", value: [10, 90, 5], unit: "%" },
    my_energy_at_least: { label: "My energy is at least", value: [1, 10, 1], unit: "" },
    i_have:           { label: "I am", value: ["burn", "poison", "weaken"] },
    they_have:        { label: "They are", value: ["burn", "poison", "weaken", "shield"] },
    phase_is:         { label: "The phase is", value: ["opening", "midgame", "endgame"] },
    their_last_style: { label: "Their last move was", value: STYLES },
  };
  function sanitizeRules(rules, moves) {
    if (!Array.isArray(rules)) return [];
    const out = [];
    for (const r of rules.slice(0, MAX_RULES)) {
      if (!r || typeof r !== "object" || !r.when || !r.do) continue;
      const def = Object.prototype.hasOwnProperty.call(RULE_CONDITIONS, r.when.kind) ? RULE_CONDITIONS[r.when.kind] : null;
      if (!def) continue;
      let value;
      if (typeof def.value[0] === "string") { if (!def.value.includes(r.when.value)) continue; value = r.when.value; }
      else value = snap(num(r.when.value, def.value[0], def.value[1], def.value[0]), def.value[2]);
      let act;
      if (r.do.item === true) act = { item: true };
      else if (typeof r.do.skill === "string" && moves.includes(r.do.skill)) act = { skill: r.do.skill };
      else continue;
      out.push({ when: { kind: r.when.kind, value }, do: act });
    }
    return out;
  }
  function describeRule(rule, f) {
    const def = RULE_CONDITIONS[rule.when.kind];
    const v = typeof def.value[0] === "string" ? (rule.when.kind === "their_last_style" ? STYLE_INFO[rule.when.value].label : rule.when.value) : rule.when.value + (def.unit || "");
    const act = rule.do.item ? `use my item${f && f.item ? " (" + ITEMS[f.item].name + ")" : ""}` : `use ${skillOf(f, rule.do.skill)?.name || rule.do.skill}`;
    return `If ${def.label.toLowerCase()} ${v}, ${act}.`;
  }

  // =====================================================================================
  // Battle state
  // =====================================================================================
  function passiveEffects(f) { return f.passive && f.passive.effects ? f.passive.effects : []; }
  function newSide(f) {
    const st = statsOf(f);
    const max = maxHp(f.level || 1, st.vitality);
    const s = {
      f, hp: max, max, energy: ENERGY.start, shield: null, cooldowns: {},
      burn: null, poison: null, weaken: null, focus: 0, stunned: false, stunImmuneUntil: 0, regen: [],
      itemLeft: !!(f.item && ITEMS[f.item]), smoke: 0, statusBlock: 0,
      last: null, styleCounts: { aggro: 0, social: 0, mind: 0, guard: 0 }, scripted: !f.brain, learn: false, imitate: false, speed: st.speed,
    };
    for (const e of passiveEffects(f)) if (e.type === "start_shield") s.shield = { amount: e.amount, turns: 99 };
    return s;
  }
  /** opts: { learnA, learnB } — whether each side's instincts learn from this battle. */
  function newBattle(A, B, opts = {}) {
    const side = [A, B].map(newSide);
    side[0].learn = !!opts.learnA && !side[0].scripted;
    side[1].learn = !!opts.learnB && !side[1].scripted;
    return { side, turns: [], turn: 1, over: false };
  }
  function resists(s, status) { return passiveEffects(s.f).some((e) => e.type === "resist" && e.status === status); }
  /** Which of the 5 actions (4 skills + item) a side can take right now. */
  function legalMask(state, i) {
    const s = state.side[i];
    const mask = s.f.moves.map((m) => {
      const sk = skillOf(s.f, m);
      return sk && s.energy >= sk.energy && !(s.cooldowns[m] > 0) ? 1 : 0;
    });
    mask.push(s.itemLeft ? 1 : 0);
    return mask;
  }
  function actionOf(f, idx) { return idx === ITEM_SLOT ? { kind: "item" } : { kind: "skill", skill: f.moves[idx] }; }
  function slotOf(f, action) { return action.kind === "item" ? ITEM_SLOT : action.kind === "skill" ? f.moves.indexOf(action.skill) : -1; }
  function isLegal(state, i, action) {
    if (!action) return false;
    if (action.kind === "rest") return true;
    const slot = slotOf(state.side[i].f, action);
    return slot >= 0 && legalMask(state, i)[slot] === 1;
  }
  function ruleMatches(state, i, rule) {
    const me = state.side[i], them = state.side[1 - i], v = rule.when.value;
    switch (rule.when.kind) {
      case "my_hp_below": return (me.hp / me.max) * 100 < v;
      case "their_hp_below": return (them.hp / them.max) * 100 < v;
      case "my_energy_at_least": return me.energy >= v;
      case "i_have": return !!me[v];
      case "they_have": return v === "shield" ? !!(them.shield && them.shield.amount > 0) : !!them[v];
      case "phase_is": return PHASES[phaseOf(state.turn)].id === v;
      case "their_last_style": return them.last === v;
      default: return false;
    }
  }
  /** The first battle rule that applies and can be carried out, or null. */
  function ruleChoice(state, i) {
    const f = state.side[i].f;
    for (const rule of f.rules || []) {
      if (!ruleMatches(state, i, rule)) continue;
      const action = rule.do.item ? { kind: "item" } : { kind: "skill", skill: rule.do.skill };
      if (isLegal(state, i, action)) return { ...action, source: "rule", rule: describeRule(rule, f) };
    }
    return null;
  }
  function ctxFor(state, i) {
    const me = state.side[i], them = state.side[1 - i];
    return ctxIndex(phaseOf(state.turn), them.last, me.hp / me.max < 0.4);
  }
  /** The action a side's rules or instincts pick (or a practice partner's script). */
  function instinctChoice(state, i, r) {
    const s = state.side[i];
    const ruled = ruleChoice(state, i);
    if (ruled) return ruled;
    const mask = legalMask(state, i);
    if (!mask.some(Boolean)) return { kind: "rest" };
    if (s.scripted) return scriptedChoice(state, i, r, mask);
    const ctx = ctxFor(state, i);
    const idx = pick(policy(s.f.brain, ctx, mask), r);
    return { ...actionOf(s.f, idx), idx, ctx };
  }
  /** What instincts think of each legal action right now (for AI prompts). */
  function instinctOdds(state, i) {
    const s = state.side[i];
    if (s.scripted) return null;
    const mask = legalMask(state, i);
    const probs = policy(s.f.brain, ctxFor(state, i), mask);
    return probs.map((p, k) => ({ action: k === ITEM_SLOT ? "item" : s.f.moves[k], p: round3(p) })).filter((x) => x.p > 0);
  }

  // ---------- resolving a turn ----------
  function addLog(log, text) { log.push(text); }
  function applyDamage(state, att, def, sk, power, hits, mult, r, out) {
    const a = state.side[att], d = state.side[def];
    let total = 0;
    const tm = out.typeMult;
    const boost = passiveEffects(a.f).filter((e) => e.type === "style_boost" && e.style === sk.style).reduce((x, e) => x + e.pct, 0);
    const focus = a.focus || 1;
    a.focus = 0;
    for (let h = 0; h < hits; h++) {
      let dmg = power * mult * tm * (1 + masteryBonus(a.f.uses?.[sk.id])) * levelBonus(a.f.level || 1)
        * (1 + 0.03 * statsOf(a.f).power) * (1 + boost) * focus * (0.9 + 0.2 * r());
      if (a.weaken) dmg *= 1 - a.weaken.pct;
      if (a.smoke > 0) dmg *= 0.5;
      dmg = round2(dmg);
      if (d.shield && d.shield.amount > 0) {
        const absorbed = Math.min(d.shield.amount, dmg);
        d.shield.amount = round2(d.shield.amount - absorbed);
        out.absorbed = round2((out.absorbed || 0) + absorbed);
        dmg = round2(dmg - absorbed);
        if (d.shield.amount <= 0) d.shield = null;
      }
      d.hp = Math.max(0, round2(d.hp - dmg));
      total = round2(total + dmg);
      const thorns = passiveEffects(d.f).filter((e) => e.type === "thorns").reduce((x, e) => x + e.pct, 0);
      if (thorns && dmg > 0) { const back = round2(dmg * thorns); a.hp = Math.max(0, round2(a.hp - back)); out.reflected = round2((out.reflected || 0) + back); }
      if (d.hp <= 0) break;
    }
    return total;
  }
  function tryStatus(state, def, kind, chance, r, out) {
    const d = state.side[def];
    if (resists(d, kind) || d.statusBlock > 0) { out.notes.push(`${d.f.name} resists ${kind}`); return false; }
    if (kind === "stun" && d.stunImmuneUntil >= state.turn) { out.notes.push(`${d.f.name} can't be stunned again yet`); return false; }
    return r() < chance;
  }
  function doAction(state, i, action, r, out) {
    const me = state.side[i], them = state.side[1 - i];
    const turn = state.turn, mult = PHASES[phaseOf(turn)].mult;
    if (action.kind === "rest") { me.energy = Math.min(ENERGY.max, me.energy + 1); out.notes.push(`${me.f.name} rests (+1 energy)`); return; }
    if (action.kind === "item") {
      const it = ITEMS[me.f.item];
      me.itemLeft = false;
      out.item = it.id;
      if (it.id === "potion") { const before = me.hp; me.hp = Math.min(me.max, round2(me.hp + 25)); out.healed = round2(me.hp - before); }
      else if (it.id === "ether") me.energy = Math.min(ENERGY.max, me.energy + 4);
      else if (it.id === "antidote") { me.burn = me.poison = me.weaken = null; me.statusBlock = 1; }
      else if (it.id === "smoke") them.smoke = 2;
      return;
    }
    const sk = skillOf(me.f, action.skill);
    if (me.energy < sk.energy) { out.fizzled = true; out.notes.push(`${me.f.name} doesn't have the energy for ${sk.name}`); return; }
    me.energy -= sk.energy;
    if (sk.cooldown) me.cooldowns[sk.id] = sk.cooldown + 1;   // +1: counted down at the end of this turn
    const dmgE = sk.effects.find((e) => e.type === "damage");
    let dealt = 0;
    if (dmgE) dealt = applyDamage(state, i, 1 - i, sk, dmgE.power, dmgE.hits || 1, mult, r, out);
    out.points = dealt;
    for (const e of sk.effects) {
      switch (e.type) {
        case "drain": if (dealt > 0) { const h = round2(dealt * e.pct); me.hp = Math.min(me.max, round2(me.hp + h)); out.healed = round2((out.healed || 0) + h); } break;
        case "burn": if (tryStatus(state, 1 - i, "burn", e.chance, r, out)) { them.burn = { damage: Math.max(e.damage, them.burn?.damage || 0), turns: Math.max(e.turns, them.burn?.turns || 0) }; out.applied.push("burn"); } break;
        case "poison": if (tryStatus(state, 1 - i, "poison", e.chance, r, out)) { them.poison = { stacks: Math.min(5, (them.poison?.stacks || 0) + e.stacks), turns: 4 }; out.applied.push("poison"); } break;
        case "stun": if (tryStatus(state, 1 - i, "stun", e.chance, r, out)) { them.stunned = true; out.applied.push("stun"); } break;
        case "weaken": if (tryStatus(state, 1 - i, "weaken", 1, r, out)) { them.weaken = { pct: Math.max(e.pct, them.weaken?.pct || 0), turns: Math.max(e.turns, them.weaken?.turns || 0) }; out.applied.push("weaken"); } break;
        case "shield": me.shield = { amount: Math.min(20, round2((me.shield?.amount || 0) + e.amount)), turns: Math.max(e.turns, me.shield?.turns || 0) }; out.applied.push("shield"); break;
        case "heal": { const before = me.hp; me.hp = Math.min(me.max, round2(me.hp + e.amount)); out.healed = round2((out.healed || 0) + me.hp - before); break; }
        case "regen": if (me.regen.length < 2) { me.regen.push({ heal: e.heal, every: e.every, turns: e.turns, age: 0 }); out.applied.push("regen"); } break;
        case "focus": me.focus = Math.max(me.focus || 1, e.mult); out.applied.push("focus"); break;
        case "cleanse": me.burn = me.poison = me.weaken = null; out.applied.push("cleanse"); break;
        case "energy_gain": me.energy = Math.min(ENERGY.max, me.energy + e.amount); break;
        case "energy_drain": them.energy = Math.max(0, them.energy - e.amount); break;
        default: break;
      }
    }
  }
  function endOfTurn(state, events) {
    for (const s of state.side) {
      if (s.hp <= 0) continue;
      if (s.burn) { s.hp = Math.max(0, round2(s.hp - s.burn.damage)); events.push({ who: s.f.name, kind: "burn", amount: s.burn.damage }); if (--s.burn.turns <= 0) s.burn = null; }
      if (s.poison && s.hp > 0) { s.hp = Math.max(0, round2(s.hp - s.poison.stacks)); events.push({ who: s.f.name, kind: "poison", amount: s.poison.stacks }); if (--s.poison.turns <= 0) s.poison = null; }
      const heals = [];
      for (const rg of s.regen) { rg.age++; if (rg.age % rg.every === 0) heals.push(rg.heal); }
      s.regen = s.regen.filter((rg) => rg.age < rg.turns);
      for (const e of passiveEffects(s.f)) if (e.type === "regen" && state.turn % e.every === 0) heals.push(e.heal);
      for (const h of heals) if (s.hp > 0) { const b = s.hp; s.hp = Math.min(s.max, round2(s.hp + h)); if (s.hp > b) events.push({ who: s.f.name, kind: "regen", amount: round2(s.hp - b) }); }
      if (s.weaken && --s.weaken.turns <= 0) s.weaken = null;
      if (s.shield && --s.shield.turns <= 0) s.shield = null;
      if (s.smoke > 0) s.smoke--;
      if (s.statusBlock > 0) s.statusBlock--;
      for (const k of Object.keys(s.cooldowns)) if (--s.cooldowns[k] <= 0) delete s.cooldowns[k];
    }
  }
  function startOfTurn(state) {
    if (state.turn === 1) return;
    for (const s of state.side) {
      s.energy = Math.min(ENERGY.max, s.energy + ENERGY.perTurn);
      for (const e of passiveEffects(s.f)) if (e.type === "energy_flow" && state.turn % e.every === 0) s.energy = Math.min(ENERGY.max, s.energy + e.amount);
    }
  }
  function priorityOf(f, action) {
    if (action.kind === "item") return 2;
    if (action.kind === "skill") return skillOf(f, action.skill)?.priority || 0;
    return 0;
  }
  function styleOfAction(f, action) { return action.kind === "skill" ? skillOf(f, action.skill)?.style : null; }

  /** Apply both sides' choices for this turn. picks[i] = { kind, skill?, source?, line? }. Returns the turn record. */
  function resolveTurn(state, picks, r) {
    if (state.over) throw new Error("The battle is already over.");
    const side = state.side, turn = state.turn;
    const ph = phaseOf(turn), mult = PHASES[ph].mult;
    picks = picks.map((p, i) => {
      if (p && p.kind === undefined && p.skill) p = { ...p, kind: "skill" };   // older callers pass { skill }
      if (!isLegal(state, i, p)) throw new Error(`${side[i].f.name} can't do that right now.`);
      return p;
    });
    const before = side.map((s) => s.hp);
    // the learning context is the situation the choice was made in
    const ctxs = [0, 1].map((i) => ctxFor(state, i)), masks = [0, 1].map((i) => legalMask(state, i));
    const styles = picks.map((p, i) => styleOfAction(side[i].f, p));
    // order: priority, then speed, then a coin flip
    const order = [0, 1].sort((a, b) => priorityOf(side[b].f, picks[b]) - priorityOf(side[a].f, picks[a]) || side[b].speed - side[a].speed);
    if (priorityOf(side[0].f, picks[0]) === priorityOf(side[1].f, picks[1]) && side[0].speed === side[1].speed && r() < 0.5) order.reverse();
    const outs = [null, null];
    for (const i of order) {
      const me = side[i];
      const out = { order: order.indexOf(i) + 1, typeMult: typeMult(styles[i], styles[1 - i]), applied: [], notes: [], points: 0 };
      outs[i] = out;
      if (me.hp <= 0 || side[1 - i].hp <= 0) { out.skipped = true; continue; }
      if (me.stunned) { me.stunned = false; me.stunImmuneUntil = turn + 2; out.stunned = true; out.notes.push(`${me.f.name} is stunned and can't act`); continue; }
      doAction(state, i, picks[i], r, out);
    }
    const events = [];
    if (side.every((s) => s.hp > 0)) endOfTurn(state, events);
    // learning: HP swing this turn, scaled to the phase
    side.forEach((s, i) => {
      if (!s.learn) return;
      const p = picks[i];
      if (p.kind === "rest") return;
      const mask = p.mask || masks[i];
      const ctx = p.ctx ?? ctxs[i];
      const idx = p.idx ?? slotOf(s.f, p);
      if (idx < 0) return;
      const reward = ((before[1 - i] - side[1 - i].hp) - (before[i] - s.hp)) / (3 * mult);
      learn(s.f.brain, ctx, idx, reward, mask);
      if (p.kind === "skill") s.f.uses[p.skill] = (s.f.uses[p.skill] || 0) + 1;
    });
    side.forEach((s, i) => { const st = styles[i]; if (st) { s.last = st; s.styleCounts[st]++; } });
    const actions = picks.map((p, i) => {
      const f = side[i].f, o = outs[i], sk = p.kind === "skill" ? skillOf(f, p.skill) : null;
      const name = p.kind === "item" ? ITEMS[f.item].name : p.kind === "rest" ? "REST" : sk.name;
      return {
        agent_id: f.id, agent_name: f.name, kind: p.kind, skill: p.kind === "skill" ? p.skill : p.kind, name,
        style: sk ? sk.style : null, points: o.points || 0, order: o.order,
        effect: o.typeMult > 1 ? "super" : o.typeMult < 1 ? "resisted" : "neutral",
        applied: o.applied, notes: o.notes, healed: o.healed || 0, absorbed: o.absorbed || 0, reflected: o.reflected || 0,
        stunned: !!o.stunned, fizzled: !!o.fizzled, skipped: !!o.skipped, item: o.item || null,
        content: sk ? sk.say.replace("{me}", f.name).replace("{them}", side[1 - i].f.name) : "",
        ...(p.source ? { source: p.source } : {}), ...(p.line ? { line: p.line } : {}), ...(p.rule ? { rule: p.rule } : {}),
      };
    });
    const snapshot = side.map((s) => ({
      hp: s.hp, max: s.max, energy: s.energy, shield: s.shield ? s.shield.amount : 0,
      status: [s.burn && "burn", s.poison && `poison×${s.poison.stacks}`, s.weaken && "weaken", s.stunned && "stunned", s.regen.length && "regen", s.focus > 1 && "focus"].filter(Boolean),
      cooldowns: { ...s.cooldowns }, itemLeft: s.itemLeft,
    }));
    const rec = { turn, phase: PHASES[ph].id, multiplier: mult, actions, events, hp: side.map((s) => s.hp), max: side.map((s) => s.max), state: snapshot };
    state.turns.push(rec);
    state.turn++;
    if (side.some((s) => s.hp <= 0) || state.turn > TURNS) state.over = true;
    else startOfTurn(state);
    return rec;
  }
  function finishBattle(state) {
    const side = state.side, turns = state.turns;
    const frac = side.map((s) => s.hp / s.max);
    const winner = Math.abs(frac[0] - frac[1]) < 1e-9 ? null : frac[0] > frac[1] ? 0 : 1;
    const ko = side.some((s) => s.hp <= 0);
    return {
      winner, ko, turns, rules: 3,
      result: winner === null ? "draw" : winner === 0 ? "win" : "loss",
      agents: side.map((s, i) => ({ id: s.f.id, name: s.f.name, hp: s.hp, max: s.max, level: s.f.level || 1,
                                     score: round2(turns.reduce((a, t) => a + (t.actions[i].points || 0), 0)) })),
    };
  }
  /** Run one whole match on rules + instincts. Mutates a fighter only when its side is learning. */
  function fight(A, B, opts = {}) {
    const r = opts.rng || Math.random;
    const st = newBattle(A, B, opts);
    while (!st.over) {
      const picks = [0, 1].map((i) => { const p = instinctChoice(st, i, r); if (st.side[i].learn) p.mask = legalMask(st, i); return p; });
      resolveTurn(st, picks, r);
    }
    return finishBattle(st);
  }

  // =====================================================================================
  // Gym partners and training
  // =====================================================================================
  function styleBot(id, name, style, moves, look) {
    return { id, name, kind: "dummy", style, moves, level: 1, unlock: 1, design: look, blurb: `Mostly uses ${STYLE_INFO[style].label} moves.` };
  }
  const PARTNERS = [
    styleBot("brawler", "BRAWLER", "aggro", ["fight", "deceive", "talk", "shield"], { hue: 8, accent: 45, body: "wide", size: 0.75, spikes: 3, armor: false, eyes: "angry", pattern: "plain" }),
    styleBot("talker", "TALKER", "social", ["talk", "negotiate", "debate", "observe"], { hue: 320, accent: 50, body: "round", size: 0.55, spikes: 0, armor: false, eyes: "round", pattern: "spots" }),
    styleBot("schemer", "SCHEMER", "mind", ["strategize", "code", "search", "deceive"], { hue: 165, accent: 280, body: "tall", size: 0.6, spikes: 1, armor: false, eyes: "visor", pattern: "stripes" }),
    styleBot("turtle", "TURTLE", "guard", ["shield", "observe", "analyze", "fight"], { hue: 95, accent: 200, body: "wide", size: 0.7, spikes: 0, armor: true, eyes: "round", pattern: "plain" }),
    { id: "cycler", name: "CYCLER", kind: "cycler", moves: ["fight", "talk", "code", "shield"], level: 3, unlock: 1,
      design: { hue: 45, accent: 190, body: "tall", size: 0.55, spikes: 2, armor: false, eyes: "visor", pattern: "stripes" },
      blurb: "Rotates styles in a fixed order. Learn the pattern to beat it." },
    { id: "mirror", name: "MIRROR", kind: "mirror", level: 0, unlock: 1, blurb: "A copy of your fighter as it is now." },
    { id: "vex", name: "COACH VEX", kind: "adaptive", moves: ["fight", "negotiate", "strategize", "shield"], level: 8, unlock: 5,
      design: { hue: 268, accent: 10, body: "tall", size: 0.7, spikes: 2, armor: true, eyes: "angry", pattern: "stripes" },
      blurb: "Counters whatever style you've used most this match." },
    { id: "ora", name: "COACH ORA", kind: "trained", moves: ["deceive", "debate", "code", "analyze"], level: 14, unlock: 10, train: 600,
      design: { hue: 190, accent: 330, body: "round", size: 0.75, spikes: 1, armor: true, eyes: "visor", pattern: "spots" },
      personality: { aggression: 0.6, caution: 0.6, creativity: 0.7, loyalty: 0.4 }, item: "potion",
      blurb: "A fully trained brain. Reads your habits." },
    { id: "kade", name: "CHAMPION KADE", kind: "trained", moves: ["fight", "negotiate", "strategize", "shield"], level: 26, unlock: 20, train: 1500,
      design: { hue: 355, accent: 50, body: "wide", size: 0.85, spikes: 3, armor: true, eyes: "angry", pattern: "stripes" },
      personality: { aggression: 0.7, caution: 0.6, creativity: 0.6, loyalty: 0.5 }, item: "potion",
      blurb: "The strongest fighter in the gym." },
  ];
  const _trained = {};
  function spreadStats(level, power, vitality) {
    const pts = statPointsFor(level), p = Math.round(pts * power), v = Math.round(pts * vitality);
    return { power: p, vitality: v, speed: Math.max(0, pts - p - v) };
  }
  function partnerFighter(id, you) {
    const p = PARTNERS.find((x) => x.id === id);
    if (!p) throw new Error("Unknown partner " + id);
    if (p.kind === "mirror") {
      const m = clone(you);
      Object.assign(m, { id: "mirror", name: "MIRROR", partner: p });
      m.design = { ...m.design, hue: (m.design.hue + 180) % 360 };
      return m;
    }
    if (p.kind === "trained") {
      if (!_trained[p.id]) {
        const f = createFighter({ id: p.id, name: p.name, moves: p.moves, personality: p.personality, design: p.design, item: p.item });
        f.level = p.level; f.xp = xpForLevel(p.level); f.stats = spreadStats(p.level, 0.4, 0.4);
        const r = rng(hash(p.id));
        const foes = ["brawler", "talker", "schemer", "turtle", "cycler"];
        for (let i = 0; i < p.train; i++) fight(f, partnerFighter(foes[i % foes.length], f), { rng: r, learnA: true });
        for (const m of f.moves) f.uses[m] = p.train;
        f.brain = compactBrain(f.brain);
        _trained[p.id] = f;
      }
      return Object.assign(clone(_trained[p.id]), { partner: p });
    }
    // Practice partners match your level (and spend stat points like you could), so beating them takes strategy.
    const level = p.unlock > 1 ? p.level : Math.max(p.level, you?.level || 1);
    return { id: p.id, name: p.name, moves: p.moves, custom: {}, design: p.design, level, partner: p, item: null, passive: null, rules: [],
             stats: spreadStats(level, 0.4, 0.4), uses: Object.fromEntries(p.moves.map((m) => [m, 150 * level])),
             personality: { aggression: 0.5, caution: 0.5, creativity: 0.5, loyalty: 0.5 } };
  }
  function availablePartners(level) { return PARTNERS.map((p) => ({ ...p, locked: level < p.unlock })); }
  function scriptedChoice(state, i, r, mask) {
    const s = state.side[i], f = s.f, p = f.partner, opp = state.side[1 - i];
    const legal = f.moves.filter((m, k) => mask[k]);
    const any = () => ({ kind: "skill", skill: legal[Math.floor(r() * legal.length)] });
    if (!legal.length) return mask[ITEM_SLOT] ? { kind: "item" } : { kind: "rest" };
    const fromStyle = (style) => { const c = legal.filter((m) => skillOf(f, m).style === style); return c.length ? { kind: "skill", skill: c[Math.floor(r() * c.length)] } : any(); };
    if (p.kind === "dummy") return r() < 0.75 ? fromStyle(p.style) : any();
    if (p.kind === "cycler") return r() < 0.85 ? fromStyle(STYLES[(state.turn - 1) % 4]) : any();
    if (p.kind === "adaptive") {
      const counts = opp.styleCounts;
      const top = STYLES.reduce((a, b) => (counts[b] > counts[a] ? b : a), STYLES[0]);
      const counter = STYLES.find((st) => BEATS[st] === top);
      return state.turn > 1 && r() < 0.8 ? fromStyle(counter) : any();
    }
    return any();
  }

  /** Spar `reps` times against a partner. Returns the updated fighter (a copy) and a report. */
  function train(fighter, partnerId, reps, opts = {}) {
    const r = opts.rng || Math.random;
    const f = clone(fighter);
    const before = { level: f.level, xp: f.xp, mastery: Object.fromEntries(f.moves.map((m) => [m, masteryBonus(f.uses[m])])) };
    const p = PARTNERS.find((x) => x.id === partnerId);
    if (!p) throw new Error("Unknown partner " + partnerId);
    if (f.level < p.unlock) throw new Error(`${p.name} unlocks at level ${p.unlock}.`);
    const res = { win: 0, loss: 0, draw: 0 };
    const curve = [];
    let last = null;
    for (let i = 0; i < reps; i++) {
      const foe = partnerFighter(partnerId, f);
      last = fight(f, foe, { rng: r, learnA: true });
      res[last.result]++;
      f.record[last.result === "win" ? "w" : last.result === "loss" ? "l" : "d"]++;
      f.xp += xpForMatch(last.result, f.level, foe.level || 1);
      f.level = levelForXp(f.xp);
      curve.push(last.result === "win" ? 1 : last.result === "draw" ? 0.5 : 0);
    }
    f.brain = compactBrain(f.brain);
    f.sessions = (f.sessions || 0) + 1;
    f.history = [...(f.history || []), { at: Date.now(), partner: partnerId, reps, win: res.win, loss: res.loss, draw: res.draw, level: f.level }].slice(-60);
    return {
      fighter: f,
      report: {
        partner: partnerId, reps, ...res, winRate: reps ? round3((res.win + res.draw / 2) / reps) : 0,
        xpGained: f.xp - before.xp, levelBefore: before.level, levelAfter: f.level,
        mastery: f.moves.map((m) => ({ move: m, before: round3(before.mastery[m]), after: round3(masteryBonus(f.uses[m])) })),
        curve, lastMatch: last,
      },
    };
  }
  /** Spar by hand: start a bout where you choose your fighter's actions (imitation learning). */
  function newSpar(fighter, partnerId) {
    const foe = partnerFighter(partnerId, fighter);
    const st = newBattle(clone(fighter), foe, { learnA: true });
    return { state: st, foe };
  }
  /** One hand-picked turn: instincts imitate your choice, then learn from how it went. */
  function sparTurn(spar, slot, r = Math.random) {
    const st = spar.state, me = st.side[0];
    const mask = legalMask(st, 0);
    const ctx = ctxFor(st, 0);
    let mine;
    if (slot === "rest" || !mask.some(Boolean)) mine = { kind: "rest" };
    else {
      if (!mask[slot]) throw new Error("That action isn't available right now.");
      imitate(me.f.brain, ctx, slot, mask);
      mine = { ...actionOf(me.f, slot), idx: slot, ctx, mask, source: "you" };
    }
    const theirs = instinctChoice(st, 1, r);
    return resolveTurn(st, [mine, theirs], r);
  }
  function finishSpar(fighter, spar) {
    const m = finishBattle(spar.state);
    const f = clone(fighter);
    const trained = spar.state.side[0].f;
    f.brain = compactBrain(trained.brain);
    f.uses = { ...f.uses, ...trained.uses };
    f.record[m.result === "win" ? "w" : m.result === "loss" ? "l" : "d"]++;
    const xp = xpForMatch(m.result, f.level, spar.foe.level || 1) * 2;   // hands-on sparring is worth double
    f.xp += xp; f.level = levelForXp(f.xp);
    return { fighter: f, match: m, xp };
  }
  function evaluate(fighter, partnerId, n = 200, seed = 1) {
    const r = rng(seed);
    let score = 0;
    for (let i = 0; i < n; i++) {
      const res = fight(clone(fighter), partnerFighter(partnerId, fighter), { rng: r });
      score += res.result === "win" ? 1 : res.result === "draw" ? 0.5 : 0;
    }
    return round3(score / n);
  }
  function exhibition(fighter, partnerId, seed) {
    const r = seed == null ? Math.random : rng(seed);
    const foe = partnerFighter(partnerId, fighter);
    return { foe, match: fight(clone(fighter), foe, { rng: r }) };
  }
  function awardBattle(fighter, match, side = 0) {
    const f = clone(fighter);
    const result = match.winner === null ? "draw" : match.winner === side ? "win" : "loss";
    const foe = match.agents[1 - side];
    const xp = 3 * xpForMatch(result, f.level, foe.level || 1);
    f.xp += xp;
    const before = f.level;
    f.level = levelForXp(f.xp);
    f.battleRecord = f.battleRecord || { w: 0, l: 0, d: 0 };
    f.battleRecord[result === "win" ? "w" : result === "loss" ? "l" : "d"]++;
    return { fighter: f, result, xp, levelBefore: before, levelAfter: f.level };
  }

  // =====================================================================================
  // Rivals: Claude-powered opponents with their own kits
  // =====================================================================================
  const RIVAL_SKILLS = {
    haymaker: { name: "HAYMAKER", style: "aggro", element: "earth", effects: [{ type: "damage", power: 4.6 }] },
    charm:    { name: "CHARM", style: "social", element: "light", effects: [{ type: "damage", power: 1.5 }, { type: "weaken", pct: 0.4, turns: 2 }] },
    overclock:{ name: "OVERCLOCK", style: "mind", element: "tech", effects: [{ type: "energy_gain", amount: 3 }, { type: "focus", mult: 1.5 }] },
    fortress: { name: "FORTRESS", style: "guard", element: "earth", effects: [{ type: "shield", amount: 9, turns: 2 }, { type: "heal", amount: 6 }] },
    prophecy: { name: "PROPHECY", style: "mind", element: "spirit", effects: [{ type: "damage", power: 2 }, { type: "stun", chance: 0.45 }] },
    inferno:  { name: "INFERNO", style: "aggro", element: "fire", effects: [{ type: "damage", power: 4 }, { type: "burn", chance: 0.6, damage: 3, turns: 3 }] },
    copycat:  { name: "COPYCAT", style: "social", element: "shadow", effects: [{ type: "damage", power: 2.6 }, { type: "drain", pct: 0.4 }] },
  };
  const RIVAL_PASSIVES = {
    tongue:  { name: "SILVER TONGUE", kind: "passive", style: "social", effects: [{ type: "style_boost", style: "social", pct: 0.15 }] },
    battery: { name: "BATTERY", kind: "passive", style: "mind", effects: [{ type: "energy_flow", amount: 1, every: 3 }] },
    thick:   { name: "THICK SKIN", kind: "passive", style: "guard", effects: [{ type: "start_shield", amount: 8 }] },
    thorns:  { name: "MIRROR SKIN", kind: "passive", style: "guard", effects: [{ type: "thorns", pct: 0.2 }] },
    steady:  { name: "CLEAR MIND", kind: "passive", style: "mind", effects: [{ type: "resist", status: "stun" }] },
    wind:    { name: "SECOND WIND", kind: "passive", style: "guard", effects: [{ type: "regen", heal: 4, every: 2 }] },
  };
  const RIVALS = [
    { id: "sal", name: "SAL THE SCRAPPER", level: 3, train: 80, moves: ["fight", "haymaker", "talk", "shield"], passive: null, item: "potion",
      rules: [{ when: { kind: "my_hp_below", value: 35 }, do: { item: true } }],
      personality: { aggression: 0.85, caution: 0.3, creativity: 0.3, loyalty: 0.3 },
      design: { hue: 18, accent: 50, body: "wide", size: 0.6, spikes: 2, armor: false, eyes: "angry", pattern: "plain" },
      persona: "Brash street fighter. Swings first and swings hard. Gets rattled when blocked, then tries something sneaky.",
      playbook: "- Open with STRIKE to set the tone.\n- Save energy for HAYMAKER.\n- Drink the potion when hurt." },
    { id: "velvet", name: "VELVET", level: 6, train: 150, moves: ["talk", "negotiate", "charm", "observe"], passive: "tongue", item: "smoke",
      personality: { aggression: 0.2, caution: 0.5, creativity: 0.5, loyalty: 0.9 },
      design: { hue: 300, accent: 45, body: "round", size: 0.55, spikes: 0, armor: false, eyes: "round", pattern: "spots" },
      persona: "Smooth talker who wins with charm and leverage. Patient. Hates being rushed.",
      playbook: "- CHARM brawlers to blunt them.\n- Planners fold to talk.\n- Big talk in the endgame when points double." },
    { id: "grid", name: "PROFESSOR GRID", level: 10, train: 250, moves: ["strategize", "code", "overclock", "analyze"], passive: "battery", item: "ether",
      personality: { aggression: 0.3, caution: 0.5, creativity: 0.9, loyalty: 0.3 },
      design: { hue: 170, accent: 280, body: "tall", size: 0.6, spikes: 1, armor: false, eyes: "visor", pattern: "stripes" },
      persona: "Cold analyst. Treats every fight as a puzzle. Builds energy, then strikes with a focused COMPILE.",
      playbook: "- OVERCLOCK, then COMPILE for a focused hit.\n- DISSECT to starve big spenders of energy.\n- Never repeat the same move three times." },
    { id: "bastion", name: "BASTION", level: 15, train: 400, moves: ["shield", "observe", "fortress", "fight"], passive: "thick", item: "potion",
      rules: [{ when: { kind: "my_hp_below", value: 40 }, do: { skill: "fortress" } }],
      personality: { aggression: 0.4, caution: 0.95, creativity: 0.3, loyalty: 0.5 },
      design: { hue: 95, accent: 200, body: "wide", size: 0.8, spikes: 0, armor: true, eyes: "visor", pattern: "plain" },
      persona: "A living wall. Absorbs pressure and counters. Only attacks when the opponent overcommits.",
      playbook: "- BULWARK any attacker.\n- FORTRESS when hurt.\n- Watch for planners: they are my weakness." },
    { id: "mimic", name: "MIMIC", level: 20, train: 600, moves: ["fight", "copycat", "code", "shield"], passive: "thorns", item: "antidote",
      personality: { aggression: 0.5, caution: 0.5, creativity: 0.6, loyalty: 0.5 },
      design: { hue: 45, accent: 190, body: "tall", size: 0.6, spikes: 2, armor: false, eyes: "visor", pattern: "stripes" },
      persona: "Shapeshifter. Learns from whatever just hurt it and turns it around. Unpredictable on purpose.",
      playbook: "- Covers all four styles: pick the counter to their last style.\n- COPYCAT heals while it hits." },
    { id: "oracle", name: "ORACLE", level: 26, train: 900, moves: ["deceive", "debate", "prophecy", "analyze"], passive: "steady", item: "ether",
      personality: { aggression: 0.6, caution: 0.6, creativity: 0.7, loyalty: 0.4 },
      design: { hue: 190, accent: 330, body: "round", size: 0.75, spikes: 1, armor: true, eyes: "visor", pattern: "spots" },
      persona: "Reads habits like a book. Stuns you just before your big move.",
      playbook: "- PROPHECY when they've saved up energy.\n- FEINT talkers.\n- In the endgame, play the safe counter." },
    { id: "kade", name: "CHAMPION KADE", level: 35, train: 1500, moves: ["fight", "negotiate", "inferno", "shield"], passive: "wind", item: "potion",
      rules: [{ when: { kind: "my_hp_below", value: 30 }, do: { item: true } }],
      personality: { aggression: 0.7, caution: 0.6, creativity: 0.6, loyalty: 0.5 },
      design: { hue: 355, accent: 50, body: "wide", size: 0.85, spikes: 3, armor: true, eyes: "angry", pattern: "stripes" },
      persona: "The reigning champion. Calm, ruthless, adapts mid-fight. Respects challengers who think.",
      playbook: "- Open safe, read them for two turns.\n- INFERNO early so the burn has time to work.\n- Endgame: commit to the move they can't answer." },
  ];
  const _rivals = {};
  function rivalFighter(id) {
    const rv = RIVALS.find((x) => x.id === id);
    if (!rv) throw new Error("Unknown rival " + id);
    if (!_rivals[id]) {
      const custom = {};
      for (const m of rv.moves) if (!BASIC[m]) custom[m] = validateSkill({ ...RIVAL_SKILLS[m], id: m }).skill;
      const passive = rv.passive ? validateSkill(RIVAL_PASSIVES[rv.passive]).skill : null;
      const f = upgradeFighter(createFighter({ id: "rival-" + rv.id, name: rv.name, moves: rv.moves, personality: rv.personality, design: rv.design, custom, passive, item: rv.item }));
      f.level = rv.level; f.xp = xpForLevel(rv.level); f.stats = spreadStats(rv.level, 0.4, 0.35);
      f.rules = sanitizeRules(rv.rules || [], f.moves);
      const r = rng(hash("rival:" + rv.id));
      const foes = ["brawler", "talker", "schemer", "turtle", "cycler"];
      for (let i = 0; i < rv.train; i++) fight(f, partnerFighter(foes[i % foes.length], f), { rng: r, learnA: true });
      f.brain = compactBrain(f.brain);
      for (const m of f.moves) f.uses[m] = rv.train * 3;
      f.persona = rv.persona; f.playbook = rv.playbook; f.rival = true;
      _rivals[id] = f;
    }
    return clone(_rivals[id]);
  }

  // =====================================================================================
  // Arena: sharing fighters between players (everything read is untrusted and re-validated)
  // =====================================================================================
  const PUBLIC_FIELDS = ["id", "name", "design", "personality", "moves", "custom", "passive", "item", "rules", "stats", "level", "uses", "brain", "persona", "playbook", "battleRecord"];
  function toPublic(f) {
    const o = {};
    for (const k of PUBLIC_FIELDS) o[k] = clone(f[k] ?? null);
    o.publishedAt = Date.now();
    return o;
  }
  const ONE_OF = (x, list, dflt) => (list.includes(x) ? x : dflt);
  function sanitizePublic(o, owner) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) return null;
    const level = Math.round(num(o.level, 1, MAX_LEVEL, 1));
    // custom skills: re-validated and re-priced here, capped at what this level could forge
    const custom = {};
    if (o.custom && typeof o.custom === "object" && !Array.isArray(o.custom)) {
      for (const [id, s] of Object.entries(o.custom).slice(0, 4)) {
        if (!ID_RE.test(id) || BASIC[id]) continue;
        const v = validateSkill({ ...(s || {}), id }, { level });
        if (v.skill && v.skill.kind === "active" && !v.overBudget) custom[id] = v.skill;
      }
    }
    const rawMoves = Array.isArray(o.moves) ? o.moves.filter((m) => typeof m === "string") : [];
    const probe = { custom };
    let moves = rawMoves.filter((m) => (Object.prototype.hasOwnProperty.call(BASIC, m) || custom[m]) && skillOf(probe, m));
    moves = [...new Set(moves)].slice(0, 4);
    if (moves.length !== 4) {
      if (rawMoves.length < 4 || rawMoves.some((m) => !Object.prototype.hasOwnProperty.call(BASIC, m) && !(m in (o.custom || {})))) return null;
      const spare = SKILL_NAMES.filter((m) => !moves.includes(m));     // replace skills that failed validation
      while (moves.length < 4) moves.push(spare.shift());
    }
    const pers = o.personality && typeof o.personality === "object" ? o.personality : {};
    const personality = Object.fromEntries(TRAITS.map((t) => [t, num(pers[t], 0, 1, 0.5)]));
    const d = o.design && typeof o.design === "object" ? o.design : {};
    const design = {
      hue: Math.round(num(d.hue, 0, 359, 200)), accent: Math.round(num(d.accent, 0, 359, 40)),
      body: ONE_OF(d.body, ["round", "tall", "wide"], "round"), size: num(d.size, 0, 1, 0.6),
      spikes: Math.round(num(d.spikes, 0, 3, 0)), armor: d.armor === true,
      eyes: ONE_OF(d.eyes, ["round", "angry", "visor"], "round"), pattern: ONE_OF(d.pattern, ["plain", "spots", "stripes"], "plain"),
    };
    const usesIn = o.uses && typeof o.uses === "object" ? o.uses : {};
    const uses = Object.fromEntries(moves.map((m) => [m, Math.round(num(usesIn[m], 0, 1e6, 0))]));
    let passive = null;
    if (o.passive) { const v = validateSkill(o.passive, { level }); if (v.skill && v.skill.kind === "passive" && !v.overBudget) passive = v.skill; }
    const st = o.stats && typeof o.stats === "object" ? o.stats : {};
    let stats = { power: Math.round(num(st.power, 0, 49, 0)), vitality: Math.round(num(st.vitality, 0, 49, 0)), speed: Math.round(num(st.speed, 0, 49, 0)) };
    if (stats.power + stats.vitality + stats.speed > statPointsFor(level)) stats = { power: 0, vitality: 0, speed: 0 };
    const rec = o.battleRecord && typeof o.battleRecord === "object" ? o.battleRecord : {};
    const f = {
      id: o.id, owner: typeof owner === "string" ? owner : null, name: cleanName(o.name), design, personality, moves, custom, passive,
      item: ITEMS[o.item] ? o.item : null, rules: sanitizeRules(o.rules, moves), stats, uses, level, xp: xpForLevel(level),
      persona: cleanText(o.persona, PERSONA_MAX, false), playbook: cleanText(o.playbook, PLAYBOOK_MAX, true),
      battleRecord: { w: Math.round(num(rec.w, 0, 1e6, 0)), l: Math.round(num(rec.l, 0, 1e6, 0)), d: Math.round(num(rec.d, 0, 1e6, 0)) },
      publishedAt: num(o.publishedAt, 0, 1e15, 0), record: { w: 0, l: 0, d: 0 }, history: [],
    };
    const b = o.brain;
    if (b && Array.isArray(b.W) && b.W.length === N_CTX && b.W.every((row) => Array.isArray(row) && row.length === N_ACT && row.every(Number.isFinite))
        && Array.isArray(b.b) && b.b.length === N_CTX && b.b.every(Number.isFinite)) {
      f.brain = { W: b.W.map((row) => row.map((v) => num(v, -6, 6, 0))), b: b.b.map((v) => num(v, -50, 50, 0)) };
    } else f.brain = upgradeFighter({ ...f, brain: b }).brain;
    return f;
  }
  function sanitizeResult(x, recorder) {
    if (!x || typeof x !== "object") return null;
    const side = (s) => (s && typeof s === "object" && typeof s.owner === "string" && ID_RE.test(String(s.id || ""))
      ? { owner: s.owner.slice(0, 128), id: s.id, name: cleanName(s.name) } : null);
    const a = side(x.a), b = side(x.b);
    if (!a || !b) return null;
    const winner = x.winner === 0 || x.winner === 1 ? x.winner : null;
    if (recorder && a.owner !== recorder) return null;
    return { at: num(x.at, 0, 1e15, 0), a, b, winner, ko: x.ko === true, ai: x.ai === true };
  }
  function arenaRatings(results) {
    const seen = new Set(), list = [];
    for (const r of results) {
      if (!r) continue;
      const key = `${r.at}|${r.a.owner}/${r.a.id}|${r.b.owner}/${r.b.id}`;
      if (seen.has(key)) continue;
      seen.add(key); list.push(r);
    }
    list.sort((x, y) => x.at - y.at || (`${x.a.owner}/${x.a.id}` < `${y.a.owner}/${y.a.id}` ? -1 : 1));
    const table = {};
    const row = (s) => (table[`${s.owner}/${s.id}`] ||= { owner: s.owner, id: s.id, name: s.name, rating: 1000, w: 0, l: 0, d: 0 });
    for (const r of list) {
      const A = row(r.a), B = row(r.b);
      A.name = r.a.name; B.name = r.b.name;
      const sa = r.winner === null ? 0.5 : r.winner === 0 ? 1 : 0;
      const ea = 1 / (1 + Math.pow(10, (B.rating - A.rating) / 400));
      const delta = Math.round(32 * (sa - ea));
      A.rating += delta; B.rating -= delta;
      if (sa === 1) { A.w++; B.l++; } else if (sa === 0) { A.l++; B.w++; } else { A.d++; B.d++; }
    }
    return table;
  }

  // ---------- helpers ----------
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, Number.isFinite(+x) ? +x : lo)); }
  function round2(x) { return Math.round(x * 100) / 100; }
  function round3(x) { return Math.round(x * 1000) / 1000; }
  function aipvpCommand(f) {
    const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    const traits = TRAITS.map((t) => `--${t} ${f.personality[t].toFixed(2)}`).join(" ");
    const skills = f.moves.map((m) => (BASIC[m] ? m : skillOf(f, m)?.style === "aggro" ? "fight" : { social: "talk", mind: "strategize", guard: "shield" }[skillOf(f, m)?.style] || "fight"));
    return `aipvp agent create --name ${q(f.name)} --skills ${[...new Set(skills)].join(",")} ${traits}`;
  }

  return {
    STYLES, BEATS, STYLE_INFO, STYLE_COLOR, SKILLS, BASIC, SKILL_NAMES, PHASES, TURNS, MAX_LEVEL, TRAITS, PARTNERS, ENERGY,
    EFFECTS, PASSIVE_EFFECTS, ELEMENTS, ITEMS, STARTER_PASSIVES, RULE_CONDITIONS, MAX_RULES, N_ACT, ITEM_SLOT,
    typeMult, rng, hash, newId, xpForLevel, levelForXp, maxHp, masteryBonus, xpForMatch, statPointsFor, unspentPoints, statsOf, setStats,
    priceSkill, validateSkill, fitSkill, describeSkill, describeEffect, maxSkillBudget, maxPassiveBudget, skillOf,
    newBrain, policy, ctxIndex, brainMap, imitate, createFighter, redesign, partnerFighter, availablePartners,
    newBattle, legalMask, isLegal, instinctChoice, instinctOdds, ruleChoice, resolveTurn, finishBattle, phaseOf, actionOf, slotOf,
    sanitizeRules, describeRule,
    fight, train, evaluate, exhibition, newSpar, sparTurn, finishSpar, aipvpCommand, clone,
    PERSONA_MAX, PLAYBOOK_MAX, upgradeFighter, awardBattle, RIVALS, RIVAL_SKILLS, rivalFighter,
    toPublic, sanitizePublic, sanitizeResult, arenaRatings, cleanText, cleanName, compactBrain,
  };
});
