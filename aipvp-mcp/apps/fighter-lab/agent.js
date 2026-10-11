/* Fighter Lab AI agents: Claude picks each fighter's move, and a Claude coach writes its playbook.
 * No page code: the caller passes in a `sample` function (the claude.ai `sample` capability in the
 * browser, a fake in tests), so this runs in Node and the browser alike (global `FighterAgent`). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./engine.js"));
  else root.FighterAgent = factory(root.FighterEngine);
})(typeof self !== "undefined" ? self : this, function (E) {
  "use strict";

  const STYLE_LABEL = (s) => E.STYLE_INFO[s].label;
  const moveDesc = (m) => `${E.SKILLS[m].move} (${STYLE_LABEL(E.SKILLS[m].style)})`;
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

  class Cancelled extends Error { constructor() { super("Battle cancelled"); this.name = "Cancelled"; } }

  const RULES = [
    "RULES",
    "- Both fighters pick a move at the same time. You cannot see the opponent's pick for this turn.",
    "- Every move has a style. Aggro beats Social, Social beats Mind, Mind beats Guard, Guard beats Aggro.",
    "  A move does double damage against the style it beats and half damage against the style that beats it. Other pairs do normal damage.",
    "- Damage = power x phase multiplier x style effect x mastery bonus x level bonus. Both fighters deal damage every turn.",
    "- 12 turns. Turns 1-4 are the opening (x1), 5-8 the midgame (x1.5), 9-12 the endgame (x2).",
    "- At 0 HP a fighter is knocked out. Otherwise the fighter with the higher share of HP left wins.",
  ].join("\n");

  function quoteBlock(text) {
    const t = String(text || "").trim();
    return t ? t.split("\n").map((l) => "| " + l).join("\n") : "| (none)";
  }

  /** The prompt for side i's move this turn. Only the opponent's name, moves and the moves they
   *  have played go in: never their persona, playbook or battle lines (those are their owner's text). */
  function turnPrompt(state, i) {
    const me = state.side[i], them = state.side[1 - i];
    const f = me.f, o = them.f;
    const ph = E.phaseOf(state.turn), phase = E.PHASES[ph];
    const myMoves = f.moves.map((m) => {
      const sk = E.SKILLS[m];
      return `- ${m}: ${sk.move}, ${STYLE_LABEL(sk.style)}, power ${sk.power}, mastery +${Math.round(E.masteryBonus(f.uses?.[m]) * 100)}%`;
    }).join("\n");
    const odds = E.instinctOdds(state, i);
    const instincts = odds ? odds.slice().sort((a, b) => b.p - a.p).map((x) => `${E.SKILLS[x.move].move} ${Math.round(x.p * 100)}%`).join(", ") : "none";
    const history = state.turns.length
      ? state.turns.map((t) => {
          const mine = t.actions[i], theirs = t.actions[1 - i];
          return `T${t.turn}: you ${moveDesc(mine.skill)} vs them ${moveDesc(theirs.skill)}. You dealt ${mine.points}, took ${theirs.points}.`;
        }).join("\n")
      : "(first turn)";
    return [
      `You are the battle brain of ${f.name}, a fighter in Fighter Lab, a turn-based game. Pick ${f.name}'s move for this turn.`,
      "",
      RULES,
      "",
      "YOUR MOVES (answer with one of these ids)",
      myMoves,
      "",
      `OPPONENT: ${E.cleanName(o.name)}, level ${o.level || 1}. Their moves: ${o.moves.map(moveDesc).join(", ")}.`,
      "",
      "YOUR TRAINER'S INSTRUCTIONS (how your trainer wants you to fight):",
      quoteBlock(E.cleanText(f.persona, E.PERSONA_MAX, false)),
      "",
      "YOUR PLAYBOOK (lessons from your training):",
      quoteBlock(E.cleanText(f.playbook, E.PLAYBOOK_MAX, true)),
      "",
      `YOUR INSTINCTS for this situation, from practice (what has worked before): ${instincts}.`,
      "",
      "BATTLE SO FAR",
      history,
      "",
      `NOW: turn ${state.turn} of ${E.TURNS}, ${phase.id.toUpperCase()} (x${phase.mult}). Your HP ${Math.ceil(me.hp)}/${me.max}. Their HP ${Math.ceil(them.hp)}/${them.max}.`,
      "",
      'Reply with only JSON: {"move": "<one of your move ids>", "line": "<a short in-character battle cry, at most 12 words>"}',
      `Example: {"move": "${f.moves[0]}", "line": "You won't see this coming."}`,
    ].join("\n");
  }

  /** Read Claude's reply. Accepts the move id or the move's name. Returns {skill, line} or null. */
  function parseTurn(reply, moves) {
    let obj = reply;
    if (typeof reply === "string") { try { obj = JSON.parse(reply); } catch { return null; } }
    if (!obj || typeof obj !== "object") return null;
    const raw = String(obj.move ?? "").trim().toLowerCase();
    const skill = moves.find((m) => m === raw || E.SKILLS[m].move.toLowerCase() === raw);
    if (!skill) return null;
    let line = typeof obj.line === "string" ? obj.line : "";
    line = line.replace(/[\u0000-\u001F\u007F\u{2028}\u{2029}]/gu, " ").replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "");
    if (line.length > 90) line = line.slice(0, 87).trimEnd() + "…";
    return { skill, line };
  }

  /**
   * Run one battle with Claude choosing moves for the sides in `ai` (default both).
   * opts: { a, b, sample, signal, rng, ai: [bool, bool], modelTier, learnA,
   *         onTurn(turnRecord), onThinking(sides[]), pace() -> Promise (resolves when the UI wants the next turn) }
   * Resolves { match, stats, stoppedReason }. Rejects Cancelled if `signal` aborts.
   */
  async function runAiBattle(opts) {
    const r = opts.rng || Math.random;
    const st = E.newBattle(E.clone(opts.a), E.clone(opts.b), { learnA: !!opts.learnA });
    const ai = (opts.ai || [true, true]).map((x) => !!x && typeof opts.sample === "function");
    const stats = { ai: 0, instinct: 0, reasons: {} };
    let stoppedReason = null;
    const signal = opts.signal;
    const check = () => { if (signal && signal.aborted) throw new Cancelled(); };

    async function decide(i) {
      const fallback = (reason) => {
        stats.instinct++;
        if (reason) stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
        return { ...E.instinctChoice(st, i, r), source: "instinct" };
      };
      if (!ai[i]) return fallback(null);
      const prompt = turnPrompt(st, i);
      let reply;
      try {
        reply = await opts.sample.json(prompt, { modelTier: opts.modelTier || "quick", cache: false, signal });
      } catch (e) {
        if ((e && e.code === "cancelled") || (signal && signal.aborted)) throw new Cancelled();
        const code = (e && typeof e.code === "string") ? e.code : "upstream_error";
        if (STOP_CODES.has(code)) { ai[0] = ai[1] = false; stoppedReason = stoppedReason || code; }
        check();
        return fallback(code);
      }
      check();
      const p = parseTurn(reply, st.side[i].f.moves);
      if (!p) return fallback("invalid_reply");
      stats.ai++;
      return { skill: p.skill, line: p.line, source: "ai" };
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

  // ---------- coach ----------
  function battleSummary(match, side) {
    const lines = match.turns.map((t) => {
      const mine = t.actions[side], theirs = t.actions[1 - side];
      return `T${t.turn}: ${moveDesc(mine.skill)} vs ${moveDesc(theirs.skill)}. Dealt ${mine.points}, took ${theirs.points}.`;
    });
    const res = match.winner === null ? "a draw" : match.winner === side ? "a win" : "a loss";
    const tail = match.ko ? " by knockout" : "";
    return `Battle against ${E.cleanName(match.agents[1 - side].name)} (level ${match.agents[1 - side].level}), ending in ${res}${tail}.\n${lines.join("\n")}`;
  }
  function gymSummary(report) {
    const p = E.PARTNERS.find((x) => x.id === report.partner);
    return `Gym practice: ${report.reps} rounds against ${p ? p.name : report.partner} (${p ? p.blurb : ""}). ` +
      `${report.win} wins, ${report.loss} losses, ${report.draw} draws.`;
  }
  /** Prompt for the coach to rewrite a fighter's playbook from what just happened. */
  function coachPrompt(f, whatHappened) {
    const map = E.brainMap(f).map((row) =>
      `${row.vs ? "After their " + STYLE_LABEL(row.vs) + " move" : "First move"}: ${E.SKILLS[row.best].move} (${Math.round(row.confidence * 100)}%)`).join("\n");
    return [
      `You coach ${f.name}, a fighter in Fighter Lab, a turn-based game. Rewrite ${f.name}'s playbook: the short list of lessons its battle brain reads before every move.`,
      "",
      RULES,
      "",
      `FIGHTER: level ${f.level}. Moves: ${f.moves.map(moveDesc).join(", ")}.`,
      "Trainer's instructions:",
      quoteBlock(E.cleanText(f.persona, E.PERSONA_MAX, false)),
      "",
      "CURRENT PLAYBOOK:",
      quoteBlock(E.cleanText(f.playbook, E.PLAYBOOK_MAX, true)),
      "",
      "INSTINCTS LEARNED IN PRACTICE (the move it favours in each situation):",
      map,
      "",
      "WHAT JUST HAPPENED:",
      whatHappened,
      "",
      "Write at most 8 lessons, one per line, each starting with \"- \". Make each concrete: name moves and styles.",
      "Keep lessons from the current playbook that still hold and drop ones the evidence contradicts. Stay under 700 characters.",
      'Reply with only JSON: {"playbook": "- lesson\\n- lesson", "comment": "<one encouraging sentence to the trainer about what changed>"}',
    ].join("\n");
  }
  function parseCoach(reply) {
    let obj = reply;
    if (typeof reply === "string") { try { obj = JSON.parse(reply); } catch { return null; } }
    if (!obj || typeof obj !== "object" || typeof obj.playbook !== "string") return null;
    const lines = obj.playbook.split(/\r?\n/).map((l) => E.cleanText(l, 200, false).trim()).filter(Boolean)
      .map((l) => (l.startsWith("- ") ? l : "- " + l.replace(/^[-*•\d.)\s]+/, ""))).slice(0, 8);
    if (!lines.length) return null;
    const playbook = lines.join("\n").slice(0, E.PLAYBOOK_MAX);
    const comment = E.cleanText(typeof obj.comment === "string" ? obj.comment : "", 200, false).trim();
    return { playbook, comment };
  }
  /** One coach request. Resolves {playbook, comment} or rejects with the sample error / Error("invalid"). */
  async function coach(sample, f, whatHappened, signal) {
    const reply = await sample.json(coachPrompt(f, whatHappened), { modelTier: "default", cache: false, ...(signal ? { signal } : {}) });
    const out = parseCoach(reply);
    if (!out) throw { code: "invalid_reply", message: "The coach's answer couldn't be read." };
    return out;
  }

  return { turnPrompt, parseTurn, runAiBattle, coachPrompt, parseCoach, coach, battleSummary, gymSummary, Cancelled, REASON_TEXT, STOP_CODES };
});
