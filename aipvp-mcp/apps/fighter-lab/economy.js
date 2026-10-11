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

  return {
    START, FREE_ROUNDS_PER_DAY, ROUND_COST, ARENA_REWARDS_PER_DAY, PRICES, LEDGER_KEEP,
    itemPrice, forgeCost, dayKey, newWallet, sanitizeWallet, balance, credit, spend, canAfford,
    gymQuote, payForGym, rivalReward, arenaReward, payArena,
  };
});
