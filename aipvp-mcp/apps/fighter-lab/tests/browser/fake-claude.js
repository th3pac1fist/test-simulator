/* Fake claude.ai runtime for the browser tests: storage (db), user and a fake Claude (sample.json) that answers
   battle turns, drafts, scouting, the coach and the Pro build's mind. URL params: uid, hang=1 (storage never answers),
   decline=1 (Claude not allowed), readonly=1, nodb=1. The shared fake database lives in localStorage "__fakedb",
   so several pages in one browser context act as several players. */
(() => {
  const q = new URLSearchParams(location.search);
  const uid = q.get("uid") || "u_alice";
  const NAMES = { u_alice: "Alice", u_bob: "Bob", u_cara: "Cara" };
  const stats = (window.__fakeStats = { calls: 0, inFlight: 0, maxInFlight: 0, cacheOff: true, coach: 0, prompts: [] });
  const load = () => { try { return JSON.parse(localStorage.getItem("__fakedb") || "{}"); } catch { return {}; } };
  const save = (db) => localStorage.setItem("__fakedb", JSON.stringify(db));
  const freeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
  const listeners = [];
  const notify = () => listeners.forEach((l) => l());
  window.addEventListener("storage", (e) => { if (e.key === "__fakedb") notify(); });
  const never = () => new Promise(() => {});
  const hang = q.get("hang") === "1";
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const snapDoc = (path, data) => ({ id: path.split("/").pop(), exists: data !== undefined, data: () => (data === undefined ? undefined : freeze(JSON.parse(JSON.stringify(data)))), metadata: { fromCache: false, hasPendingWrites: false } });
  function collDocs(path) {
    const db = load(), depth = path.split("/").length + 1;
    return Object.keys(db).filter((k) => k.startsWith(path + "/") && k.split("/").length === depth).sort().map((k) => snapDoc(k, db[k]));
  }
  function docRef(path) {
    return {
      id: path.split("/").pop(), path,
      async get() { if (hang) return never(); await delay(5); return snapDoc(path, load()[path]); },
      async set(data) { if (hang) return never(); await delay(15); if (q.get("readonly") === "1" && !path.startsWith("data/users/")) throw { code: "invalid_argument" };
        const db = load(); db[path] = JSON.parse(JSON.stringify(data)); save(db); notify(); },
      async delete() { if (hang) return never(); await delay(5); const db = load(); delete db[path]; save(db); notify(); },
      onSnapshot(next) { const fire = () => next(snapDoc(path, load()[path])); listeners.push(fire); setTimeout(fire, 0); return () => {}; },
    };
  }
  function collRef(path) {
    return {
      path,
      doc: (id) => docRef(path + "/" + id),
      async get() { if (hang) return never(); await delay(5); const docs = collDocs(path); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [] }; },
      onSnapshot(next) {
        let prev = [];
        const fire = () => {
          if (hang && path.startsWith("data/users/")) return;
          const docs = collDocs(path);
          const removed = prev.filter((p) => !docs.some((d) => d.id === p.id)).map((d) => ({ type: "removed", doc: d, oldIndex: 0, newIndex: -1 }));
          prev = docs;
          next({ docs, size: docs.length, empty: !docs.length, docChanges: () => removed, metadata: { fromCache: false, hasPendingWrites: false } });
        };
        listeners.push(fire); setTimeout(fire, 0); return () => {};
      },
    };
  }
  const db = Object.freeze({ doc: docRef, collection: collRef });
  const user = Object.freeze({
    id: async () => uid, isOwner: async () => uid === "u_alice", canEdit: async () => uid === "u_alice",
    can: async (n) => (n === "data.write" ? q.get("readonly") !== "1" : null),
    profiles: async (ids) => Object.fromEntries([].concat(ids).map((id) => [id, { id, name: NAMES[id] || "", isMe: id === uid }])),
  });
  function actionsOf(prompt) {
    const block = prompt.split("YOUR ACTIONS")[1].split("\n\n")[0];
    return [...block.matchAll(/^- ([\w-]+):(.*)$/gm)].filter((m) => !/\[(ON COOLDOWN|NOT ENOUGH ENERGY|ALREADY USED)/.test(m[2])).map((m) => m[1]);
  }
  const sample = async () => { throw { code: "invalid_request", message: "use json" }; };
  sample.json = async (prompt, opts = {}) => {
    stats.calls++; stats.prompts.push(prompt.slice(0, 120));
    if (opts.cache !== false) stats.cacheOff = false;
    stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      await new Promise((res, rej) => { const t = setTimeout(res, 40); opts.signal?.addEventListener("abort", () => { clearTimeout(t); rej({ code: "cancelled" }); }); });
      if (q.get("decline") === "1") throw { code: "not_granted", message: "declined" };
      if (prompt.startsWith("You coach")) { stats.coach++; return { playbook: "- Block brawlers with BULWARK\n- Talkers fold to STRIKE", comment: "Solid session: the counters are sticking." }; }
      if (prompt.startsWith("You design a weapon")) { stats.drafts = (stats.drafts || 0) + 1; return { name: "Flame Sword", kind: "weapon", style: "aggro", element: "fire", effects: [{ type: "rider", style: "aggro", status: "burn", chance: 0.6 }, { type: "edge", style: "aggro", pct: 0.4 }], why: "Its Aggro skills set them on fire." }; }
      if (prompt.startsWith("You design")) {
        stats.drafts = (stats.drafts || 0) + 1;
        if (/passive ability/.test(prompt)) return { name: "Second Wind", kind: "passive", style: "guard", element: "spirit", effects: [{ type: "regen", heal: 9, every: 2 }], why: "Heals a little every other turn." };
        return { name: "Fireball", kind: "active", style: "aggro", element: "fire", effects: [{ type: "damage", power: 9 }, { type: "burn", chance: 1, damage: 9, turns: 9 }, { type: "nuke", power: 99 }], why: "A <b>fireball</b> that sets them alight." };
      }
      if (prompt.startsWith("You write the mind")) { stats.minds = (stats.minds || 0) + 1; return { persona: "Wall up first, then hit the <b>counter</b>.", playbook: "- Open with the shield skill\n- Big hit at 3 energy\n- Save the item for the endgame", comment: "Play patient and let the shields work." }; }
      if (prompt.startsWith("You scout")) { stats.scouts = (stats.scouts || 0) + 1; return { plan: "- Open with GUARD\n- Save energy for the big hit" }; }
      stats.tiers = stats.tiers || {}; const tier = opts.modelTier || "?"; stats.tiers[tier] = (stats.tiers[tier] || 0) + 1;
      const acts = actionsOf(prompt);
      return { action: acts[Math.floor(Math.random() * acts.length)], line: "Watch this <b>move</b>!" };
    } finally { stats.inFlight--; }
  };
  const caps = { db: q.get("nodb") === "1" ? null : db, user, sample: Object.freeze(sample) };
  window.claude = Object.freeze({ use: async (name) => { await delay(20); return caps[name] ?? null; } });
})();
