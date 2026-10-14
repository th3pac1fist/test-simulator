/* Fighter Lab AI agents (rules v3): Claude picks each fighter's action, drafts skill files, writes
 * scouting reports, and a Claude coach rewrites the playbook. No page code: the caller passes in a
 * `sample` function (the claude.ai capability in the browser, a fake in tests). Global `FighterAgent`. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./engine.js"));
  else root.FighterAgent = factory(root.FighterEngine);
})(typeof self !== "undefined" ? self : this, function (E) {
  "use strict";

  const STYLE_LABEL = (s) => (s ? E.STYLE_INFO[s].label : "no style");
  // Codes that mean Claude won't be available for the rest of this battle (or this page load).
  const STOP_CODES = new Set(["not_granted", "sampling_disabled", "not_declared", "capability_disabled",
    "capability_removed", "session_expired", "rate_limited"]);
  const REASON_TEXT = {
    not_granted: "Claude isn't allowed on this page, so fighters use their instincts.",
    sampling_disabled: "Claude isn't available on this account, so fighters use their instincts.",
    rate_limited: "Claude is busy (rate limited), so fighters use their instincts for the rest of this battle.",
    session_expired: "Your Claude session expired. Sign in again to use AI battles.",
    unavailable: "Claude isn't available here, so fighters use their instincts.",
  };
  /** Model settings: quick for normal battles; Overclock uses the bigger model with low effort to stay playable. */
  const TIERS = { quick: { modelTier: "quick" }, overclock: { modelTier: "default", effort: "low" } };

  class Cancelled extends Error { constructor() { super("Battle cancelled"); this.name = "Cancelled"; } }

  const RULES = [
    "RULES",
    "- Both fighters choose at the same time. You cannot see the opponent's choice for this turn.",
    "- Styles: Aggro beats Social, Social beats Mind, Mind beats Guard, Guard beats Aggro. A skill does double damage against the style it beats and half against the style that beats it.",
    "- Energy: start with 3, gain 2 each turn, hold at most 10. Each skill costs energy. Some skills have a cooldown before they can be used again.",
    "- Order: items act first, then skills that shield or stun, then the faster fighter. A stun that lands before the target acts cancels its action; a stunned fighter can't be stunned again for 2 turns.",
    "- Burn and poison deal damage at the end of each turn. Shields absorb damage. Weaken lowers the target's damage. Focus multiplies your next hit.",
    "- Stats: Power adds damage, Vitality adds max HP, Speed gives a chance to dodge an attack completely (its damage and effects). A Potion heals 15% of max HP. Shields, heals, burn and poison grow with level, like damage.",
    "- Damage is multiplied by the phase: turns 1-4 x1, 5-8 x1.5, 9-12 x2. Healing and burn/poison are not.",
    "- At 0 HP a fighter is knocked out. After 12 turns the fighter with the higher share of HP left wins.",
    "- Clauses: a fighter heals at most half its max HP per battle in total, and one action can't deal more than 40% of the target's max HP.",
    "- A weapon is always on: it can boost one style's damage, add burn or poison to that style's hits, land critical hits, heal on hits, block part of the first hit each turn, or dodge.",
  ].join("\n");

  function quoteBlock(text) {
    const t = String(text || "").trim();
    return t ? t.split("\n").map((l) => "| " + l).join("\n") : "| (none)";
  }
  function statusLine(s) {
    const parts = [];
    if (s.shield) parts.push(`shield ${Math.round(s.shield.amount)}`);
    if (s.burn) parts.push(`burned (${s.burn.damage}/turn, ${s.burn.turns} left)`);
    if (s.poison) parts.push(`poisoned x${s.poison.stacks}`);
    if (s.weaken) parts.push(`weakened -${Math.round(s.weaken.pct * 100)}%`);
    if (s.focus > 1) parts.push(`focused x${s.focus}`);
    if (s.stunned) parts.push("STUNNED (will lose next action)");
    if (s.regen.length) parts.push("regenerating");
    return parts.length ? parts.join(", ") : "no effects";
  }
  /** How the opponent's action reads to your fighter: game wording only, never their custom names. */
  function opponentActionName(f, a, idx) {
    if (a.kind === "item") return `an item (${E.ITEMS[f.item]?.name || "item"})`;
    if (a.kind === "rest") return "rest";
    return E.BASIC[a.skill] ? E.BASIC[a.skill].name : `their skill ${"ABCD"[idx] || "?"}`;
  }

  /** The prompt for side i's action this turn. The opponent appears only as game data: never their
   *  persona, playbook, battle lines or custom skill names (those are their owner's text). */
  function turnPrompt(state, i, extra = {}) {
    const me = state.side[i], them = state.side[1 - i];
    const f = me.f, o = them.f;
    const phase = E.PHASES[E.phaseOf(state.turn)];
    const mask = E.legalMask(state, i);
    const mine = f.moves.map((m, k) => {
      const sk = E.skillOf(f, m);
      const why = !mask[k] ? (me.cooldowns[m] > 0 ? ` [ON COOLDOWN ${me.cooldowns[m] - 1 > 0 ? me.cooldowns[m] - 1 + " more turn(s)" : "this turn"}]` : " [NOT ENOUGH ENERGY]") : "";
      return `- ${m}: ${sk.name}. ${E.describeSkill(sk)} Mastery +${Math.round(E.masteryBonus(f.uses?.[m]) * 100)}%.${why}`;
    });
    if (f.item) mine.push(`- item: ${E.ITEMS[f.item].name}. ${E.ITEMS[f.item].blurb}${me.itemLeft ? "" : " [ALREADY USED]"}`);
    const theirs = o.moves.map((m, k) => {
      const sk = E.skillOf(o, m);
      const label = E.BASIC[m] ? sk.name : `Skill ${"ABCD"[k]}`;
      return `- ${label}: ${E.describeSkill(sk)}${them.cooldowns[m] > 0 ? " [on cooldown]" : ""}`;
    });
    const odds = E.instinctOdds(state, i);
    const instincts = odds && odds.length ? odds.slice().sort((a, b) => b.p - a.p).map((x) => `${x.action === "item" ? "item" : E.skillOf(f, x.action).name} ${Math.round(x.p * 100)}%`).join(", ") : "none";
    const history = state.turns.length
      ? state.turns.slice(-8).map((t) => {
          const a = t.actions[i], b = t.actions[1 - i];
          const bIdx = b.kind === "skill" ? o.moves.indexOf(b.skill) : -1;
          const mineName = a.kind === "skill" ? E.skillOf(f, a.skill)?.name || a.name : a.name;
          const extras = [a.stunned && "you were stunned", b.stunned && "they were stunned", a.applied.length && `you applied ${a.applied.join("/")}`, b.applied.length && `they applied ${b.applied.join("/")}`].filter(Boolean).join("; ");
          return `T${t.turn}: you ${mineName} (${STYLE_LABEL(a.style)}) vs them ${opponentActionName(o, b, bIdx)} (${STYLE_LABEL(b.style)}). You dealt ${a.points}, took ${b.points}.${extras ? " " + extras + "." : ""}`;
        }).join("\n")
      : "(first turn)";
    const passive = (s, label) => (s.f.passive ? `${label} passive: ${E.describeSkill(s.f.passive).replace(/^Passive: /, "")}` : `${label} passive: none`)
      + (s.f.weapon ? `. ${label} weapon: ${E.describeSkill(s.f.weapon).replace(/^Weapon: /, "").replace(/\.$/, "")}` : "");
    return [
      `You are the battle brain of ${f.name}, a fighter in Fighter Lab, a turn-based game. Choose ${f.name}'s action for this turn.`,
      "",
      RULES,
      "",
      "YOUR ACTIONS (answer with one of these ids; those marked unavailable can't be chosen)",
      ...mine,
      passive(me, "Your"),
      "",
      `OPPONENT: ${E.cleanName(o.name)}, level ${o.level || 1}. Their skills:`,
      ...theirs,
      `${passive(them, "Their")}. Item: ${o.item ? (them.itemLeft ? "one item not yet used" : "used") : "none"}.`,
      "",
      "YOUR TRAINER'S INSTRUCTIONS:",
      quoteBlock(E.cleanText(f.persona, E.PERSONA_MAX, false)),
      "",
      "YOUR PLAYBOOK (lessons from training):",
      quoteBlock(E.cleanText(f.playbook, E.PLAYBOOK_MAX, true)),
      ...(extra.scouting ? ["", "YOUR SCOUTING REPORT FOR THIS OPPONENT:", quoteBlock(E.cleanText(extra.scouting, 800, true))] : []),
      "",
      `YOUR INSTINCTS here, from practice: ${instincts}.`,
      "",
      "BATTLE SO FAR (most recent last)",
      history,
      "",
      `NOW: turn ${state.turn} of ${E.TURNS}, ${phase.id.toUpperCase()} (x${phase.mult}).`,
      `You: HP ${Math.ceil(me.hp)}/${me.max}, energy ${me.energy}/${E.ENERGY.max}, ${statusLine(me)}.`,
      `Them: HP ${Math.ceil(them.hp)}/${them.max}, energy ${them.energy}/${E.ENERGY.max}, ${statusLine(them)}.`,
      "",
      "Think about what they are likely to pick, your energy for the next turns, and your plan. Stick to a plan instead of switching on every hit.",
      'Reply with only JSON: {"action": "<one of your available action ids>", "line": "<a short in-character battle cry, at most 12 words>"}',
    ].join("\n");
  }

  /** Read Claude's reply: the action id (or skill name, or "item"). Returns {action, line} or null. */
  function parseTurn(reply, f) {
    let obj = reply;
    if (typeof reply === "string") { try { obj = JSON.parse(reply); } catch { return null; } }
    if (!obj || typeof obj !== "object") return null;
    const raw = String(obj.action ?? obj.move ?? "").trim().toLowerCase();
    let action = null;
    if (raw === "item" || (f.item && raw === E.ITEMS[f.item].name.toLowerCase())) action = { kind: "item" };
    else {
      const skill = f.moves.find((m) => m.toLowerCase() === raw || (E.skillOf(f, m)?.name || "").toLowerCase() === raw);
      if (skill) action = { kind: "skill", skill };
    }
    if (!action) return null;
    let line = typeof obj.line === "string" ? obj.line : "";
    line = line.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "");
    if (line.length > 90) line = line.slice(0, 87).trimEnd() + "…";
    return { action, line };
  }

  /**
   * Run one battle with Claude choosing for the sides in `ai` (default both). Battle rules fire first and
   * need no request. opts: { a, b, sample, signal, rng, ai: [bool, bool], tiers: [tierKey, tierKey],
   * scouting: [text|null, text|null], learnA, onTurn(turn), onThinking(sides), pace() }
   */
  async function runAiBattle(opts) {
    const r = opts.rng || Math.random;
    const st = E.newBattle(E.clone(opts.a), E.clone(opts.b), { learnA: !!opts.learnA });
    const ai = (opts.ai || [true, true]).map((x) => !!x && !!opts.sample && typeof opts.sample.json === "function");
    const tiers = (opts.tiers || ["quick", "quick"]).map((t) => TIERS[t] || TIERS.quick);
    const scouting = opts.scouting || [null, null];
    const stats = { ai: 0, instinct: 0, rule: 0, reasons: {} };
    let stoppedReason = null;
    const signal = opts.signal;
    const check = () => { if (signal && signal.aborted) throw new Cancelled(); };

    async function decide(i) {
      const fallback = (reason) => {
        stats.instinct++;
        if (reason) stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
        const c = E.instinctChoice(st, i, r);
        return { ...c, source: c.source === "rule" ? "rule" : "instinct" };
      };
      const ruled = E.ruleChoice(st, i);
      if (ruled) { stats.rule++; return ruled; }
      if (!E.legalMask(st, i).some(Boolean)) return { kind: "rest", source: "instinct" };
      if (!ai[i]) return fallback(null);
      let reply;
      try {
        reply = await opts.sample.json(turnPrompt(st, i, { scouting: scouting[i] }), { ...tiers[i], cache: false, signal });
      } catch (e) {
        if ((e && e.code === "cancelled") || (signal && signal.aborted)) throw new Cancelled();
        const code = (e && typeof e.code === "string") ? e.code : "upstream_error";
        if (STOP_CODES.has(code)) { ai[0] = ai[1] = false; stoppedReason = stoppedReason || code; }
        check();
        return fallback(code);
      }
      check();
      const p = parseTurn(reply, st.side[i].f);
      if (!p) return fallback("invalid_reply");
      if (!E.isLegal(st, i, p.action)) return fallback("illegal_action");   // e.g. not enough energy, on cooldown
      stats.ai++;
      return { ...p.action, line: p.line, source: "ai" };
    }

    while (!st.over) {
      check();
      if (opts.pace) await opts.pace();
      check();
      if (opts.onThinking) opts.onThinking([ai[0], ai[1]]);
      // Both decisions start from the same completed state, so neither sees the other's pick.
      const picks = await Promise.all([decide(0), decide(1)]);
      check();
      const rec = E.resolveTurn(st, picks, r);
      if (opts.onTurn) opts.onTurn(rec);
    }
    return { match: E.finishBattle(st), stats, stoppedReason, fighterA: st.side[0].f };
  }

  // ---------- skill drafts (describe a skill in words) ----------
  const KIND_WORDS = { active: "a battle skill", passive: "a passive ability", weapon: "a weapon" };
  /** Only effect families the player has unlocked are offered (all of them if `unlocked` is omitted). */
  function draftPrompt(description, kind, level, unlocked) {
    const table = kind === "passive" ? E.PASSIVE_EFFECTS : kind === "weapon" ? E.WEAPON_EFFECTS : E.EFFECTS;
    const allowed = (type, def) => !unlocked || (type === "rider"
      ? def.params.status.some((st) => unlocked.has(`weapon:rider:${st}`)) : unlocked.has(`${kind}:${type}`));
    const effects = Object.entries(table).filter(([type, def]) => allowed(type, def)).map(([type, def]) => {
      const params = Object.entries(def.params).map(([k, spec]) => (typeof spec[0] === "string" ? `${k}: one of ${spec.join("/")}` : `${k}: ${spec[0]}-${spec[1]}`)).join(", ");
      return `- ${type}${params ? ` (${params})` : ""}: ${def.label}`;
    }).join("\n");
    return [
      `You design ${KIND_WORDS[kind] || KIND_WORDS.active} for Fighter Lab, a turn-based game, from a player's description.`,
      "",
      RULES,
      "",
      `Use only these ${kind === "active" ? "" : kind + " "}effects (the ones this player has unlocked), with numbers inside these ranges (at most 3 effects, each type once):`,
      effects,
      `Styles: aggro, social, mind, guard. Elements (flavor only): ${E.ELEMENTS.join(", ")}.`,
      `The fighter is level ${level}. The game prices the skill itself and scales it down if it's too strong, so pick effects that capture the idea rather than maxing numbers.`,
      "",
      "PLAYER'S DESCRIPTION:",
      quoteBlock(E.cleanText(description, 400, false)),
      "",
      `Reply with only JSON: {"name": "<1-3 words>", "kind": "${kind}", "style": "<style>", "element": "<element>", "effects": [{"type": "...", ...}], "why": "<one sentence on how it matches the description>"}`,
    ].join("\n");
  }
  /** Claude drafts a skill; the game validates, scales to the level, and prices it. */
  async function draftSkill(sample, description, kind, level, signal, unlocked) {
    const reply = await sample.json(draftPrompt(description, kind, level, unlocked), { modelTier: "quick", cache: false, ...(signal ? { signal } : {}) });
    if (!reply || typeof reply !== "object") throw { code: "invalid_reply", message: "Claude's draft couldn't be read." };
    // a draft can't sneak in locked effects: they're dropped before the game prices it
    let raw = { ...reply, kind };
    if (unlocked && Array.isArray(raw.effects)) raw = { ...raw, effects: raw.effects.filter((e) => e && typeof e.type === "string" && unlocked.has(E.familyOf(kind, e))) };
    const v = E.fitSkill(raw, level);
    if (!v.skill) throw { code: "invalid_reply", message: v.errors.join(" ") || "The draft didn't use any valid effects." };
    return { ...v, why: E.cleanText(typeof reply.why === "string" ? reply.why : "", 200, false) };
  }

  // ---------- scouting (one request before a battle) ----------
  function scoutPrompt(me, foe) {
    const kit = (f, hide) => f.moves.map((m, k) => `- ${hide && !E.BASIC[m] ? `Skill ${"ABCD"[k]}` : E.skillOf(f, m).name}: ${E.describeSkill(E.skillOf(f, m))}`).join("\n");
    const extras = (f) => [f.passive ? `Passive: ${E.describeSkill(f.passive).replace(/^Passive: /, "")}` : "No passive",
      f.weapon ? `Weapon: ${E.describeSkill(f.weapon).replace(/^Weapon: /, "")}` : "No weapon", f.item ? `Item: ${E.ITEMS[f.item].name} (${E.ITEMS[f.item].blurb})` : "No item"].join(". ");
    return [
      `You scout an opponent for ${me.name}, a fighter in Fighter Lab. Write a short battle plan ${me.name} will follow.`,
      "", RULES, "",
      `${me.name} (level ${me.level}):`, kit(me, false), extras(me), "",
      `OPPONENT (level ${foe.level || 1}):`, kit(foe, true), extras(foe), "",
      'Reply with only JSON: {"plan": "- step\\n- step (3 to 5 short steps naming skills, energy timing and when to use the item)"}',
    ].join("\n");
  }
  async function scout(sample, me, foe, signal) {
    const reply = await sample.json(scoutPrompt(me, foe), { modelTier: "quick", cache: false, ...(signal ? { signal } : {}) });
    const plan = reply && typeof reply.plan === "string" ? E.cleanText(reply.plan, 800, true).trim() : "";
    if (!plan) throw { code: "invalid_reply", message: "The scouting report couldn't be read." };
    return plan;
  }

  // ---------- coach ----------
  function battleSummary(match, side, f) {
    const lines = match.turns.map((t) => {
      const mine = t.actions[side], theirs = t.actions[1 - side];
      const theirName = theirs.kind === "skill" && !E.BASIC[theirs.skill] ? `a ${STYLE_LABEL(theirs.style)} skill` : theirs.name;
      return `T${t.turn}: ${mine.name} (${STYLE_LABEL(mine.style)}) vs ${theirName}. Dealt ${mine.points}, took ${theirs.points}.${mine.stunned ? " You were stunned." : ""}`;
    });
    const res = match.winner === null ? "a draw" : match.winner === side ? "a win" : "a loss";
    return `Battle against ${E.cleanName(match.agents[1 - side].name)} (level ${match.agents[1 - side].level}), ending in ${res}${match.ko ? " by knockout" : ""}.\n${lines.join("\n")}`;
  }
  function gymSummary(report) {
    const p = E.PARTNERS.find((x) => x.id === report.partner);
    return `Gym practice: ${report.reps} rounds against ${p ? p.name : report.partner} (${p ? p.blurb : ""}). ${report.win} wins, ${report.loss} losses, ${report.draw} draws.`;
  }
  function coachPrompt(f, whatHappened) {
    const map = E.brainMap(f).map((row) =>
      `${row.vs ? "After their " + STYLE_LABEL(row.vs) + " move" : "First move"}: ${E.skillOf(f, row.best)?.name} (${Math.round(row.confidence * 100)}%)`).join("\n");
    const kit = f.moves.map((m) => `- ${E.skillOf(f, m).name}: ${E.describeSkill(E.skillOf(f, m))}`).join("\n");
    return [
      `You coach ${f.name}, a fighter in Fighter Lab, a turn-based game. Rewrite ${f.name}'s playbook: the short list of lessons its battle brain reads before every move.`,
      "", RULES, "",
      `FIGHTER: level ${f.level}. Skills:`, kit,
      f.passive ? `Passive: ${E.describeSkill(f.passive).replace(/^Passive: /, "")}` : "No passive.",
      f.weapon ? `Weapon: ${E.describeSkill(f.weapon).replace(/^Weapon: /, "")}` : "No weapon.",
      f.item ? `Item: ${E.ITEMS[f.item].name} (${E.ITEMS[f.item].blurb})` : "No item.",
      (f.rules || []).length ? `Battle rules it always follows:\n${f.rules.map((rl) => "- " + E.describeRule(rl, f)).join("\n")}` : "",
      "Trainer's instructions:", quoteBlock(E.cleanText(f.persona, E.PERSONA_MAX, false)), "",
      "CURRENT PLAYBOOK:", quoteBlock(E.cleanText(f.playbook, E.PLAYBOOK_MAX, true)), "",
      "INSTINCTS LEARNED IN PRACTICE:", map, "",
      "WHAT JUST HAPPENED:", whatHappened, "",
      "Write at most 8 lessons, one per line, each starting with \"- \". Make each concrete: name skills, styles, energy timing and when to use the item.",
      "Keep lessons that still hold and drop ones the evidence contradicts. Stay under 700 characters.",
      'Reply with only JSON: {"playbook": "- lesson\\n- lesson", "comment": "<one encouraging sentence to the trainer about what changed>"}',
    ].filter((x) => x !== "").join("\n");
  }
  function parseCoach(reply) {
    let obj = reply;
    if (typeof reply === "string") { try { obj = JSON.parse(reply); } catch { return null; } }
    if (!obj || typeof obj !== "object" || typeof obj.playbook !== "string") return null;
    const lines = obj.playbook.split(/\r?\n/).map((l) => E.cleanText(l, 200, false).trim()).filter(Boolean)
      .map((l) => (l.startsWith("- ") ? l : "- " + l.replace(/^[-*•\d.)\s]+/, ""))).slice(0, 8);
    if (!lines.length) return null;
    return { playbook: lines.join("\n").slice(0, E.PLAYBOOK_MAX), comment: E.cleanText(typeof obj.comment === "string" ? obj.comment : "", 200, false).trim() };
  }
  async function coach(sample, f, whatHappened, signal) {
    const reply = await sample.json(coachPrompt(f, whatHappened), { modelTier: "default", cache: false, ...(signal ? { signal } : {}) });
    const out = parseCoach(reply);
    if (!out) throw { code: "invalid_reply", message: "The coach's answer couldn't be read." };
    return out;
  }

  // ---------- Pro build: Claude writes the mind for an optimized build ----------
  /** `f` is the fighter as the build will make it; `report` is the optimizer's result. Only game data goes in:
   *  arena opponents appear by number, never by their names or their owners' text. */
  function proMindPrompt(f, report) {
    const kit = f.moves.map((m) => `- ${E.skillOf(f, m).name}: ${E.describeSkill(E.skillOf(f, m))}`).join("\n");
    const pct = (x) => `${Math.round(x * 100)}%`;
    const s = report.score;
    const results = [
      ...s.rivals.map((x) => `- vs rival ${x.label}: wins ${pct(x.rate)}`),
      ...s.partners.map((x) => `- vs gym partner ${x.label}: wins ${pct(x.rate)}`),
      ...s.arena.map((x, i) => `- vs arena fighter #${i + 1}: wins ${pct(x.rate)}`),
      `- vs a field of other players' likely builds: wins ${pct(s.field)}`,
    ].join("\n");
    return [
      `You write the mind of ${f.name}, a fighter in Fighter Lab, a turn-based game. A build optimizer just designed its loadout by simulating thousands of battles. In real battles you (Claude) choose each action, guided by a persona and a playbook. Write both so they make the most of this build.`,
      "", RULES, "",
      `FIGHTER: level ${f.level}. Stats: ${f.stats.power} Power, ${f.stats.vitality} Vitality, ${f.stats.speed} Speed. Skills:`, kit,
      f.passive ? `Passive: ${E.describeSkill(f.passive).replace(/^Passive: /, "")}` : "No passive.",
      f.weapon ? `Weapon: ${E.describeSkill(f.weapon).replace(/^Weapon: /, "")}` : "No weapon.",
      f.item ? `Item: ${E.ITEMS[f.item].name} (${E.ITEMS[f.item].blurb})` : "No item.",
      (f.rules || []).length ? `Battle rules it always follows (no need to repeat them):\n${f.rules.map((rl) => "- " + E.describeRule(rl, f)).join("\n")}` : "",
      "", "WHY THE OPTIMIZER CHOSE THIS BUILD:", report.reasons.map((r) => "- " + r).join("\n"),
      "", "SIMULATED RESULTS:", results, "",
      `Persona: 1-2 sentences in the fighter's voice about its overall plan, under ${E.PERSONA_MAX} characters.`,
      "Playbook: at most 8 lessons, one per line, each starting with \"- \". Name skills, energy timing, which style to answer with, and how to handle the hardest matchup. Under 700 characters.",
      'Reply with only JSON: {"persona": "...", "playbook": "- lesson\\n- lesson", "comment": "<one sentence to the trainer on how to play this build>"}',
    ].filter((x) => x !== "").join("\n");
  }
  function parseMind(reply) {
    const coachPart = parseCoach(reply);
    if (!coachPart) return null;
    let obj = reply;
    if (typeof reply === "string") { try { obj = JSON.parse(reply); } catch { return null; } }
    const persona = E.cleanText(typeof obj.persona === "string" ? obj.persona : "", E.PERSONA_MAX, false).trim();
    if (!persona) return null;
    return { persona, playbook: coachPart.playbook, comment: coachPart.comment };
  }
  async function writeMind(sample, f, report, signal) {
    const reply = await sample.json(proMindPrompt(f, report), { modelTier: "default", cache: false, ...(signal ? { signal } : {}) });
    const out = parseMind(reply);
    if (!out) throw { code: "invalid_reply", message: "Claude's answer couldn't be read." };
    return out;
  }

  return { turnPrompt, parseTurn, runAiBattle, draftPrompt, draftSkill, scoutPrompt, scout, coachPrompt, parseCoach, coach,
           proMindPrompt, parseMind, writeMind, battleSummary, gymSummary, Cancelled, REASON_TEXT, STOP_CODES, TIERS };
});
