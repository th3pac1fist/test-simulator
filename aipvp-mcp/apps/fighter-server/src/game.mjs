// Fighter Lab game rules on the server. The browser sends what the player wants to do; everything that
// changes a fighter's progress or the player's Cycles is decided here, with the same engine and economy
// code the claude.ai version runs in the browser. Paid battles use rules and instincts only (no Claude),
// with a stored seed, so every result can be replayed and checked.
import { createRequire } from "node:module";
import { randomInt } from "node:crypto";

const require = createRequire(import.meta.url);
export const E = require("../../fighter-lab/engine.js");
export const ECON = require("../../fighter-lab/economy.js");

export const LIMITS = {
  fighters: 20, library: 40, arena: 6, reps: 50, inventory: 99,
  rivalRepeatsPerDay: 10,          // repeat rival wins that pay Cycles, per day (first wins always pay)
  sparTtl: 30 * 60 * 1000,
};

export class GameError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (msg, status) => { throw new GameError(msg, status); };
const rand = () => randomInt(0, 2 ** 32) / 2 ** 32;
const newId = (prefix) => E.newId(rand, prefix);
const newSeed = () => randomInt(1, 2 ** 31 - 1);
const KIND_LABEL = { active: "skill", passive: "passive", weapon: "weapon" };

function newProgress(now) {
  return { beaten: [], codex: [], library: [], inventory: {}, wallet: ECON.newWallet(now), rivalRepeats: { day: ECON.dayKey(now), n: 0 } };
}
function cleanDesign(d) {
  d = d && typeof d === "object" ? d : {};
  const n = (x, lo, hi, dflt) => (Number.isFinite(Number(x)) ? Math.max(lo, Math.min(hi, Number(x))) : dflt);
  const one = (x, list, dflt) => (list.includes(x) ? x : dflt);
  return {
    hue: Math.round(n(d.hue, 0, 359, 200)), accent: Math.round(n(d.accent, 0, 359, 40)),
    body: one(d.body, ["round", "tall", "wide"], "round"), size: n(d.size, 0, 1, 0.6),
    spikes: Math.round(n(d.spikes, 0, 3, 0)), armor: d.armor === true,
    eyes: one(d.eyes, ["round", "angry", "visor"], "round"), pattern: one(d.pattern, ["plain", "spots", "stripes"], "plain"),
  };
}
function cleanStats(s) {
  s = s && typeof s === "object" ? s : {};
  const n = (x) => Math.max(0, Math.min(E.MAX_LEVEL, Math.round(Number(x) || 0)));
  return { power: n(s.power), vitality: n(s.vitality), speed: n(s.speed) };
}
/** A battle's outcome in a few numbers: what a replay has to reproduce exactly. */
export function outcomeOf(m) {
  return { winner: m.winner, ko: m.ko, turns: m.turns.length, hp: m.agents.map((a) => a.hp), result: m.result };
}
/** Run a stored battle again from its seed and the fighters as they were. */
export function replay(record) {
  const match = E.fight(E.clone(record.me), E.clone(record.foe), { rng: E.rng(record.seed), learnA: true });
  return { match, ok: JSON.stringify(outcomeOf(match)) === JSON.stringify(record.outcome) };
}

export function createGame(st) {
  const spars = new Map();   // spar id -> { address, fighterId, spar, at }

  function loadProgress(address, now) {
    const p = st.progress(address);
    if (!p) fail("Sign in first.", 401);
    p.wallet = ECON.sanitizeWallet(p.wallet, now);
    if (!p.rivalRepeats || p.rivalRepeats.day !== ECON.dayKey(now)) p.rivalRepeats = { day: ECON.dayKey(now), n: 0 };
    return p;
  }
  /** Every Cycles movement the wallet gained, appended to the ledger table. */
  function commitWallet(address, before, after) {
    const n = (after.seq || 0) - (before.seq || 0);
    if (n > 0) for (const e of after.ledger.slice(-n)) st.addLedger(address, e);
    if (ECON.balance(after) !== st.ledgerSum(address)) throw new Error("Cycles ledger out of step");
  }
  /** One player action in one transaction: fn changes `p` (progress) and returns the answer. */
  function act(address, fn, now = Date.now()) {
    return st.tx(() => {
      const p = loadProgress(address, now);
      const before = p.wallet;
      const out = fn(p, now) || {};
      commitWallet(address, before, p.wallet);
      st.setProgress(address, p);
      return { ...out, progress: view(p) };
    });
  }
  function view(p) {
    return { beaten: p.beaten, codex: p.codex, library: p.library, inventory: p.inventory, wallet: p.wallet, balance: ECON.balance(p.wallet) };
  }
  function spend(p, amount, reason, ref, now) {
    p.wallet = ECON.spend(p.wallet, amount, reason, ref, now);
  }
  function earn(p, amount, reason, ref, now) {
    if (amount > 0) p.wallet = ECON.credit(p.wallet, amount, reason, ref, now);
  }
  function fighter(address, id) {
    const f = typeof id === "string" ? st.fighter(address, id) : null;
    return f || fail("No such fighter.", 404);
  }
  function save(address, f, now) {
    const g = { ...f, rev: (f.rev || 0) + 1, updatedAt: now };
    st.putFighter(address, g, now);
    return g;
  }
  const fileName = (f, id) => (E.skillOf(f, id) || [f.passive, f.weapon].find((x) => x && x.id === id) || { name: id }).name;

  /**
   * The files a design asks for, taken from what the player owns (never from the request):
   * basic skills, files already on this fighter, starter passives, or the library within the level limit.
   */
  function resolveFiles(p, current, d, level) {
    const moves = Array.isArray(d.moves) ? d.moves : [];
    if (moves.length !== 4 || !moves.every((m) => typeof m === "string") || new Set(moves).size !== 4) fail("A fighter needs exactly 4 different skills.");
    const custom = {};
    for (const m of moves) {
      if (Object.prototype.hasOwnProperty.call(E.BASIC, m)) continue;
      if (current && current.custom && current.custom[m]) { custom[m] = current.custom[m]; continue; }
      const lib = p.library.find((s) => s.id === m && s.kind === "active");
      if (!lib) fail("You don't own that skill file.");
      if (lib.budget > E.maxSkillBudget(level)) fail(`${lib.name} needs a higher level.`);
      custom[m] = E.clone(lib);
    }
    const idOf = (x) => (typeof x === "string" ? x : x && typeof x === "object" && typeof x.id === "string" ? x.id : null);
    const pick = (kind, want, starters) => {
      const id = idOf(want);
      if (!id) return null;
      const had = current && current[kind];
      if (had && had.id === id) return had;
      const starter = starters.find((s) => s.id === id);
      if (starter) return E.clone(starter);
      const lib = p.library.find((s) => s.id === id && s.kind === kind);
      if (!lib) fail(`You don't own that ${kind} file.`);
      if (lib.budget > E.capFor(kind, level)) fail(`${lib.name} needs a higher level.`);
      return E.clone(lib);
    };
    return {
      moves, custom,
      passive: pick("passive", d.passive, E.STARTER_PASSIVES),
      weapon: pick("weapon", d.weapon, []),
      item: E.ITEMS[d.item] ? d.item : null,
    };
  }
  function finishDesign(f, d) {
    const broken = E.validateLoadout(f);
    if (broken.length) fail(broken.join(" "));
    f.rules = E.sanitizeRules(d.rules, f.moves);
    f.persona = E.cleanText(d.persona, E.PERSONA_MAX, false);
    f.playbook = E.cleanText(d.playbook, E.PLAYBOOK_MAX, true);
    return f;
  }
  const nameOf = (raw) => { const n = E.cleanName(raw); if (n === "???") fail("Give your fighter a name."); return n; };

  // ---------- accounts ----------
  function join(address, now = Date.now()) {
    if (st.account(address)) return false;
    st.tx(() => {
      st.addAccount(address, now);
      const p = newProgress(now);
      for (const e of p.wallet.ledger) st.addLedger(address, e);
      st.setProgress(address, p);
    });
    return true;
  }
  function state(address, now = Date.now()) {
    const p = loadProgress(address, now);
    return { address, fighters: st.fighters(address), progress: view(p) };
  }

  // ---------- fighters ----------
  function createFighter(address, d = {}) {
    return act(address, (p, now) => {
      if (st.fighters(address).length >= LIMITS.fighters) fail(`You can have ${LIMITS.fighters} fighters. Delete one first.`);
      const files = resolveFiles(p, null, d, 1);
      let f = E.upgradeFighter(E.createFighter({ name: nameOf(d.name), design: cleanDesign(d.design), personality: d.personality, ...files }, rand));
      f = finishDesign(f, d);
      return { fighter: save(address, f, now) };
    });
  }
  /** Change a fighter's design. `respec: true` pays for moving stat points already spent. */
  function updateFighter(address, id, d = {}) {
    return act(address, (p, now) => {
      const cur = fighter(address, id);
      const files = resolveFiles(p, cur, d, cur.level);
      let f = E.redesign(cur, { name: nameOf(d.name ?? cur.name), design: cleanDesign(d.design ?? cur.design), personality: d.personality, ...files });
      const want = d.stats ? cleanStats(d.stats) : E.statsOf(cur), had = E.statsOf(cur);
      const moved = ["power", "vitality", "speed"].some((k) => want[k] < had[k]);
      if (moved && d.respec !== true) fail(`Moving points you've already spent needs a reset (${ECON.PRICES.respec} Cycles).`);
      if (moved) spend(p, ECON.PRICES.respec, `Stat reset for ${f.name}`, f.id, now);
      f = E.setStats(f, want);
      f = finishDesign(f, d);
      return { fighter: save(address, f, now) };
    });
  }
  function deleteFighter(address, id) {
    fighter(address, id);
    st.tx(() => { st.dropFighter(address, id); st.unpublish(address, id); });
    for (const [k, s] of spars) if (s.address === address && s.fighterId === id) spars.delete(k);
    return { deleted: id };
  }

  // ---------- gym ----------
  function partnerFor(f, partnerId) {
    const partner = E.PARTNERS.find((x) => x.id === partnerId) || fail("Unknown practice partner.");
    if (f.level < partner.unlock) fail(`${partner.name} unlocks at level ${partner.unlock}.`);
    return partner;
  }
  function train(address, id, { partner: partnerId, reps, drill } = {}) {
    return act(address, (p, now) => {
      const f = fighter(address, id), partner = partnerFor(f, partnerId);
      const n = Math.round(Number(reps));
      if (!(n >= 1 && n <= LIMITS.reps)) fail(`Train 1 to ${LIMITS.reps} rounds at a time.`);
      if (drill != null && !f.moves.includes(drill)) fail("Drill a skill this fighter has equipped.");
      const paid = ECON.payForGym(p.wallet, n, now);   // throws if you can't afford it
      p.wallet = paid.wallet;
      const before = E.readiness(f).pending.map((x) => x.id);
      const { fighter: g, report } = E.train(f, partner.id, n, { rng: E.rng(newSeed()), drill: drill || null });
      report.lastFoe = E.partnerFighter(partner.id, f);
      report.fighterId = f.id;
      const ready = before.filter((x) => !E.readiness(g).pending.some((y) => y.id === x)).map((x) => fileName(g, x));
      return { fighter: save(address, g, now), report, quote: paid.quote, ready };
    });
  }
  function startSpar(address, id, { partner: partnerId } = {}, now = Date.now()) {
    const f = fighter(address, id), partner = partnerFor(f, partnerId);
    for (const [k, s] of spars) if (s.address === address || now - s.at > LIMITS.sparTtl) spars.delete(k);   // one spar at a time
    const sparId = newId("sp_");
    const spar = E.newSpar(f, partner.id);
    spars.set(sparId, { address, fighterId: f.id, spar, at: now });
    return { sparId, spar };
  }
  /** One hand-picked turn (slot 0-3 a skill, 4 the item, or "rest"). The last turn saves the fighter. */
  function sparTurn(address, sparId, { slot } = {}, now = Date.now()) {
    const s = spars.get(sparId);
    if (!s || s.address !== address || now - s.at > LIMITS.sparTtl) fail("That sparring session has ended.", 404);
    const pick = slot === "rest" ? "rest" : Number.isInteger(slot) && slot >= 0 && slot <= E.ITEM_SLOT ? slot : fail("Choose one of your actions.");
    s.at = now;
    const turn = E.sparTurn(s.spar, pick, rand);
    if (!s.spar.state.over) return { turn, over: false, spar: s.spar };
    spars.delete(sparId);
    return act(address, (p, t) => {
      const latest = st.fighter(address, s.fighterId);
      if (!latest) return { turn, over: true, match: E.finishBattle(s.spar.state), fighter: null, xp: 0 };
      const out = E.finishSpar(latest, s.spar);
      return { turn, over: true, spar: s.spar, match: out.match, xp: out.xp, fighter: save(address, out.fighter, t) };
    }, now);
  }

  // ---------- battles: rivals and the arena ----------
  function rivalTarget(p, rivalId) {
    const i = E.RIVALS.findIndex((r) => r.id === rivalId);
    if (i < 0) fail("Unknown rival.");
    const rv = E.RIVALS[i];
    if (i > 0 && !p.beaten.includes(rv.id) && !p.beaten.includes(E.RIVALS[i - 1].id)) fail(`Beat ${E.RIVALS[i - 1].name} first.`);
    return rv;
  }
  /** A blueprint drop after a real win; duplicates (or a full library) become Cycles. Returns a result line or "". */
  function grantDrop(p, ctx, seed, now) {
    const d = ECON.rollDrop({ ...ctx, unlocked: E.unlockedFamilies(p), owned: p.library, rng: E.rng((seed ^ 0x5bd1e995) >>> 0) });
    if (!d) return "";
    const what = `${d.rarity} ${KIND_LABEL[d.file.kind]}`;
    if (d.duplicate || p.library.length >= LIMITS.library) {
      const refund = d.refund || ECON.RARITY[d.rarity].refund;
      earn(p, refund, `Duplicate blueprint: ${d.file.name}`, null, now);
      return `Blueprint: ${d.file.name} (${what}), which you already have, so it became +${refund} Cycles.`;
    }
    p.library = [...p.library, { ...d.file, id: newId("bp_") }];
    return `New blueprint: ${d.file.name} (${what}) is in your library. Equip it in Design, then practice it in the Gym.`;
  }
  /**
   * A rival battle ({ rival }) or an arena challenge ({ owner, fighter }), run here on rules and instincts.
   * Returns the finished match for the browser to animate, plus what it earned.
   */
  function battle(address, id, target = {}) {
    return act(address, (p, now) => {
      const meRaw = fighter(address, id);
      const rd = E.readiness(meRaw);
      if (!rd.ready) fail(rd.pending.length ? `${rd.pending[0].name} is still in training (${rd.pending[0].have}/${rd.pending[0].need}). Practice it in the Gym first.` : rd.clauses[0]);
      let kind, foe, rv = null, opponent;
      if (target.rival) {
        rv = rivalTarget(p, target.rival);
        kind = "rival"; foe = E.rivalFighter(rv.id); opponent = rv.id;
      } else if (typeof target.owner === "string" && typeof target.fighter === "string") {
        const entry = st.arenaEntry(target.owner, target.fighter);
        foe = entry && E.sanitizePublic(entry, target.owner);
        if (!foe) fail("That fighter has left the arena.", 404);
        kind = target.owner === address ? "arena-own" : "arena"; opponent = `${target.owner}/${foe.id}`;
      } else fail("Choose a rival or an arena fighter.");
      const me = E.clone(meRaw);
      if (me.item && !(p.inventory[me.item] > 0)) me.item = null;   // you only bring items you own
      const seed = newSeed();
      const record = { v: 1, kind, at: now, seed, me: E.clone(me), foe: E.clone(foe) };
      const match = E.fight(me, foe, { rng: E.rng(seed), learnA: true });   // `me` learns as it fights
      record.outcome = outcomeOf(match);

      const award = E.awardBattle(meRaw, match, 0);
      const f = award.fighter;
      f.brain = E.compactBrain(me.brain);          // instincts also learn from real battles
      f.uses = { ...f.uses, ...me.uses };
      const lines = [`+${award.xp} XP${award.levelAfter > award.levelBefore ? ` · Level ${award.levelBefore} → ${award.levelAfter} (spend the stat point in Design)` : ""}`];
      const usedItem = me.item && match.turns.some((t) => t.actions[0].kind === "item");
      if (usedItem) { p.inventory[me.item] = Math.max(0, (p.inventory[me.item] || 0) - 1); lines.push(`${E.ITEMS[me.item].name} used up (${p.inventory[me.item]} left).`); }
      let reward = 0;
      if (kind === "rival" && award.result === "win") {
        const first = !p.beaten.includes(rv.id);
        const badge = Object.entries(E.FAMILIES).filter(([, x]) => x === rv.id).map(([k]) => k);
        if (first || p.rivalRepeats.n < LIMITS.rivalRepeatsPerDay) {
          reward = ECON.rivalReward(rv.level, first);
          if (!first) p.rivalRepeats = { ...p.rivalRepeats, n: p.rivalRepeats.n + 1 };
          earn(p, reward, `${first ? "First win" : "Win"} vs ${rv.name}`, rv.id, now);
          lines.push(`+${reward} Cycles.`);
        } else lines.push("Today's rematch rewards are used up; more tomorrow.");
        if (first) p.beaten = [...p.beaten, rv.id];
        if (first && badge.length) lines.push(`Badge earned: ${badge.map((k) => E.familyLabel(k)).join(", ")} unlocked.`);
        if (first || reward) {
          const drop = grantDrop(p, { source: first ? "rivalFirst" : "rival", opponentLevel: rv.level, level: f.level, prefer: first ? badge[0] : null }, seed, now);
          if (drop) lines.push(drop);
        }
        const next = E.RIVALS[E.RIVALS.findIndex((r) => r.id === rv.id) + 1];
        if (first) lines.push(next ? `${rv.name} beaten. ${next.name} is unlocked.` : "You beat the champion. The ladder is yours.");
      }
      if (kind === "arena" || kind === "arena-own") {
        record.result = { at: now, a: { owner: address, id: meRaw.id, name: meRaw.name }, b: { owner: target.owner, id: foe.id, name: foe.name },
                          winner: match.winner, ko: match.ko, ai: false };
        lines.push(kind === "arena" ? "Result recorded on the arena leaderboard." : "Battles against your own fighters aren't rated.");
        const paid = ECON.payArena(p.wallet, award.result, kind === "arena-own", opponent, now);
        p.wallet = paid.wallet; reward = paid.amount;
        if (paid.amount) {
          lines.push(`+${paid.amount} Cycles.`);
          if (award.result === "win") { const drop = grantDrop(p, { source: "arena", opponentLevel: foe.level || 1, level: f.level }, seed, now); if (drop) lines.push(drop); }
        } else if (kind === "arena-own") lines.push("No Cycles for beating your own fighter.");
        else lines.push("Today's arena rewards are used up; more tomorrow.");
      }
      const battleId = newId("b_");
      st.addBattle({ id: battleId, address, kind, fighterId: meRaw.id, opponent, seed, result: award.result, record, at: now });
      return { battleId, seed, match, me: record.me, foe, result: award.result, reward, lines, fighter: save(address, f, now) };
    });
  }
  /** A stored battle and a fresh replay of it (only for the player who fought it). */
  function battleRecord(address, battleId) {
    const b = st.battle(battleId);
    if (!b || b.address !== address) fail("No such battle.", 404);
    const r = replay(b.record);
    return { id: b.id, kind: b.kind, at: b.at, seed: b.seed, result: b.result, outcome: b.record.outcome, verified: r.ok, match: r.match, me: b.record.me, foe: b.record.foe };
  }
  function publish(address, id) {
    const f = fighter(address, id);
    const rd = E.readiness(f);
    if (!rd.ready) fail(rd.pending.length ? `${rd.pending[0].name} is still in training. Practice it before entering the arena.` : rd.clauses[0]);
    const mine = st.arena().filter((x) => x.owner === address);
    if (!mine.some((x) => x.fighter.id === id) && mine.length >= LIMITS.arena) fail(`You can have ${LIMITS.arena} fighters in the arena. Remove one first.`);
    const pub = E.toPublic(f);
    if (!E.sanitizePublic(pub, address)) fail("This fighter can't enter the arena.");
    st.publish(address, pub, Date.now());
    return { published: id };
  }
  function unpublish(address, id) { st.unpublish(address, id); return { unpublished: id }; }
  function arena() {
    const entries = st.arena().map((x) => ({ owner: x.owner, fighter: E.sanitizePublic(x.fighter, x.owner) })).filter((x) => x.fighter);
    const ratings = E.arenaRatings(st.arenaResults().map((r) => E.sanitizeResult(r)).filter(Boolean));
    return { entries, ratings };
  }

  // ---------- forge, Codex, shop, library ----------
  function forge(address, { skill, fighter: fighterId } = {}) {
    return act(address, (p, now) => {
      const level = fighterId ? fighter(address, fighterId).level : 1;
      const v = E.validateSkill(skill, { level });
      if (!v.skill || v.errors.length) fail((v.errors || ["Not a skill file."]).join(" "));
      const locked = E.lockedIn(v.skill, E.unlockedFamilies(p));
      if (locked.length) fail(`Locked: ${locked.map((x) => x.label).join(", ")}.`);
      if (p.library.length >= LIMITS.library) fail(`Your library holds ${LIMITS.library} skills. Delete one first.`);
      const cost = ECON.forgeCost(v.skill);
      spend(p, cost, `Forged ${v.skill.name}`, null, now);
      const file = { ...v.skill, id: newId("sk_") };
      p.library = [...p.library, file];
      return { file, cost };
    });
  }
  function codex(address, { key } = {}) {
    return act(address, (p, now) => {
      if (typeof key !== "string" || !E.FAMILIES[key]) fail("Unknown Codex entry.");
      if (E.unlockedFamilies(p).has(key)) fail(`${E.familyLabel(key)} is already unlocked.`);
      spend(p, ECON.codexPrice(key), `Codex: ${E.familyLabel(key)}`, key, now);
      p.codex = [...p.codex, key];
      return { unlocked: key };
    });
  }
  function buy(address, { item } = {}) {
    return act(address, (p, now) => {
      const it = (typeof item === "string" && Object.prototype.hasOwnProperty.call(E.ITEMS, item) && E.ITEMS[item]) || fail("Unknown item.");
      if ((p.inventory[it.id] || 0) >= LIMITS.inventory) fail(`You can carry ${LIMITS.inventory} of each item.`);
      spend(p, it.price, `Bought ${it.name}`, it.id, now);
      p.inventory = { ...p.inventory, [it.id]: (p.inventory[it.id] || 0) + 1 };
      return { bought: it.id };
    });
  }
  function dropFile(address, fileId) {
    return act(address, (p) => {
      if (!p.library.some((s) => s.id === fileId)) fail("No such file in your library.", 404);
      if (st.fighters(address).some((f) => f.moves.includes(fileId) || (f.passive && f.passive.id === fileId) || (f.weapon && f.weapon.id === fileId))) {
        fail("A fighter has this equipped. Unequip it in Design first.");
      }
      p.library = p.library.filter((s) => s.id !== fileId);
      return { deleted: fileId };
    });
  }

  return {
    join, state, act, createFighter, updateFighter, deleteFighter, train, startSpar, sparTurn,
    battle, battleRecord, publish, unpublish, arena, forge, codex, buy, dropFile,
    _spars: spars,
  };
}
