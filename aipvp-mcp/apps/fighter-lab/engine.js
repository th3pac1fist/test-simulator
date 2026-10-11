/* Fighter Lab game engine: rules, the learning brain, training and leveling.
 * Pure logic with no DOM, so it runs in the browser (global `FighterEngine`) and in Node (require). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FighterEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- rules ----------
  const STYLES = ["aggro", "social", "mind", "guard"];
  // Each style beats the next one in the cycle: aggro > social > mind > guard > aggro.
  const BEATS = { aggro: "social", social: "mind", mind: "guard", guard: "aggro" };
  const STYLE_INFO = {
    aggro:  { label: "Aggro",  blurb: "Raw force. Beats Social, loses to Guard." },
    social: { label: "Social", blurb: "Influence. Beats Mind, loses to Aggro." },
    mind:   { label: "Mind",   blurb: "Planning. Beats Guard, loses to Social." },
    guard:  { label: "Guard",  blurb: "Defense and intel. Beats Aggro, loses to Mind." },
  };
  const SKILLS = {
    fight:      { style: "aggro",  power: 3.0, move: "STRIKE",   color: "#c8402a", fx: "burst",   say: "{me} presses the attack on {them}." },
    deceive:    { style: "aggro",  power: 2.6, move: "FEINT",    color: "#7a4bb5", fx: "ghost",   say: "{me} feints, hiding the real plan from {them}." },
    talk:       { style: "social", power: 2.4, move: "PERSUADE", color: "#c2457e", fx: "bubbles", say: "{me} tries to win {them} over." },
    negotiate:  { style: "social", power: 2.6, move: "BARGAIN",  color: "#a87808", fx: "coins",   say: "{me} offers {them} a deal they can't refuse." },
    debate:     { style: "social", power: 2.5, move: "REBUTTAL", color: "#cc5f1a", fx: "bubbles", say: "{me} picks apart {them}'s last argument." },
    strategize: { style: "mind",   power: 2.6, move: "GAMBIT",   color: "#1d8079", fx: "sparkle", say: "{me} sets up a plan three moves deep." },
    code:       { style: "mind",   power: 2.8, move: "COMPILE",  color: "#2c8239", fx: "glyphs",  say: "{me} writes a tool to settle it." },
    search:     { style: "mind",   power: 2.4, move: "LOOKUP",   color: "#2f68ad", fx: "glyphs",  say: "{me} digs up the facts that matter." },
    shield:     { style: "guard",  power: 2.2, move: "BULWARK",  color: "#68788a", fx: "barrier", say: "{me} digs in and defends." },
    observe:    { style: "guard",  power: 2.0, move: "SCAN",     color: "#56677a", fx: "scan",    say: "{me} watches {them} closely." },
    analyze:    { style: "guard",  power: 2.1, move: "DISSECT",  color: "#16849b", fx: "scan",    say: "{me} studies the pattern in {them}'s moves." },
  };
  const SKILL_NAMES = Object.keys(SKILLS);
  const PHASES = [
    { id: "opening", until: 4, mult: 1 },
    { id: "midgame", until: 8, mult: 1.5 },
    { id: "endgame", until: 12, mult: 2 },
  ];
  const TURNS = 12;
  const MAX_LEVEL = 50;
  const TRAITS = ["aggression", "caution", "creativity", "loyalty"];
  const STYLE_TRAIT = { aggro: "aggression", guard: "caution", mind: "creativity", social: "loyalty" };

  function typeMult(attStyle, defStyle) {
    if (BEATS[attStyle] === defStyle) return 2;
    if (BEATS[defStyle] === attStyle) return 0.5;
    return 1;
  }
  function phaseOf(turn) { return PHASES.findIndex((p) => turn <= p.until); }

  // ---------- randomness ----------
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
  function newId(r = Math.random) {
    return "f" + Math.floor(r() * 2 ** 32).toString(36) + Math.floor(r() * 2 ** 32).toString(36);
  }

  // ---------- progression ----------
  // Total XP needed to reach `level` (level 1 = 0).
  function xpForLevel(level) { return Math.round(40 * Math.pow(level - 1, 2)); }
  function levelForXp(xp) {
    let lv = 1;
    while (lv < MAX_LEVEL && xp >= xpForLevel(lv + 1)) lv++;
    return lv;
  }
  function maxHp(level) { return 70 + 3 * (level - 1); }
  function levelBonus(level) { return 1 + 0.02 * (level - 1); }
  // Mastery grows with practice, with diminishing returns, up to +50% damage.
  function masteryBonus(uses) { return 0.5 * (1 - Math.exp(-(uses || 0) / 400)); }
  function xpForMatch(result, myLevel, theirLevel) {
    const base = result === "win" ? 30 : result === "draw" ? 18 : 12;
    return Math.round(base * Math.max(0.5, 1 + 0.08 * (theirLevel - myLevel)));
  }

  // ---------- brain ----------
  // Context = phase (3) x opponent's last style (none + 4) = 15 contexts.
  // Each context holds one preference weight per move; the policy is a softmax over them.
  const N_CTX = 3 * 5;
  const TEMP = 0.7;
  const LEARN_RATE = 0.12;
  function ctxIndex(phase, oppLastStyle) { return phase * 5 + (oppLastStyle ? 1 + STYLES.indexOf(oppLastStyle) : 0); }

  function newBrain(moves, personality) {
    const p = personality || {};
    const W = [];
    for (let c = 0; c < N_CTX; c++) {
      W.push(moves.map((m) => {
        const t = STYLE_TRAIT[SKILLS[m].style];
        return round3(((p[t] ?? 0.5) - 0.5) * 1.6);   // instincts from personality
      }));
    }
    return { W, b: Array(N_CTX).fill(0) };
  }
  function policy(brain, ctx) {
    const w = brain.W[ctx], mx = Math.max(...w);
    const e = w.map((x) => Math.exp((x - mx) / TEMP)), s = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / s);
  }
  function pick(probs, r) {
    let u = r(), i = 0;
    for (; i < probs.length - 1; i++) { u -= probs[i]; if (u <= 0) return i; }
    return i;
  }
  // Gradient-bandit update: push the chosen move up if it did better than usual here, down if worse.
  function learn(brain, ctx, choice, reward) {
    const pi = policy(brain, ctx), adv = reward - brain.b[ctx];
    const w = brain.W[ctx];
    for (let i = 0; i < w.length; i++) {
      w[i] = clamp(w[i] + LEARN_RATE * adv * ((i === choice ? 1 : 0) - pi[i]), -6, 6);
    }
    brain.b[ctx] += 0.05 * (reward - brain.b[ctx]);
  }
  function compactBrain(brain) {
    return { W: brain.W.map((row) => row.map(round3)), b: brain.b.map(round3) };
  }
  // What the brain now prefers against each opponent style, averaged over phases.
  function brainMap(fighter) {
    const rows = [];
    for (const opp of [null, ...STYLES]) {
      const avg = fighter.moves.map(() => 0);
      for (let ph = 0; ph < 3; ph++) policy(fighter.brain, ctxIndex(ph, opp)).forEach((p, i) => (avg[i] += p / 3));
      const best = avg.indexOf(Math.max(...avg));
      rows.push({ vs: opp, probs: avg.map(round3), best: fighter.moves[best], confidence: round3(avg[best]) });
    }
    return rows;
  }

  // ---------- fighters ----------
  const DEFAULT_DESIGN = { hue: 200, accent: 40, body: "round", size: 0.6, spikes: 1, armor: false, eyes: "round", pattern: "plain" };

  function createFighter({ name, moves, personality, design, id } = {}, r = Math.random) {
    moves = (moves || ["fight", "talk", "strategize", "shield"]).filter((m) => SKILLS[m]).slice(0, 4);
    if (moves.length !== 4 || new Set(moves).size !== 4) throw new Error("A fighter needs exactly 4 different moves.");
    personality = Object.fromEntries(TRAITS.map((t) => [t, clamp(personality?.[t] ?? 0.5, 0, 1)]));
    return {
      id: id || newId(r),
      name: String(name || "ROOKIE").slice(0, 16),
      design: { ...DEFAULT_DESIGN, ...(design || {}) },
      personality,
      moves,
      level: 1,
      xp: 0,
      record: { w: 0, l: 0, d: 0 },
      uses: Object.fromEntries(moves.map((m) => [m, 0])),
      brain: newBrain(moves, personality),
      history: [],
      sessions: 0,
      createdAt: Date.now(),
      version: 1,
    };
  }
  // Changing moves or personality after training keeps what still applies.
  function redesign(f, { name, moves, personality, design }) {
    const g = clone(f);
    if (name) g.name = String(name).slice(0, 16);
    if (design) g.design = { ...g.design, ...design };
    if (personality) g.personality = Object.fromEntries(TRAITS.map((t) => [t, clamp(personality[t] ?? g.personality[t], 0, 1)]));
    if (moves && moves.join() !== f.moves.join()) {
      if (moves.length !== 4 || new Set(moves).size !== 4 || !moves.every((m) => SKILLS[m])) throw new Error("A fighter needs exactly 4 different moves.");
      const fresh = newBrain(moves, g.personality);
      // a move kept from before keeps its learned weights
      moves.forEach((m, i) => {
        const old = f.moves.indexOf(m);
        if (old >= 0) for (let c = 0; c < N_CTX; c++) fresh.W[c][i] = f.brain.W[c][old];
      });
      g.brain = fresh;
      g.moves = moves.slice();
      g.uses = Object.fromEntries(moves.map((m) => [m, f.uses[m] || 0]));
    }
    return g;
  }

  // ---------- gym partners ----------
  function styleBot(id, name, style, moves, look) {
    return { id, name, kind: "dummy", style, moves, level: 1, unlock: 1, design: look,
             blurb: `Mostly uses ${STYLE_INFO[style].label} moves.` };
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
      personality: { aggression: 0.6, caution: 0.6, creativity: 0.7, loyalty: 0.4 },
      blurb: "A fully trained brain. Reads your habits." },
    { id: "kade", name: "CHAMPION KADE", kind: "trained", moves: ["fight", "negotiate", "strategize", "shield"], level: 26, unlock: 20, train: 1500,
      design: { hue: 355, accent: 50, body: "wide", size: 0.85, spikes: 3, armor: true, eyes: "angry", pattern: "stripes" },
      personality: { aggression: 0.7, caution: 0.6, creativity: 0.6, loyalty: 0.5 },
      blurb: "The strongest fighter in the gym." },
  ];
  const _trained = {};
  // Build a partner as a fighter-shaped object the battle runner understands.
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
        const f = createFighter({ id: p.id, name: p.name, moves: p.moves, personality: p.personality, design: p.design });
        f.level = p.level; f.xp = xpForLevel(p.level);
        const r = rng(hash(p.id));
        const foes = ["brawler", "talker", "schemer", "turtle", "cycler"];
        for (let i = 0; i < p.train; i++) fight(f, partnerFighter(foes[i % foes.length], f), { rng: r, learnA: true, record: false });
        for (const m of f.moves) f.uses[m] = p.train;
        _trained[p.id] = f;
      }
      return Object.assign(clone(_trained[p.id]), { partner: p });
    }
    // Practice partners match your level, so beating them takes strategy, not stats.
    // Coaches have a fixed level and the practice that goes with it.
    const level = p.unlock > 1 ? p.level : Math.max(p.level, you?.level || 1);
    return { id: p.id, name: p.name, moves: p.moves, design: p.design, level, partner: p,
             uses: Object.fromEntries(p.moves.map((m) => [m, 150 * level])),  // practice that keeps pace with yours
             personality: { aggression: 0.5, caution: 0.5, creativity: 0.5, loyalty: 0.5 } };
  }
  function availablePartners(level) { return PARTNERS.map((p) => ({ ...p, locked: level < p.unlock })); }

  // A scripted partner's move this turn.
  function scriptedChoice(f, state, r) {
    const p = f.partner, moves = f.moves;
    const ofStyle = (style) => moves.filter((m) => SKILLS[m].style === style);
    const any = () => moves[Math.floor(r() * moves.length)];
    const fromStyle = (style) => { const c = ofStyle(style); return c.length ? c[Math.floor(r() * c.length)] : any(); };
    if (p.kind === "dummy") return r() < 0.75 ? fromStyle(p.style) : any();
    if (p.kind === "cycler") return r() < 0.85 ? fromStyle(STYLES[(state.turn - 1) % 4]) : any();
    if (p.kind === "adaptive") {
      const counts = state.oppStyleCounts;
      const top = STYLES.reduce((a, b) => (counts[b] > counts[a] ? b : a), STYLES[0]);
      const counter = STYLES.find((s) => BEATS[s] === top);
      return state.turn > 1 && r() < 0.8 ? fromStyle(counter) : any();
    }
    return any();
  }

  // ---------- battle ----------
  /** Run one match. Mutates the fighters only when learning or recording is on.
   *  opts: { rng, learnA, learnB, record (default true), log (default false) } */
  function fight(A, B, opts = {}) {
    const r = opts.rng || Math.random;
    const record = opts.record !== false;
    const side = [A, B].map((f) => ({
      f, hp: maxHp(f.level || 1), max: maxHp(f.level || 1), last: null, styleCounts: { aggro: 0, social: 0, mind: 0, guard: 0 },
      scripted: !f.brain, learn: false,
    }));
    side[0].learn = !!opts.learnA && !side[0].scripted;
    side[1].learn = !!opts.learnB && !side[1].scripted;
    const turns = [];
    let turn = 1;
    for (; turn <= TURNS; turn++) {
      const ph = phaseOf(turn), mult = PHASES[ph].mult;
      const picks = side.map((s, i) => {
        const o = side[1 - i];
        if (s.scripted) return { skill: scriptedChoice(s.f, { turn, oppStyleCounts: o.styleCounts }, r) };
        const ctx = ctxIndex(ph, o.last);
        const idx = pick(policy(s.f.brain, ctx), r);
        return { skill: s.f.moves[idx], idx, ctx };
      });
      const dmg = picks.map((p, i) => {
        const me = side[i], them = side[1 - i], sk = SKILLS[p.skill], theirs = SKILLS[picks[1 - i].skill];
        const tm = typeMult(sk.style, theirs.style);
        const d = sk.power * mult * tm * (1 + masteryBonus(me.f.uses?.[p.skill])) * levelBonus(me.f.level || 1) * (0.9 + 0.2 * r());
        return { d: round2(d), tm, them };
      });
      side.forEach((s, i) => { s.hp = Math.max(0, round2(s.hp - dmg[1 - i].d)); });
      const actions = picks.map((p, i) => ({
        agent_id: side[i].f.id, agent_name: side[i].f.name, skill: p.skill, points: dmg[i].d,
        effect: dmg[i].tm > 1 ? "super" : dmg[i].tm < 1 ? "resisted" : "neutral",
        content: SKILLS[p.skill].say.replace("{me}", side[i].f.name).replace("{them}", side[1 - i].f.name),
      }));
      // learn from this turn: damage dealt minus damage taken, scaled to the phase
      side.forEach((s, i) => {
        if (s.learn) learn(s.f.brain, picks[i].ctx, picks[i].idx, (dmg[i].d - dmg[1 - i].d) / (3 * mult));
        if (s.learn) s.f.uses[picks[i].skill] = (s.f.uses[picks[i].skill] || 0) + 1;  // mastery grows only in training
      });
      side.forEach((s, i) => { s.last = SKILLS[picks[i].skill].style; s.styleCounts[s.last]++; });
      turns.push({ turn, phase: PHASES[ph].id, multiplier: mult, actions, hp: side.map((s) => s.hp), max: side.map((s) => s.max) });
      if (side.some((s) => s.hp <= 0)) break;
    }
    const frac = side.map((s) => s.hp / s.max);
    const winner = Math.abs(frac[0] - frac[1]) < 1e-9 ? null : frac[0] > frac[1] ? 0 : 1;
    const ko = side.some((s) => s.hp <= 0);
    return {
      winner, ko, turns,
      result: winner === null ? "draw" : winner === 0 ? "win" : "loss",
      agents: side.map((s, i) => ({ id: s.f.id, name: s.f.name, hp: s.hp, max: s.max, level: s.f.level || 1,
                                     score: round2(turns.reduce((a, t) => a + t.actions[i].points, 0)) })),
    };
  }

  // ---------- training ----------
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
    const entry = { at: Date.now(), partner: partnerId, reps, win: res.win, loss: res.loss, draw: res.draw, level: f.level };
    f.history = [...(f.history || []), entry].slice(-60);
    return {
      fighter: f,
      report: {
        partner: partnerId, reps, ...res,
        winRate: reps ? round3((res.win + res.draw / 2) / reps) : 0,
        xpGained: f.xp - before.xp, levelBefore: before.level, levelAfter: f.level,
        mastery: f.moves.map((m) => ({ move: m, before: round3(before.mastery[m]), after: round3(masteryBonus(f.uses[m])) })),
        curve, lastMatch: last,
      },
    };
  }
  /** Win rate over `n` matches without learning: a fair measure of current strength. */
  function evaluate(fighter, partnerId, n = 200, seed = 1) {
    const r = rng(seed);
    let score = 0;
    for (let i = 0; i < n; i++) {
      const res = fight(fighter, partnerFighter(partnerId, fighter), { rng: r, record: false });
      score += res.result === "win" ? 1 : res.result === "draw" ? 0.5 : 0;
    }
    return round3(score / n);
  }
  /** One full exhibition match for watching. Does not change either fighter. */
  function exhibition(fighter, partnerId, seed) {
    const r = seed == null ? Math.random : rng(seed);
    const foe = partnerFighter(partnerId, fighter);
    return { foe, match: fight(clone(fighter), foe, { rng: r, record: false }) };
  }

  // ---------- helpers ----------
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, Number.isFinite(+x) ? +x : lo)); }
  function round2(x) { return Math.round(x * 100) / 100; }
  function round3(x) { return Math.round(x * 1000) / 1000; }

  /** CLI command that registers this design on aipvp (training stays in the gym). */
  function aipvpCommand(f) {
    const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    const traits = TRAITS.map((t) => `--${t} ${f.personality[t].toFixed(2)}`).join(" ");
    return `aipvp agent create --name ${q(f.name)} --skills ${f.moves.join(",")} ${traits}`;
  }

  return {
    STYLES, BEATS, STYLE_INFO, SKILLS, SKILL_NAMES, PHASES, TURNS, MAX_LEVEL, TRAITS, PARTNERS,
    typeMult, rng, hash, newId, xpForLevel, levelForXp, maxHp, masteryBonus, xpForMatch,
    newBrain, policy, ctxIndex, brainMap, createFighter, redesign, partnerFighter, availablePartners,
    fight, train, evaluate, exhibition, aipvpCommand, clone,
  };
});
