/* Fighter Lab app (rules v3): UI, storage, AI battles, skills forge, economy, rivals and the arena. */
(() => {
  "use strict";
  const E = window.FighterEngine, A = window.FighterAgent, SP = window.FighterSprites, ECON = window.FighterEconomy, OPT = window.FighterOptimizer;
  const $ = (id) => document.getElementById(id);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const STYLE_VAR = { aggro: "var(--st-aggro)", social: "var(--st-social)", mind: "var(--st-mind)", guard: "var(--st-guard)" };
  const NAMES = ["NOVA", "RIVET", "EMBER", "QUILL", "VOLT", "MOSS", "ONYX", "PIXEL", "TANGO", "ZEPHYR", "BRAMBLE", "COMET"];
  const LOCAL_KEY = "fighterlab.v2", OLD_KEY = "fighterlab.v1";
  const ARENA_MAX = 6, RESULTS_MAX = 150, LIBRARY_MAX = 40;
  const PERMANENT_AI_CODES = new Set(["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"]);

  // ---------- state ----------
  const newProgress = () => ({ beaten: [], rev: 0, wallet: ECON.newWallet(), library: [], inventory: {} });
  const S = {
    fighters: [], deleted: [], progress: newProgress(),
    activeId: null, tab: "design", draft: null, editingId: null, confirmDelete: false,
    partnerId: "brawler", reps: 10, report: null, spar: null,
    coach: { busy: false, forId: null, comment: "", playbook: "", error: "", pending: null },
    rivalId: null, aiOn: true, overclock: false, scouting: {}, localOwner: null,
    ai: { sample: null, ready: false, off: false, reason: "" },
    me: { id: null, user: null, canWrite: null, owner: false },
    pro: { status: "idle", forId: null, frac: 0, label: "", result: null, error: "", ctl: null, mind: null },
    arena: { db: null, docs: {}, raw: {}, results: {}, resultsRaw: {}, loaded: false, error: "", ratings: {} },
    store: { mode: "starting", pending: 0, failed: {}, slow: false, coll: null },
    battle: null, lastBattle: null, pendingChallenge: null,
    forge: null,
  };
  const active = () => S.fighters.find((f) => f.id === S.activeId) || null;
  const find = (id) => S.fighters.find((f) => f.id === id) || null;
  const skillName = (f, id) => (E.skillOf(f, id) || {}).name || id;

  // ---------- progress (wallet, skill library, items): validated on every load ----------
  function sanitizeProgress(raw) {
    const p = newProgress();
    if (!raw || typeof raw !== "object") return p;
    p.beaten = Array.isArray(raw.beaten) ? raw.beaten.filter((x) => E.RIVALS.some((r) => r.id === x)) : [];
    p.rev = Number.isFinite(raw.rev) ? raw.rev : 0;
    p.wallet = ECON.sanitizeWallet(raw.wallet);
    p.library = (Array.isArray(raw.library) ? raw.library : []).slice(0, LIBRARY_MAX).map((s) => E.validateSkill(s).skill).filter(Boolean);
    const inv = raw.inventory && typeof raw.inventory === "object" ? raw.inventory : {};
    p.inventory = Object.fromEntries(Object.keys(E.ITEMS).map((k) => [k, Math.max(0, Math.min(99, Math.round(Number(inv[k]) || 0)))]));
    return p;
  }

  // ---------- local backup: always written first, so nothing waits on the network ----------
  function validOwn(f) {
    // custom skill ids are allowed: upgradeFighter re-validates everything
    return f && typeof f.id === "string" && Array.isArray(f.moves) && f.moves.length === 4 && f.moves.every((m) => typeof m === "string") && f.brain && Array.isArray(f.brain.W);
  }
  // The backup is tagged with the account it belongs to: two claude.ai accounts on one browser
  // must never see (or spend) each other's fighters and Cycles.
  const stashKey = (uid) => `${LOCAL_KEY}@${uid}`;
  function readLocal(key) { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; } }
  function loadLocal(data) {
    if (data === undefined) {
      data = readLocal(LOCAL_KEY);
      if (!data) {
        try { const old = JSON.parse(localStorage.getItem(OLD_KEY) || "null"); if (Array.isArray(old)) data = { fighters: old }; } catch { /* none */ }
      }
    }
    data = data && typeof data === "object" ? data : {};
    S.localOwner = typeof data.owner === "string" ? data.owner : null;
    S.fighters = (Array.isArray(data.fighters) ? data.fighters : []).filter(validOwn).map(E.upgradeFighter);
    S.deleted = Array.isArray(data.deleted) ? data.deleted.filter((x) => typeof x === "string") : [];
    S.progress = sanitizeProgress(data.progress);
    S.activeId = find(data.activeId) ? data.activeId : S.fighters[0]?.id || null;
    sortFighters();
  }
  function saveLocal() {
    const owner = S.me.id || S.localOwner || null;
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ owner, fighters: S.fighters, deleted: S.deleted, progress: S.progress, activeId: S.activeId })); }
    catch { /* storage blocked: the account copy still saves */ }
  }
  /** Called once the account is known. A backup from a different account is set aside, not merged. */
  function claimLocal(uid) {
    if (!S.localOwner || S.localOwner === uid) { S.localOwner = uid; saveLocal(); return; }
    try {
      localStorage.setItem(stashKey(S.localOwner), localStorage.getItem(LOCAL_KEY) || "null");
      const mine = readLocal(stashKey(uid));
      localStorage.removeItem(stashKey(uid));
      loadLocal(mine || {});
    } catch { loadLocal({}); }
    S.localOwner = uid; saveLocal();
    Object.assign(S, { draft: null, editingId: null, report: null, spar: null, scouting: {}, rivalId: null, lastBattle: null, pendingChallenge: null });
    S.coach = { busy: false, forId: null, comment: "", playbook: "", error: "", pending: null };
    stopBattle();
    if (S.fighters.length) S.tab = "roster"; else { openDesigner(null); S.tab = "design"; }
    renderWallet(); render();
  }
  function sortFighters() { S.fighters.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); }

  // ---------- account storage: background writes, one at a time per document ----------
  const chains = {}, queued = {};
  function enqueue(key, fn) {
    if (queued[key]) return;          // a write for this document is already waiting; it will send the latest copy
    queued[key] = true;
    S.store.pending++; renderStore();
    const run = (chains[key] || Promise.resolve()).then(() => { queued[key] = false; return fn(); });
    chains[key] = run.catch(() => {});
    const slow = setTimeout(() => { S.store.slow = true; renderStore(); }, 12000);
    run.then(() => { delete S.store.failed[key]; }, (e) => { S.store.failed[key] = { fn, code: e && e.code }; })
      .finally(() => { clearTimeout(slow); S.store.pending--; if (!S.store.pending) S.store.slow = false; renderStore(); });
  }
  function retryFailed() {
    const failed = S.store.failed; S.store.failed = {};
    for (const [k, v] of Object.entries(failed)) enqueue(k, v.fn);
    renderStore();
  }
  const writeFighter = (id) => () => {
    const f = find(id);
    if (!f || !S.store.coll) return undefined;
    return S.store.coll.doc(id).set(E.clone(f));
  };
  function saveFighter(f) {
    const prev = find(f.id);
    const g = { ...f, rev: Math.max(f.rev || 0, prev?.rev || 0) + 1, updatedAt: Date.now() };
    const i = S.fighters.findIndex((x) => x.id === g.id);
    if (i >= 0) S.fighters[i] = g; else S.fighters.push(g);
    sortFighters(); saveLocal();
    if (S.store.coll) enqueue("f:" + g.id, writeFighter(g.id));
    return g;
  }
  function deleteFighter(id) {
    S.fighters = S.fighters.filter((f) => f.id !== id);
    if (!S.deleted.includes(id)) S.deleted.push(id);
    if (S.activeId === id) S.activeId = S.fighters[0]?.id || null;
    saveLocal();
    if (S.store.coll) enqueue("f:" + id, () => S.store.coll.doc(id).delete().then(() => { S.deleted = S.deleted.filter((x) => x !== id); saveLocal(); }));
    if (myArenaList().some((p) => p.id === id)) unpublish(id);
  }
  const writeProgress = () => S.store.coll.doc("progress").set({ kind: "progress", ...E.clone(S.progress) });
  function saveProgress() {
    S.progress = { ...S.progress, rev: (S.progress.rev || 0) + 1 };
    saveLocal();
    if (S.store.coll) enqueue("progress", writeProgress);
    renderWallet();
  }
  function mergeRemote(docs, initial, changes) {
    const remoteRev = {};
    let remoteProgressRev = -1;
    for (const d of docs) {
      const data = d.data();
      if (!data) continue;
      if (d.id === "progress") {
        remoteProgressRev = data.rev || 0;
        if ((data.rev || 0) > (S.progress.rev || 0)) S.progress = sanitizeProgress(E.clone(data));
        continue;
      }
      if (!validOwn(data)) continue;
      remoteRev[d.id] = data.rev || 0;
      if (S.deleted.includes(d.id)) { if (initial) enqueue("f:" + d.id, () => S.store.coll.doc(d.id).delete()); continue; }
      const remote = E.upgradeFighter(E.clone(data));
      const i = S.fighters.findIndex((f) => f.id === d.id);
      if (i < 0) S.fighters.push(remote);
      else if ((remote.rev || 0) > (S.fighters[i].rev || 0)) S.fighters[i] = remote;   // only ever replace with a newer copy
    }
    if (changes) {
      for (const ch of changes) {
        if (ch.type === "removed" && ch.doc.id !== "progress" && !queued["f:" + ch.doc.id]) S.fighters = S.fighters.filter((f) => f.id !== ch.doc.id);
      }
    }
    if (initial) {
      for (const f of S.fighters) if (!(f.id in remoteRev) || remoteRev[f.id] < (f.rev || 0)) enqueue("f:" + f.id, writeFighter(f.id));
      for (const id of S.deleted) if (!(id in remoteRev)) S.deleted = S.deleted.filter((x) => x !== id);
      if ((S.progress.rev || 0) > remoteProgressRev) enqueue("progress", writeProgress);
    }
    sortFighters();
    if (!active()) S.activeId = S.fighters[0]?.id || null;
    saveLocal();
    renderWallet();
    softRender();
  }

  async function connect() {
    const c = window.claude;
    if (!c || typeof c.use !== "function") { setMode("local"); S.ai.ready = true; softRender(); return; }
    c.use("sample").then((fn) => { S.ai.sample = fn || null; S.ai.ready = true; refreshAiUi(); softRender(); },
      () => { S.ai.ready = true; refreshAiUi(); softRender(); });
    let db = null, user = null;
    try { [db, user] = await Promise.all([c.use("db"), c.use("user")]); } catch { /* treated as absent */ }
    S.me.user = user;
    const uid = user ? await user.id().catch(() => null) : null;
    if (uid) claimLocal(uid);
    S.me.id = uid;
    if (user) user.can("data.write").then((v) => { S.me.canWrite = v; if (S.tab === "arena") render(); }, () => {});
    // Pro build is for the game's owner only. This hides the UI; every viewer gets the same page code.
    if (user) user.isOwner().then((v) => { S.me.owner = !!v; if (S.tab === "design") render(); }, () => {});
    if (db) startArena(db);
    if (!db || !uid) { setMode("local"); return; }
    S.store.coll = db.collection("data/users/" + uid);
    setMode("connecting");
    let snap;
    try { snap = await S.store.coll.get(); }   // may wait on a permission prompt; nothing else waits on it
    catch (e) { S.store.coll = null; setMode("local"); toast("Couldn't reach your account storage, so this device keeps your fighters."); return; }
    setMode("account");
    mergeRemote(snap.docs, true, null);
    S.store.coll.onSnapshot((qs) => mergeRemote(qs.docs, false, qs.docChanges()), () => {});
  }
  function setMode(m) { S.store.mode = m; renderStore(); }
  function renderStore() {
    const el = $("store"), st = S.store;
    const failed = Object.keys(st.failed).length;
    let text, cls = "store", clickable = false;
    if (failed) { text = "Not saved to your account. Retry"; cls += " err"; clickable = true; }
    else if (st.mode === "starting") text = "Starting…";
    else if (st.mode === "local") text = "Saved on this device";
    else if (st.mode === "connecting") { text = st.slow ? "Connecting… allow storage if asked" : "Connecting to your account…"; cls += " saving"; }
    else if (st.pending) { text = st.slow ? "Still saving… allow storage if asked" : "Saving…"; cls += " saving"; }
    else { text = "Saved to your account"; cls += " db"; }
    el.className = cls; el.textContent = text; el.disabled = !clickable;
  }
  $("store").addEventListener("click", retryFailed);

  // ---------- Cycles ----------
  const balance = () => ECON.balance(S.progress.wallet);
  function renderWallet() { const w = $("wallet"); if (w) w.textContent = `${balance()} Cycles`; }
  $("wallet").addEventListener("click", () => setTab("forge"));
  /** Pay for something. Returns true if paid; otherwise explains why and returns false. */
  function pay(amount, reason, ref) {
    try { S.progress.wallet = ECON.spend(S.progress.wallet, amount, reason, ref); saveProgress(); return true; }
    catch (e) { toast(e.message); return false; }
  }
  function earn(amount, reason, ref) {
    if (!(amount > 0)) return;
    S.progress.wallet = ECON.credit(S.progress.wallet, amount, reason, ref);
    saveProgress();
  }

  // ---------- arena data (shared, so every entry is validated) ----------
  function startArena(db) {
    S.arena.db = db;
    db.collection("arena").onSnapshot((qs) => {
      const docs = {}, raw = {};
      for (const d of qs.docs) {
        const data = d.data() || {};
        raw[d.id] = Array.isArray(data.fighters) ? E.clone(data.fighters).slice(0, ARENA_MAX) : [];
        docs[d.id] = raw[d.id].map((x) => E.sanitizePublic(x, d.id)).filter(Boolean);
      }
      S.arena.docs = docs; S.arena.raw = raw; S.arena.loaded = true; recomputeRatings();
      if (S.tab === "arena") render();
    }, (e) => { S.arena.error = (e && e.code) || "unavailable"; if (S.tab === "arena") render(); });
    db.collection("results").onSnapshot((qs) => {
      const res = {}, raw = {};
      for (const d of qs.docs) {
        const log = Array.isArray(d.data()?.log) ? E.clone(d.data().log).slice(-RESULTS_MAX) : [];
        raw[d.id] = log;
        res[d.id] = log.map((r) => E.sanitizeResult(r, d.id)).filter(Boolean);
      }
      S.arena.results = res; S.arena.resultsRaw = raw; recomputeRatings();
      if (S.tab === "arena") render();
    }, () => {});
  }
  function recomputeRatings() { S.arena.ratings = E.arenaRatings(Object.values(S.arena.results).flat()); }
  function myArenaList() { return S.me.id ? (S.arena.raw[S.me.id] || []) : []; }
  function canPublish() { return !!(S.arena.db && S.me.id && S.me.canWrite !== false); }
  function publish(f) {
    if (!canPublish()) return;
    const uid = S.me.id;
    const list = myArenaList().filter((p) => p.id !== f.id);
    if (list.length >= ARENA_MAX) { toast(`You can have ${ARENA_MAX} fighters in the arena. Remove one first.`); return; }
    list.push(E.toPublic(f));
    S.arena.raw[uid] = list; S.arena.docs[uid] = list.map((x) => E.sanitizePublic(x, uid)).filter(Boolean);
    enqueue("arena", () => S.arena.db.doc("arena/" + uid).set({ fighters: E.clone(S.arena.raw[uid]), updatedAt: Date.now() }));
    toast(`${f.name} is in the arena.`);
  }
  function unpublish(id) {
    if (!canPublish()) return;
    const uid = S.me.id;
    S.arena.raw[uid] = myArenaList().filter((p) => p.id !== id);
    S.arena.docs[uid] = S.arena.raw[uid].map((x) => E.sanitizePublic(x, uid)).filter(Boolean);
    enqueue("arena", () => S.arena.db.doc("arena/" + uid).set({ fighters: E.clone(S.arena.raw[uid]), updatedAt: Date.now() }));
  }
  function recordResult(b, match) {
    if (!S.arena.db || !S.me.id || S.me.canWrite === false) return false;
    const uid = S.me.id;
    const entry = { at: Date.now(), a: { owner: uid, id: b.me.id, name: b.me.name }, b: { owner: b.target.owner, id: b.foe.id, name: b.foe.name },
                    winner: match.winner, ko: match.ko, ai: b.useAi };
    const log = [...(S.arena.resultsRaw[uid] || []), entry].slice(-RESULTS_MAX);
    S.arena.resultsRaw[uid] = log;
    S.arena.results[uid] = log.map((r) => E.sanitizeResult(r, uid)).filter(Boolean);
    recomputeRatings();
    enqueue("results", () => S.arena.db.doc("results/" + uid).set({ log: E.clone(S.arena.resultsRaw[uid]) }));
    return true;
  }
  async function fillOwnerNames(root) {
    const spans = [...root.querySelectorAll("[data-owner]")];
    if (!spans.length) return;
    const ids = [...new Set(spans.map((s) => s.dataset.owner))];
    let ps = {};
    if (S.me.user) { try { ps = await S.me.user.profiles(ids); } catch { ps = {}; } }
    for (const s of spans) { const id = s.dataset.owner; s.textContent = id === S.me.id ? "you" : (ps[id] && ps[id].name) || "a player"; }
  }

  // ---------- toasts ----------
  let toastTimer = 0;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3600);
  }

  // ---------- sprites ----------
  function paintSprites(root) {
    for (const c of root.querySelectorAll("canvas[data-sprite]")) {
      const key = c.dataset.sprite;
      let who = null;
      if (key === "draft") who = { id: S.editingId || "draft-" + (S.draft?.name || ""), design: S.draft.design };
      else if (key.startsWith("p:")) who = partnerLook(key.slice(2));
      else if (key.startsWith("r:")) { const rv = E.RIVALS.find((x) => x.id === key.slice(2)); who = rv && { id: "rival-" + rv.id, design: rv.design }; }
      else if (key.startsWith("a:")) { const [owner, id] = key.slice(2).split("|"); who = (S.arena.docs[owner] || []).find((p) => p.id === id); }
      else who = find(key);
      if (who) SP.draw(c, who, { back: c.hasAttribute("data-back") });
    }
  }
  function partnerLook(id) {
    const p = E.PARTNERS.find((x) => x.id === id), me = active();
    if (p.kind === "mirror") return me ? { id: "mirror", design: { ...me.design, hue: (me.design.hue + 180) % 360 } } : { id: "mirror", design: {} };
    return { id: p.id, design: p.design };
  }

  // ---------- active fighter bar ----------
  function levelProgress(f) {
    if (f.level >= E.MAX_LEVEL) return 1;
    const a = E.xpForLevel(f.level), b = E.xpForLevel(f.level + 1);
    return (f.xp - a) / (b - a);
  }
  function renderActiveBar() {
    const f = active(), bar = $("active-bar");
    if (!f) { bar.innerHTML = ""; return; }
    const next = f.level >= E.MAX_LEVEL ? "Max level" : `${E.xpForLevel(f.level + 1) - f.xp} XP to level ${f.level + 1}`;
    const br = f.battleRecord || { w: 0, l: 0, d: 0 };
    const pts = E.unspentPoints(f);
    bar.innerHTML = `<div class="active">
      <canvas data-sprite="${esc(f.id)}" width="28" height="28" aria-hidden="true"></canvas>
      <div class="who"><span class="name">${esc(f.name)}</span>
        <span class="lv">LV ${f.level} · Battles ${br.w}W ${br.l}L ${br.d}D · ${next}${pts ? ` · <b class="pts-badge">${pts} stat point${pts > 1 ? "s" : ""} to spend</b>` : ""}</span>
        <span class="xpbar"><span style="width:${Math.round(levelProgress(f) * 100)}%"></span></span></div>
    </div>`;
    paintSprites(bar);
  }

  // ---------- tabs ----------
  function battleRunning() { return !!(S.battle && !S.battle.finished); }
  function setTab(tab) {
    if (tab === S.tab) return;
    if (battleRunning()) { stopBattle(); toast(S.battle && S.battle.kind === "spar" ? "Sparring stopped." : "Battle stopped. No XP was given."); }
    if (S.spar && tab !== "gym") S.spar = null;
    S.tab = tab;
    if (tab === "design" && !S.draft) openDesigner(S.activeId);
    if (tab === "forge" && !S.forge) resetForge();
    render();
    window.scrollTo({ top: 0 });
  }
  document.querySelector(".tabs").addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) setTab(b.dataset.tab); });
  function render() {
    for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t.dataset.tab === S.tab));
    renderActiveBar();
    renderWallet();
    const v = $("view");
    v.onclick = v.oninput = v.onchange = null;
    if (S.tab === "roster") renderRoster(v);
    else if (S.tab === "design") renderDesigner(v);
    else if (S.tab === "forge") renderForge(v);
    else if (S.tab === "gym") renderGym(v);
    else if (S.tab === "battle") renderBattle(v);
    else renderArena(v);
  }
  // Re-render after background data arrives, without disturbing typing or a battle in progress.
  function softRender() {
    renderActiveBar();
    renderWallet();
    if (S.tab === "design" || S.tab === "battle" || S.tab === "forge" || (S.tab === "gym" && S.spar)) return;
    render();
  }
  const seg = (field, value, options) => `<div class="seg" role="group">${options.map(([val, label]) =>
    `<button type="button" data-seg="${field}" data-val="${esc(val)}" aria-pressed="${String(val) === String(value)}">${label}</button>`).join("")}</div>`;

  // ---------- roster ----------
  function renderRoster(v) {
    const published = new Set(myArenaList().map((p) => p.id));
    const cards = S.fighters.map((f) => `<button class="card" type="button" data-pick="${esc(f.id)}" aria-pressed="${f.id === S.activeId}">
        <canvas data-sprite="${esc(f.id)}" width="28" height="28" aria-hidden="true"></canvas>
        <span class="name">${esc(f.name)}</span>
        <span class="lv">LV ${f.level}${published.has(f.id) ? " · IN ARENA" : ""}</span>
        <span class="small muted">${f.moves.map((m) => esc(skillName(f, m))).join(" · ")}</span>
      </button>`).join("");
    v.innerHTML = `<div class="box">
      <h2>Your fighters</h2>
      <p class="note">${S.fighters.length ? "Tap a fighter to make it active for the Gym, Battle and Arena." : "No fighters yet. Design your first one."}</p>
      <div class="cards">${cards}<button class="card new" type="button" data-new><b>+</b><span>New fighter</span></button></div>
    </div>
    <div class="box"><h2>How it works</h2>
      <p class="small" style="margin:0">Each fighter is an AI agent. In a battle, Claude picks every action for both sides, guided by each fighter's
      persona, playbook, battle rules and the instincts it built in the gym. Skills cost energy and can burn, stun, shield or heal.
      Forge your own skills in the <b>Forge</b>, train in the <b>Gym</b>, climb the rival ladder in <b>Battle</b>, and take on other players in the <b>Arena</b>.
      Winning earns Cycles, which buy gym time, compute, skills and items.</p></div>`;
    paintSprites(v);
    v.onclick = (e) => {
      const pick = e.target.closest("[data-pick]");
      if (pick) { S.activeId = pick.dataset.pick; S.report = null; S.draft = null; saveLocal(); render(); return; }
      if (e.target.closest("[data-new]")) { openDesigner(null); S.tab = "design"; render(); }
    };
  }

  // ---------- designer ----------
  function randomDesign() {
    const r = Math.random;
    return { hue: Math.floor(r() * 360), accent: Math.floor(r() * 360), body: ["round", "tall", "wide"][Math.floor(r() * 3)],
             size: Math.round((0.35 + r() * 0.55) * 100) / 100, spikes: Math.floor(r() * 4), armor: r() < 0.35,
             eyes: ["round", "angry", "visor"][Math.floor(r() * 3)], pattern: ["plain", "spots", "stripes"][Math.floor(r() * 3)] };
  }
  function openDesigner(id) {
    const f = id && find(id);
    S.editingId = f ? f.id : null;
    S.confirmDelete = false;
    S.draft = f ? { name: f.name, design: { ...f.design }, personality: { ...f.personality }, moves: f.moves.slice(), custom: E.clone(f.custom || {}),
                    persona: f.persona || "", playbook: f.playbook || "", passive: f.passive ? E.clone(f.passive) : null, item: f.item || null,
                    stats: { ...E.statsOf(f) }, savedStats: { ...E.statsOf(f) }, respec: false, rules: E.clone(f.rules || []), level: f.level }
      : { name: NAMES[Math.floor(Math.random() * NAMES.length)], design: randomDesign(), custom: {},
          personality: { aggression: 0.6, caution: 0.5, creativity: 0.5, loyalty: 0.4 }, moves: ["fight", "talk", "strategize", "shield"],
          persona: "Reads the opponent for a turn, then hits the counter hard. Saves energy for big moves in the endgame.", playbook: "",
          passive: null, item: null, stats: { power: 0, vitality: 0, speed: 0 }, savedStats: { power: 0, vitality: 0, speed: 0 }, respec: false, rules: [], level: 1 };
  }
  const TRAIT_HELP = { aggression: "Starts out favoring Aggro skills.", caution: "Starts out favoring Guard skills.", creativity: "Starts out favoring Mind skills.", loyalty: "Starts out favoring Social skills." };
  /** Every skill the draft could equip: basics, then library skills (with whether the level allows them). */
  function skillPool(d) {
    const pool = E.SKILL_NAMES.map((id) => ({ id, skill: E.BASIC[id], ok: true }));
    for (const s of S.progress.library) if (s.kind === "active") pool.push({ id: s.id, skill: s, ok: s.budget <= E.maxSkillBudget(d.level), custom: true });
    for (const [id, s] of Object.entries(d.custom || {})) if (!pool.some((p) => p.id === id)) pool.push({ id, skill: s, ok: true, custom: true });
    return pool;
  }
  function coverageNote(d) {
    const probe = { custom: d.custom };
    const have = new Set(d.moves.map((m) => E.skillOf(probe, m)?.style));
    const missing = E.STYLES.filter((s) => !have.has(s));
    if (!missing.length) return `<p class="note">Covers all four styles, so it can counter anything.</p>`;
    return `<p class="warn">${missing.map((s) => `No ${E.STYLE_INFO[s].label} skill: nothing counters ${E.STYLE_INFO[E.BEATS[s]].label}.`).join(" ")}</p>`;
  }
  function slotHtml(d, i, pool) {
    const cur = d.moves[i];
    const opts = (group, list) => list.length ? `<optgroup label="${group}">${list.map((p) => `<option value="${esc(p.id)}" ${p.id === cur ? "selected" : ""} ${(!p.ok || (d.moves.includes(p.id) && p.id !== cur)) ? "disabled" : ""}>${esc(p.skill.name)} · ${E.STYLE_INFO[p.skill.style].label} · ${p.skill.energy}E${p.ok ? "" : " (needs a higher level)"}</option>`).join("")}</optgroup>` : "";
    const sk = E.skillOf({ custom: d.custom }, cur);
    return `<div class="slot" style="--c:${STYLE_VAR[sk.style]}"><label class="lab" for="slot-${i}">Slot ${i + 1}</label>
      <select id="slot-${i}" data-slot="${i}">${opts("Basic", pool.filter((p) => !p.custom))}${opts("Your skills", pool.filter((p) => p.custom))}</select>
      <span class="note">${esc(E.describeSkill(sk))}</span></div>`;
  }
  function passiveOptions(d) {
    const list = [...E.STARTER_PASSIVES.map((p) => ({ p, starter: true })), ...S.progress.library.filter((s) => s.kind === "passive").map((p) => ({ p }))];
    const cur = d.passive ? d.passive.id : "";
    return `<option value="">None</option>` + list.map(({ p, starter }) => {
      const ok = p.budget <= E.maxPassiveBudget(d.level);
      return `<option value="${esc(p.id)}" ${p.id === cur ? "selected" : ""} ${ok ? "" : "disabled"}>${esc(p.name)}${starter ? " (starter)" : ""}${ok ? "" : " (needs a higher level)"}</option>`;
    }).join("");
  }
  function ruleRowHtml(rule, i, d) {
    const conds = Object.entries(E.RULE_CONDITIONS).map(([k, c]) => `<option value="${k}" ${k === rule.when.kind ? "selected" : ""}>${esc(c.label)}</option>`).join("");
    const def = E.RULE_CONDITIONS[rule.when.kind];
    const val = typeof def.value[0] === "string"
      ? `<select data-rule-val="${i}" aria-label="Value">${def.value.map((x) => `<option value="${x}" ${x === rule.when.value ? "selected" : ""}>${rule.when.kind === "their_last_style" ? E.STYLE_INFO[x].label : x}</option>`).join("")}</select>`
      : `<input type="number" data-rule-val="${i}" min="${def.value[0]}" max="${def.value[1]}" step="${def.value[2]}" value="${rule.when.value}" aria-label="Value">${def.unit ? `<span class="small">${def.unit}</span>` : ""}`;
    const actKey = rule.do.item ? "item" : rule.do.skill;
    const acts = d.moves.map((m) => `<option value="${esc(m)}" ${m === actKey ? "selected" : ""}>use ${esc(E.skillOf({ custom: d.custom }, m).name)}</option>`).join("")
      + `<option value="item" ${actKey === "item" ? "selected" : ""}>use my item</option>`;
    return `<div class="rule"><span class="small">If</span><select data-rule-cond="${i}" aria-label="Condition">${conds}</select>${val}
      <span class="small">then</span><select data-rule-act="${i}" aria-label="Action">${acts}</select>
      <button class="btn icon" type="button" data-rule-del="${i}" aria-label="Remove rule">×</button></div>`;
  }
  function renderDesigner(v) {
    const d = S.draft, editing = S.editingId && find(S.editingId);
    const pool = skillPool(d);
    const points = E.statPointsFor(d.level), used = d.stats.power + d.stats.vitality + d.stats.speed;
    const inv = S.progress.inventory;
    const itemOpts = `<option value="">None</option>` + Object.values(E.ITEMS).map((it) => `<option value="${it.id}" ${d.item === it.id ? "selected" : ""} ${inv[it.id] > 0 || d.item === it.id ? "" : "disabled"}>${it.name} · own ${inv[it.id] || 0}</option>`).join("");
    const statRow = (k, label, help) => `<div class="stat-row"><span><b>${label}</b> <span class="note">${help}</span></span>
      <span class="stepper"><button class="btn icon" type="button" data-stat="${k}" data-d="-1" aria-label="Less ${label}" ${d.stats[k] <= (d.respec ? 0 : d.savedStats[k]) ? "disabled" : ""}>−</button>
      <b class="num">${d.stats[k]}</b><button class="btn icon" type="button" data-stat="${k}" data-d="1" aria-label="More ${label}" ${used >= points ? "disabled" : ""}>+</button></span></div>`;
    const canSave = d.name.trim() && new Set(d.moves).size === 4;
    v.innerHTML = `<div class="two">
      <div class="box">
        <h2>${editing ? "Edit fighter" : "New fighter"}</h2>
        <div class="stage"><div class="pad"></div><canvas data-sprite="draft" width="28" height="28" role="img" aria-label="Preview"></canvas></div>
        <div class="row"><button class="btn" type="button" id="randomize">Randomize look</button></div>
        ${!S.fighters.length ? `<p class="note">A starting design. Change anything, then create your fighter.</p>` : ""}
      </div>
      <div class="panel">
        ${editing && S.me.owner && OPT ? `<div class="box pro" id="pro-box">${proBoxHtml(editing)}</div>` : ""}
        <div class="box"><div class="field"><label for="f-name">Name</label>
          <input type="text" id="f-name" maxlength="16" value="${esc(d.name)}" autocomplete="off" spellcheck="false"></div></div>
        <div class="box">
          <h2>Loadout</h2>
          <p class="note">Four skills. Each style beats the next: Aggro → Social → Mind → Guard → Aggro. Forge new skills in the Forge tab.</p>
          <div class="slots">${[0, 1, 2, 3].map((i) => slotHtml(d, i, pool)).join("")}</div>
          ${coverageNote(d)}
          <div class="grid2">
            <div class="field"><label class="lab" for="f-passive">Passive</label><select id="f-passive">${passiveOptions(d)}</select>
              <span class="note">${d.passive ? esc(E.describeSkill(d.passive)) : "Always-on bonus, like regenerating HP. Starters are free."}</span></div>
            <div class="field"><label class="lab" for="f-item">Item (one use per battle)</label><select id="f-item">${itemOpts}</select>
              <span class="note">${d.item ? esc(E.ITEMS[d.item].blurb) : "Buy items in the Forge tab."} Using it takes your turn but acts first.</span></div>
          </div>
        </div>
        <div class="box">
          <h2>Battle rules · ${d.rules.length} of ${E.MAX_RULES}</h2>
          <p class="note">If-then rules your fighter always follows, before Claude or instincts decide. They also save Claude requests.</p>
          <div class="rules">${d.rules.map((r, i) => ruleRowHtml(r, i, d)).join("") || `<p class="note">No rules yet. Example: if my HP is below 30%, use my item.</p>`}</div>
          ${d.rules.length < E.MAX_RULES ? `<div class="row"><button class="btn" type="button" id="add-rule">Add rule</button></div>` : ""}
        </div>
        ${editing ? `<div class="box">
          <h2>Stats · ${points - used} of ${points} points free</h2>
          <p class="note">You get a point every level. Moving points you've already spent needs a reset (${ECON.PRICES.respec} Cycles).</p>
          ${statRow("power", "Power", `+${Math.round(E.STAT_PCT.power * 100)}% damage`)}${statRow("vitality", "Vitality", `+${Math.round(E.STAT_PCT.vitality * 100)}% max HP`)}${statRow("speed", "Speed", `+${Math.round(E.STAT_PCT.speed * 100)}% dodge (max ${Math.round(E.STAT_PCT.dodgeCap * 100)}%), acts first on ties`)}
          ${!d.respec && (d.savedStats.power + d.savedStats.vitality + d.savedStats.speed) > 0 ? `<div class="row"><button class="btn" type="button" id="respec">Reset points · ${ECON.PRICES.respec} Cycles</button></div>` : ""}
        </div>` : ""}
        <div class="box">
          <h2>Mind</h2>
          <div class="field"><label for="f-persona">Persona: how your fighter thinks</label>
            <textarea id="f-persona" maxlength="${E.PERSONA_MAX}" rows="3">${esc(d.persona)}</textarea>
            <span class="count" id="c-persona">${d.persona.length} / ${E.PERSONA_MAX}</span></div>
          <div class="field"><label for="f-playbook">Playbook: lessons from training</label>
            <textarea id="f-playbook" maxlength="${E.PLAYBOOK_MAX}" rows="5" placeholder="Your coach writes this. You can edit it too.">${esc(d.playbook)}</textarea>
            <span class="count" id="c-playbook">${d.playbook.length} / ${E.PLAYBOOK_MAX}</span></div>
          <p class="note">Claude reads both before every action your fighter takes.</p>
        </div>
        <div class="box">
          <h2>Look</h2>
          <div class="grid2">
            <div class="field"><span class="lab">Color</span><div class="hue"><span class="swatch" style="background:hsl(${d.design.hue} 60% 56%)"></span>
              <input type="range" id="f-hue" min="0" max="359" value="${d.design.hue}" aria-label="Body color"></div></div>
            <div class="field"><span class="lab">Accent</span><div class="hue"><span class="swatch" style="background:hsl(${d.design.accent} 70% 58%)"></span>
              <input type="range" id="f-accent" min="0" max="359" value="${d.design.accent}" aria-label="Accent color"></div></div>
            <div class="field"><span class="lab">Size</span><input type="range" id="f-size" min="0" max="1" step="0.05" value="${d.design.size}" aria-label="Size"></div>
            <div class="field"><span class="lab">Body</span>${seg("body", d.design.body, [["round", "Round"], ["tall", "Tall"], ["wide", "Wide"]])}</div>
            <div class="field"><span class="lab">Spikes</span>${seg("spikes", d.design.spikes, [[0, "None"], [1, "1"], [2, "2"], [3, "3"]])}</div>
            <div class="field"><span class="lab">Eyes</span>${seg("eyes", d.design.eyes, [["round", "Round"], ["angry", "Fierce"], ["visor", "Visor"]])}</div>
            <div class="field"><span class="lab">Pattern</span>${seg("pattern", d.design.pattern, [["plain", "Plain"], ["spots", "Spots"], ["stripes", "Stripes"]])}</div>
            <div class="field"><span class="lab">Armor</span>${seg("armor", d.design.armor, [[false, "Off"], [true, "Plated"]])}</div>
          </div>
        </div>
        <div class="box">
          <h2>Starting instincts</h2>
          <div class="grid2">${E.TRAITS.map((t) => `<div class="trait">
            <div class="top-line"><label for="t-${t}">${t[0].toUpperCase() + t.slice(1)}</label><b id="tv-${t}">${Math.round(d.personality[t] * 100)}</b></div>
            <input type="range" id="t-${t}" data-trait="${t}" min="0" max="1" step="0.05" value="${d.personality[t]}">
            <span class="note">${TRAIT_HELP[t]}</span></div>`).join("")}</div>
        </div>
        <div class="box">
          <div class="row">
            <button class="btn primary" type="button" id="save" ${canSave ? "" : "disabled"}>${editing ? "Save changes" : "Create fighter"}</button>
            ${editing ? (S.confirmDelete
              ? `<span class="small">Delete ${esc(editing.name)} and all its training?</span><button class="btn danger" type="button" id="del-yes">Delete</button><button class="btn" type="button" id="del-no">Keep</button>`
              : `<button class="btn danger" type="button" id="del">Delete fighter</button>`) : ""}
          </div>
          <div class="field"><span class="lab">Register this design on aipvp</span>
            <div class="code"><pre id="cmd">${esc(E.aipvpCommand({ name: d.name || "FIGHTER", moves: d.moves, custom: d.custom, personality: d.personality }))}</pre><button class="btn" type="button" id="copy">Copy</button></div>
            <span class="note">aipvp.io has its own skills, so forged skills map to the closest basic one there. Training stays in Fighter Lab.</span></div>
        </div>
      </div>
    </div>`;
    paintSprites(v);
    bindDesigner(v);
  }
  function refreshPreview(v) {
    const c = v.querySelector('canvas[data-sprite="draft"]');
    if (c) SP.draw(c, { id: S.editingId || "draft-" + S.draft.name, design: S.draft.design });
  }
  function bindDesigner(v) {
    const d = S.draft;
    const rerender = () => { const y = window.scrollY; renderDesigner(v); window.scrollTo({ top: y }); };
    v.onclick = async (e) => {
      const sg = e.target.closest("[data-seg]");
      if (sg) {
        const f = sg.dataset.seg, raw = sg.dataset.val;
        d.design[f] = f === "spikes" ? +raw : f === "armor" ? raw === "true" : raw;
        for (const b of sg.parentElement.children) b.setAttribute("aria-pressed", String(b === sg));
        refreshPreview(v); return;
      }
      const st = e.target.closest("[data-stat]");
      if (st) { d.stats[st.dataset.stat] = Math.max(0, d.stats[st.dataset.stat] + Number(st.dataset.d)); rerender(); return; }
      const del = e.target.closest("[data-rule-del]");
      if (del) { d.rules.splice(+del.dataset.ruleDel, 1); rerender(); return; }
      const id = e.target.id;
      if (id === "add-rule") { d.rules.push({ when: { kind: "my_hp_below", value: 30 }, do: d.item ? { item: true } : { skill: d.moves[0] } }); rerender(); return; }
      if (id === "respec") {
        if (pay(ECON.PRICES.respec, `Stat reset for ${d.name}`)) { d.respec = true; d.stats = { power: 0, vitality: 0, speed: 0 }; toast("Points reset. Spend them again, then save."); rerender(); }
        return;
      }
      if (id === "randomize") { d.design = randomDesign(); rerender(); return; }
      if (id === "copy") {
        try { await navigator.clipboard.writeText($("cmd").textContent); toast("Copied."); }
        catch { const r = document.createRange(); r.selectNodeContents($("cmd")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast("Selected. Copy it from here."); }
        return;
      }
      if (id === "del") { S.confirmDelete = true; rerender(); return; }
      if (id === "del-no") { S.confirmDelete = false; rerender(); return; }
      if (id === "del-yes") {
        const name = find(S.editingId)?.name;
        deleteFighter(S.editingId);
        S.draft = null; S.editingId = null; S.tab = "roster"; render(); toast(`${name} deleted.`); return;
      }
      if (id === "save") saveDesign();
      if (id === "pro-run") runPro();
      if (id === "pro-cancel") { if (S.pro.ctl) S.pro.ctl.abort(); }
      if (id === "pro-again") { S.pro = { ...S.pro, status: "idle", result: null, mind: null }; renderProBox(); }
      if (id === "pro-apply") { applyPro(); rerender(); }
      if (id === "pro-mind") await proMind(rerender);
    };
    v.onchange = (e) => {
      const t = e.target;
      if (t.dataset.slot !== undefined) {
        const i = +t.dataset.slot, val = t.value;
        const lib = S.progress.library.find((s) => s.id === val);
        if (lib) d.custom[val] = E.clone(lib);
        const old = d.moves[i];
        d.moves[i] = val;
        d.rules = d.rules.map((r) => (r.do.skill === old ? { ...r, do: { skill: val } } : r));
        rerender(); return;
      }
      if (t.id === "f-passive") {
        d.passive = t.value ? E.clone([...E.STARTER_PASSIVES, ...S.progress.library].find((p) => p.id === t.value)) : null;
        rerender(); return;
      }
      if (t.id === "f-item") { d.item = t.value || null; rerender(); return; }
      if (t.dataset.ruleCond !== undefined) {
        const r = d.rules[+t.dataset.ruleCond], def = E.RULE_CONDITIONS[t.value];
        r.when = { kind: t.value, value: def.value[0] === undefined ? 0 : typeof def.value[0] === "string" ? def.value[0] : Math.round((def.value[0] + def.value[1]) / 2 / def.value[2]) * def.value[2] };
        rerender(); return;
      }
      if (t.dataset.ruleVal !== undefined) { const r = d.rules[+t.dataset.ruleVal]; r.when.value = typeof E.RULE_CONDITIONS[r.when.kind].value[0] === "string" ? t.value : Number(t.value); return; }
      if (t.dataset.ruleAct !== undefined) { d.rules[+t.dataset.ruleAct].do = t.value === "item" ? { item: true } : { skill: t.value }; return; }
      if (t.dataset.trait || t.id === "f-name") { const pre = $("cmd"); if (pre) pre.textContent = E.aipvpCommand({ name: d.name || "FIGHTER", moves: d.moves, custom: d.custom, personality: d.personality }); }
    };
    v.oninput = (e) => {
      const t = e.target;
      if (t.id === "f-name") {
        d.name = t.value.toUpperCase().replace(/[^A-Z0-9 '\-]/g, "");
        if (t.value !== d.name) t.value = d.name;
        $("save").disabled = !d.name.trim(); return;
      }
      if (t.id === "f-persona" || t.id === "f-playbook") {
        const key = t.id === "f-persona" ? "persona" : "playbook";
        d[key] = t.value; $("c-" + key).textContent = `${t.value.length} / ${key === "persona" ? E.PERSONA_MAX : E.PLAYBOOK_MAX}`; return;
      }
      if (t.id === "f-hue" || t.id === "f-accent") {
        d.design[t.id === "f-hue" ? "hue" : "accent"] = +t.value;
        t.previousElementSibling.style.background = t.id === "f-hue" ? `hsl(${t.value} 60% 56%)` : `hsl(${t.value} 70% 58%)`;
        refreshPreview(v); return;
      }
      if (t.id === "f-size") { d.design.size = +t.value; refreshPreview(v); return; }
      if (t.dataset.trait) { d.personality[t.dataset.trait] = +t.value; $("tv-" + t.dataset.trait).textContent = Math.round(t.value * 100); }
    };
  }
  // ---------- Pro build (owner only): the optimizer designs the best fair build ----------
  const pct = (x) => `${Math.round(x * 100)}%`;
  function proProbe(b) { return { custom: Object.fromEntries(b.skills.filter(Boolean).map((sk) => [sk.id, sk])), item: b.item }; }
  function proBoxHtml(f) {
    const P = S.pro, mine = P.forId === f.id;
    const head = `<h2>Pro build · owner only</h2>`;
    if (mine && P.status === "running") {
      return `${head}<p class="small" style="margin:0"><span id="pro-label">${esc(P.label || "Starting")}</span> · <span id="pro-pct">${pct(P.frac)}</span></p>
        <div class="meter"><span id="pro-bar" style="width:${Math.round(P.frac * 100)}%"></span></div>
        <div class="row"><button class="btn" type="button" id="pro-cancel">Cancel</button></div>`;
    }
    if (mine && P.status === "done" && P.result) return head + proResultHtml(P.result);
    return `${head}<p class="note" style="margin:0">Your AI simulates thousands of battles to find the strongest build ${esc(f.name)} can legally use at level ${f.level} with your ${balance()} Cycles: skills to forge, passive, item, stats and battle rules. It tests against your next rivals, the gym, arena fighters and a field of likely player builds. Takes about 20 seconds and uses no Claude.${aiUsable() ? ` It keeps ${ECON.PRICES.coach} Cycles aside so Claude can write the build's mind afterwards.` : ""}</p>
      ${mine && P.error ? `<p class="warn" style="margin:0">${esc(P.error)}</p>` : ""}
      <div class="row"><button class="btn primary" type="button" id="pro-run">Find the best build</button></div>`;
  }
  function proResultHtml(r) {
    const b = r.build, probe = proProbe(b), s = r.score, base = r.baseline;
    const afford = b.cost <= balance();
    const skills = b.moves.map((m, i) => {
      const sk = b.skills[i] || E.BASIC[m], fx = b.forge.find((x) => x.ref === m);
      return `<li style="--c:${STYLE_VAR[sk.style]}"><b>${esc(sk.name)}</b> <span class="tag">${E.STYLE_INFO[sk.style].label.toUpperCase()}</span>${fx ? ` <span class="tag next">FORGE · ${fx.cost}</span>` : ""}<span class="note">${esc(E.describeSkill(sk))}</span></li>`;
    }).join("");
    const pf = b.passive && b.forge.find((x) => x.ref === b.passive.id);
    const rows = [
      ...s.rivals.map((x, i) => [`vs ${x.label}`, x.rate, (base.rivals[i] || {}).rate]),
      ["vs gym partners", avg(s.partners), avg(base.partners)],
      ...(s.arena.length ? [["vs arena fighters", avg(s.arena), avg(base.arena)]] : []),
      ["vs likely player builds", s.field, base.field],
    ];
    const rates = rows.map(([label, now, was]) => `<li><span>${esc(label)}</span><b>${pct(now)}</b><span class="note">${was === undefined || was === null ? "" : `now ${pct(was)}`}</span></li>`).join("");
    const path = r.path.map((p) => `<li><b>Level ${p.level}</b> (power limit ${p.cap}): ${p.forge.length ? p.forge.map((x) => x.upgrade ? `re-forge ${esc(x.name)} stronger (${x.was} → ${x.budget}, ${x.cost} Cycles)` : `forge ${esc(x.name)} to replace ${esc(x.replaces)} (${x.cost} Cycles)`).join("; ") : "keep the build"}. Stats ${p.stats.power}/${p.stats.vitality}/${p.stats.speed}. Aim for ${esc(p.rival)}.</li>`).join("");
    const mind = S.pro.mind;
    return `<div class="outcome">Score ${Math.round(s.overall * 100)} <span class="note">vs ${Math.round(base.overall * 100)} with the current build</span></div>
      ${r.keptCurrent ? `<p class="small" style="margin:0">Your current build is already the best one found. Nothing to change.</p>` : ""}
      <ul class="pro-skills">${skills}</ul>
      <p class="small" style="margin:0"><b>Passive:</b> ${b.passive ? `${esc(b.passive.name)}${pf ? ` <span class="tag next">FORGE · ${pf.cost}</span>` : ""} · ${esc(E.describeSkill(b.passive).replace(/^Passive: /, ""))}` : "none"}
        · <b>Item:</b> ${b.item ? `${E.ITEMS[b.item].name}${b.buyItem ? ` (buy · ${ECON.itemPrice(b.item)})` : " (owned)"}` : "none"}
        · <b>Stats:</b> ${b.stats.power} Power, ${b.stats.vitality} Vitality, ${b.stats.speed} Speed${b.respec ? ` (needs a reset · ${ECON.PRICES.respec})` : ""}</p>
      ${b.rules.length ? `<p class="small" style="margin:0"><b>Rules:</b> ${b.rules.map((rl) => esc(E.describeRule(rl, probe))).join(" ")}</p>` : ""}
      <ul class="pro-rates">${rates}</ul>
      <ul class="pro-why">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <p class="small" style="margin:0"><b>Training:</b> ${r.training.map((t) => esc(t.tip)).join(" ")}</p>
      ${r.saveUpFor ? `<p class="small" style="margin:0"><b>Save up for:</b> ${r.saveUpFor.build.names.map(esc).join(", ")} (${r.saveUpFor.build.cost} Cycles, score ${Math.round(r.saveUpFor.score.overall * 100)}).</p>` : ""}
      ${path ? `<div><span class="lab">Level-up path</span><ul class="pro-path">${path}</ul></div>` : ""}
      ${mind && mind.comment ? `<p class="small" style="margin:0"><b>Claude:</b> ${esc(mind.comment)}</p>` : ""}
      ${mind && mind.error ? `<p class="warn" style="margin:0">${esc(mind.error)}</p>` : ""}
      <div class="row">
        ${r.keptCurrent ? "" : `<button class="btn primary" type="button" id="pro-apply" ${afford && !S.pro.applied ? "" : "disabled"}>${S.pro.applied ? "Applied: review and Save" : `Apply to draft · ${b.cost} Cycles`}</button>`}
        <button class="btn" type="button" id="pro-mind" ${aiUsable() && !(mind && mind.busy) ? "" : "disabled"}>${mind && mind.busy ? "Writing…" : `Write its mind with Claude · ${ECON.PRICES.coach} Cycles`}</button>
        <button class="btn" type="button" id="pro-again">Run again</button>
      </div>
      ${afford || r.keptCurrent ? "" : `<p class="warn" style="margin:0">You need ${b.cost} Cycles; you have ${balance()}.</p>`}`;
  }
  const avg = (xs) => (xs.length ? xs.reduce((a, x) => a + x.rate, 0) / xs.length : 0);
  function renderProBox() { const box = $("pro-box"), f = S.editingId && find(S.editingId); if (box && f) box.innerHTML = proBoxHtml(f); }
  async function runPro() {
    const f = S.editingId && find(S.editingId);
    if (!f || S.pro.status === "running") return;
    const ctl = new AbortController();
    S.pro = { status: "running", forId: f.id, frac: 0, label: "Starting", result: null, error: "", ctl, mind: null, applied: false };
    renderProBox();
    const arena = [];
    for (const [owner, list] of Object.entries(S.arena.docs || {})) if (owner !== S.me.id) arena.push(...list);
    let last = 0;
    try {
      const result = await OPT.optimize({
        // keep enough for Claude to write the build's mind afterwards
        fighter: f, library: S.progress.library, inventory: S.progress.inventory, balance: Math.max(0, balance() - (aiUsable() ? ECON.PRICES.coach : 0)), beaten: S.progress.beaten,
        arena, seed: E.hash(`${f.id}:${f.rev || 0}`), signal: ctl.signal,
        onProgress: (frac, label) => {
          S.pro.frac = frac; S.pro.label = label;
          const now = Date.now(); if (now - last < 120 && frac < 1) return; last = now;
          const bar = $("pro-bar"), lab = $("pro-label"), pc = $("pro-pct");
          if (bar) bar.style.width = Math.round(frac * 100) + "%"; if (lab) lab.textContent = label; if (pc) pc.textContent = pct(frac);
        },
      });
      S.pro = { ...S.pro, status: "done", result, ctl: null };
    } catch (e) {
      S.pro = { ...S.pro, status: "idle", ctl: null, error: e && e.code === "cancelled" ? "Cancelled." : "The search failed. Try again." };
      if (!(e && e.code === "cancelled")) console.error(e);
    }
    renderProBox();
  }
  /** Forge, buy and pay for the build, then load it into the draft. The player still presses Save. */
  function applyPro() {
    const r = S.pro.result, d = S.draft, f = S.editingId && find(S.editingId);
    if (!r || !d || !f || S.pro.applied || S.pro.forId !== f.id) return;
    const b = r.build;
    if (b.cost > balance()) { toast(`This build costs ${b.cost} Cycles; you have ${balance()}.`); return; }
    if (S.progress.library.length + b.forge.length > LIBRARY_MAX) { toast(`Your library holds ${LIBRARY_MAX} skills. Delete some first.`); return; }
    const ids = {};
    for (const x of b.forge) {
      if (!pay(x.cost, `Forged ${x.skill.name}`)) return;
      const skill = { ...E.clone(x.skill), id: E.newId(Math.random, "sk_") };
      ids[x.ref] = skill.id;
      S.progress.library.push(skill);
    }
    if (b.buyItem) { if (!pay(ECON.itemPrice(b.item), `Bought ${E.ITEMS[b.item].name}`)) return; S.progress.inventory[b.item] = (S.progress.inventory[b.item] || 0) + 1; }
    if (b.respec) { if (!pay(ECON.PRICES.respec, `Stat reset for ${d.name}`)) return; d.respec = true; }
    const id = (m) => ids[m] || m;
    d.moves = b.moves.map(id);
    d.custom = {};
    b.moves.forEach((m, i) => {
      const sk = b.skills[i];
      if (!sk) return;
      const lib = S.progress.library.find((s) => s.id === id(m));
      d.custom[id(m)] = E.clone(lib || { ...sk, id: id(m) });
    });
    d.passive = b.passive ? E.clone({ ...b.passive, id: id(b.passive.id) }) : null;
    d.item = b.item;
    d.stats = { ...b.stats };
    d.rules = b.rules.map((rl) => (rl.do.skill ? { ...rl, do: { skill: id(rl.do.skill) } } : E.clone(rl)));
    if (S.pro.mind && S.pro.mind.persona) { d.persona = S.pro.mind.persona; d.playbook = S.pro.mind.playbook; }
    S.pro.applied = true;
    saveProgress();
    toast("Pro build loaded into the draft. Review it, then press Save.");
  }
  async function proMind(rerender) {
    const r = S.pro.result, f = S.editingId && find(S.editingId), d = S.draft;
    if (!r || !f || !d || (S.pro.mind && S.pro.mind.busy)) return;
    if (!aiUsable()) { toast("This needs Claude, which isn't available right now."); return; }
    if (!pay(ECON.PRICES.coach, `Pro build mind for ${f.name}`)) return;
    S.pro.mind = { busy: true };
    renderProBox();
    const b = r.build, custom = {};
    b.moves.forEach((m, i) => { if (b.skills[i]) custom[m] = b.skills[i]; });
    let preview = E.redesign(f, { moves: b.moves, custom, passive: b.passive, item: b.item });
    preview = E.setStats({ ...preview, stats: { power: 0, vitality: 0, speed: 0 } }, b.stats);
    preview.rules = E.sanitizeRules(b.rules, preview.moves);
    try {
      const out = await A.writeMind(S.ai.sample, preview, r);
      S.pro.mind = { ...out, busy: false };
      d.persona = out.persona; d.playbook = out.playbook;
      toast("Persona and playbook written into the draft.");
    } catch (e) {
      noteAiError(e && e.code);
      earn(ECON.PRICES.coach, "Refund: Pro build mind failed");
      S.pro.mind = { busy: false, error: "Claude couldn't write it this time. You weren't charged." };
    }
    if (S.tab === "design" && S.draft === d) rerender(); else renderProBox();
  }

  function saveDesign() {
    const d = S.draft, name = d.name.trim().toUpperCase();
    try {
      const editing = S.editingId && find(S.editingId);
      let f = editing
        ? E.redesign(editing, { name, design: d.design, personality: d.personality, moves: d.moves, custom: d.custom, passive: d.passive, item: d.item })
        : E.upgradeFighter(E.createFighter({ name, design: d.design, personality: d.personality, moves: d.moves, custom: d.custom, passive: d.passive, item: d.item }));
      if (editing) f = E.setStats(f, d.stats);
      f.rules = E.sanitizeRules(d.rules, f.moves);
      f.persona = E.cleanText(d.persona, E.PERSONA_MAX, false);
      f.playbook = E.cleanText(d.playbook, E.PLAYBOOK_MAX, true);
      f = saveFighter(f);              // returns at once; the account copy saves in the background
      S.activeId = f.id; S.draft = null; S.editingId = null; S.report = null; saveLocal();
      toast(editing ? "Saved." : `${f.name} is ready. Take it to the Gym.`);
      S.tab = editing ? "roster" : "gym"; render();
    } catch (err) { toast(err.message); }
  }

  // ---------- forge: build or describe a skill; wallet; library; shop ----------
  function forgeLevel() { return active()?.level || 1; }
  function resetForge(kind = "active") {
    // Defaults are the two examples from the design brief: a fireball that burns, and a passive that heals every two turns.
    S.forge = { mode: "build", kind, name: kind === "passive" ? "LIFE BLOOM" : "FIREBALL", style: kind === "passive" ? "guard" : "aggro", element: kind === "passive" ? "spirit" : "fire",
                effects: kind === "passive" ? [{ type: "regen", heal: 1, every: 2 }] : [{ type: "damage", power: 3, hits: 1 }, { type: "burn", chance: 0.3, damage: 2, turns: 3 }],
                cheaper: 0, desc: "", why: "", note: "", busy: false };
  }
  /** Fill parameters a skill file left out (damage without "hits" means one hit) so every slider has a value. */
  function withDefaults(e, kind) {
    const def = (kind === "passive" ? E.PASSIVE_EFFECTS : E.EFFECTS)[e.type];
    const out = { ...e };
    if (def) for (const [k, spec] of Object.entries(def.params)) if (out[k] === undefined) out[k] = spec[0];
    return out;
  }
  function defaultEffect(type, kind) {
    const def = (kind === "passive" ? E.PASSIVE_EFFECTS : E.EFFECTS)[type], e = { type };
    for (const [k, spec] of Object.entries(def.params)) e[k] = typeof spec[0] === "string" ? spec[0] : spec[0] + Math.round((spec[1] - spec[0]) / spec[2] / 3) * spec[2];
    return e;
  }
  function forgePreview() {
    const fz = S.forge;
    return E.validateSkill({ name: fz.name, kind: fz.kind, style: fz.style, element: fz.element, effects: fz.effects, cheaper: fz.cheaper }, { level: forgeLevel() });
  }
  function effectRowHtml(e, i, kind) {
    const table = kind === "passive" ? E.PASSIVE_EFFECTS : E.EFFECTS;
    const types = Object.entries(table).map(([k, def]) => `<option value="${k}" ${k === e.type ? "selected" : ""}>${def.label}</option>`).join("");
    const params = Object.entries(table[e.type].params).map(([k, spec]) => {
      if (typeof spec[0] === "string") return `<label class="param"><span class="lab">${k}</span><select data-fx="${i}" data-k="${k}">${spec.map((x) => `<option value="${x}" ${x === e[k] ? "selected" : ""}>${x}</option>`).join("")}</select></label>`;
      return `<label class="param"><span class="lab">${k} <b data-fxv="${i}-${k}">${e[k]}</b></span><input type="range" data-fx="${i}" data-k="${k}" min="${spec[0]}" max="${spec[1]}" step="${spec[2]}" value="${e[k]}"></label>`;
    }).join("");
    return `<div class="fx-row"><div class="row"><select data-fx-type="${i}" aria-label="Effect">${types}</select>
      <button class="btn icon" type="button" data-fx-del="${i}" aria-label="Remove effect">×</button></div><div class="params">${params}</div></div>`;
  }
  function priceHtml() {
    const v = forgePreview(), fz = S.forge, lv = forgeLevel();
    if (!v.skill) return `<p class="warn">${esc(v.errors.join(" "))}</p>`;
    const s = v.skill, cap = s.kind === "passive" ? E.maxPassiveBudget(lv) : E.maxSkillBudget(lv);
    const pct = Math.min(100, (s.budget / cap) * 100);
    return `<div class="price">
      <div class="meter ${v.overBudget ? "over" : ""}"><span style="width:${pct}%"></span></div>
      <p class="small" style="margin:0">Power <b>${s.budget}</b> of ${cap} allowed at level ${lv}${s.kind === "active" ? ` · <b>${s.energy} energy</b>${s.cooldown ? ` · cooldown ${s.cooldown}` : ""}${s.priority ? " · acts first" : ""}` : ""}</p>
      <p class="small" style="margin:0">${esc(E.describeSkill(s))}</p>
      ${v.errors.length ? `<p class="warn" style="margin:0">${esc(v.errors.join(" "))}</p>` : ""}
      ${fz.note ? `<p class="note" style="margin:0">${esc(fz.note)}</p>` : ""}
    </div>`;
  }
  function renderForge(v) {
    const fz = S.forge, w = S.progress.wallet, lv = forgeLevel();
    const q = ECON.gymQuote(w, 0);
    const ledger = w.ledger.slice(-10).reverse().map((e) => `<li><span>${esc(e.reason)}</span><b class="${e.amount > 0 ? "plus" : "minus"}">${e.amount > 0 ? "+" : ""}${e.amount}</b></li>`).join("");
    const v0 = forgePreview(), price = v0.skill ? ECON.forgeCost(v0.skill) : 0;
    const aiOk = S.ai.sample && !S.ai.off;
    const lib = S.progress.library.map((s) => `<div class="lib-item" style="--c:${STYLE_VAR[s.style]}"><div><b>${esc(s.name)}</b> <span class="tag">${s.kind === "passive" ? "PASSIVE" : E.STYLE_INFO[s.style].label.toUpperCase()}</span>
      <p class="small" style="margin:2px 0 0">${esc(E.describeSkill(s))}</p></div><button class="btn icon" type="button" data-lib-del="${esc(s.id)}" aria-label="Delete ${esc(s.name)}">×</button></div>`).join("");
    const shop = Object.values(E.ITEMS).map((it) => `<div class="shop-item"><div><b>${it.name}</b><p class="small" style="margin:2px 0 0">${it.blurb} You own ${S.progress.inventory[it.id] || 0}.</p></div>
      <button class="btn" type="button" data-buy="${it.id}">Buy · ${it.price}</button></div>`).join("");
    v.innerHTML = `<div class="two">
      <div class="panel">
        <div class="box">
          <h2>Wallet</h2>
          <div class="outcome">${balance()} Cycles</div>
          <p class="small" style="margin:0">Earn Cycles by beating rivals and arena opponents. Spend them on gym time (${q.freeLeft} of ${ECON.FREE_ROUNDS_PER_DAY} free rounds left today), compute, skills and items.
          Cycles have no cash value and can't be transferred.</p>
          <ul class="ledger">${ledger}</ul>
        </div>
        <div class="box">
          <h2>Shop</h2>
          <div class="shop">${shop}</div>
          <p class="note">Items are used up when your fighter uses them in a real battle. Practice in the gym doesn't use them.</p>
        </div>
        <div class="box">
          <h2>Your skills · ${S.progress.library.length} of ${LIBRARY_MAX}</h2>
          ${lib || `<p class="note">Forged skills appear here. Equip them in the Design tab.</p>`}
        </div>
      </div>
      <div class="panel">
        <div class="box">
          <h2>Skill forge</h2>
          ${seg("forge-mode", fz.mode, [["build", "Build it"], ["describe", "Describe it"]])}
          ${fz.mode === "describe" ? `
            <div class="field"><label for="fz-desc">Describe the skill</label>
              <textarea id="fz-desc" rows="3" maxlength="400" placeholder="Shoots fireballs that set the enemy on fire">${esc(fz.desc)}</textarea></div>
            <div class="field"><span class="lab">Kind</span>${seg("forge-kind", fz.kind, [["active", "Skill"], ["passive", "Passive"]])}</div>
            <div class="row"><button class="btn primary" type="button" id="fz-draft" ${aiOk && !fz.busy ? "" : "disabled"}>${fz.busy ? "Drafting…" : `Draft with Claude · ${ECON.PRICES.draft} Cycles`}</button></div>
            <p class="note">${aiOk ? "Claude turns your words into a skill file. The game then checks it, scales it to your level and sets its energy cost. You only pay if the draft works." : "Drafting needs Claude, which isn't available in this view. Build it by hand instead."}</p>
          ` : `
            <div class="grid2">
              <div class="field"><label for="fz-name">Name</label><input type="text" id="fz-name" maxlength="16" value="${esc(fz.name)}"></div>
              <div class="field"><span class="lab">Kind</span>${seg("forge-kind", fz.kind, [["active", "Skill"], ["passive", "Passive"]])}</div>
              <div class="field"><label class="lab" for="fz-style">Style</label><select id="fz-style">${E.STYLES.map((s) => `<option value="${s}" ${s === fz.style ? "selected" : ""}>${E.STYLE_INFO[s].label}</option>`).join("")}</select></div>
              <div class="field"><label class="lab" for="fz-element">Element (look)</label><select id="fz-element">${E.ELEMENTS.map((x) => `<option value="${x}" ${x === fz.element ? "selected" : ""}>${x}</option>`).join("")}</select></div>
            </div>
            <div class="fx-list">${fz.effects.map((e, i) => effectRowHtml(e, i, fz.kind)).join("")}</div>
            ${fz.effects.length < 3 ? `<div class="row"><button class="btn" type="button" id="fz-add">Add effect</button></div>` : ""}
            ${fz.kind === "active" ? `<div class="field"><span class="lab">Make it cheaper (lower energy, longer cooldown)</span>${seg("forge-cheaper", fz.cheaper, [[0, "No"], [1, "−1 energy"], [2, "−2 energy"]])}</div>` : ""}
            ${fz.why ? `<p class="small"><b>Claude:</b> ${esc(fz.why)}</p>` : ""}
            <div id="fz-price">${priceHtml()}</div>
            <div class="row"><button class="btn primary" type="button" id="fz-forge" ${v0.skill && !v0.overBudget ? "" : "disabled"}>Forge · ${price} Cycles</button></div>
            <p class="note">The power limit grows with your active fighter's level (now ${lv}). The game sets energy cost and cooldown from the skill's power.</p>
          `}
        </div>
      </div>
    </div>`;
    bindForge(v);
  }
  function bindForge(v) {
    const fz = S.forge;
    const rerender = () => { const y = window.scrollY; renderForge(v); window.scrollTo({ top: y }); };
    const reprice = () => { const p = $("fz-price"); if (p) p.innerHTML = priceHtml(); const b = $("fz-forge"); const pv = forgePreview(); if (b) { b.disabled = !(pv.skill && !pv.overBudget); b.textContent = `Forge · ${pv.skill ? ECON.forgeCost(pv.skill) : 0} Cycles`; } };
    v.onclick = async (e) => {
      const sg = e.target.closest("[data-seg]");
      if (sg) {
        const k = sg.dataset.seg, val = sg.dataset.val;
        if (k === "forge-mode") fz.mode = val;
        if (k === "forge-kind" && val !== fz.kind) { const desc = fz.desc, mode = fz.mode; resetForge(val); S.forge.desc = desc; S.forge.mode = mode; }
        if (k === "forge-cheaper") fz.cheaper = +val;
        rerender(); return;
      }
      const buy = e.target.closest("[data-buy]");
      if (buy) {
        const it = E.ITEMS[buy.dataset.buy];
        if (pay(it.price, `Bought ${it.name}`)) { S.progress.inventory[it.id] = (S.progress.inventory[it.id] || 0) + 1; saveProgress(); toast(`${it.name} bought.`); rerender(); }
        return;
      }
      const libDel = e.target.closest("[data-lib-del]");
      if (libDel) {
        const id = libDel.dataset.libDel;
        if (S.fighters.some((f) => f.moves.includes(id) || (f.passive && f.passive.id === id))) { toast("A fighter has this equipped. Unequip it in Design first."); return; }
        S.progress.library = S.progress.library.filter((s) => s.id !== id); saveProgress(); rerender(); return;
      }
      const fxDel = e.target.closest("[data-fx-del]");
      if (fxDel) { fz.effects.splice(+fxDel.dataset.fxDel, 1); fz.note = ""; rerender(); return; }
      if (e.target.id === "fz-add") {
        const table = fz.kind === "passive" ? E.PASSIVE_EFFECTS : E.EFFECTS;
        const t = Object.keys(table).find((k) => !fz.effects.some((x) => x.type === k));
        fz.effects.push(defaultEffect(t, fz.kind)); rerender(); return;
      }
      if (e.target.id === "fz-forge") {
        const pv = forgePreview();
        if (!pv.skill || pv.overBudget) return;
        if (S.progress.library.length >= LIBRARY_MAX) { toast(`Your library holds ${LIBRARY_MAX} skills. Delete one first.`); return; }
        const cost = ECON.forgeCost(pv.skill);
        if (!pay(cost, `Forged ${pv.skill.name}`)) return;
        const skill = { ...pv.skill, id: E.newId(Math.random, "sk_") };
        S.progress.library.push(skill); saveProgress();
        toast(`${skill.name} forged. Equip it in the Design tab.`);
        resetForge(fz.kind); rerender(); return;
      }
      if (e.target.id === "fz-draft") await draftWithClaude(rerender);
    };
    v.oninput = (e) => {
      const t = e.target;
      if (t.id === "fz-desc") { fz.desc = t.value; return; }
      if (t.id === "fz-name") { fz.name = t.value.toUpperCase().replace(/[^A-Z0-9 '\-]/g, ""); if (t.value !== fz.name) t.value = fz.name; reprice(); return; }
      if (t.dataset.fx !== undefined && t.type === "range") {
        fz.effects[+t.dataset.fx][t.dataset.k] = Number(t.value);
        const lab = v.querySelector(`[data-fxv="${t.dataset.fx}-${t.dataset.k}"]`); if (lab) lab.textContent = t.value;
        fz.note = ""; reprice();
      }
    };
    v.onchange = (e) => {
      const t = e.target;
      if (t.dataset.fxType !== undefined) { fz.effects[+t.dataset.fxType] = defaultEffect(t.value, fz.kind); rerender(); return; }
      if (t.dataset.fx !== undefined && t.tagName === "SELECT") { fz.effects[+t.dataset.fx][t.dataset.k] = t.value; reprice(); return; }
      if (t.id === "fz-style") { fz.style = t.value; reprice(); return; }
      if (t.id === "fz-element") { fz.element = t.value; return; }
    };
  }
  async function draftWithClaude(rerender) {
    const fz = S.forge;
    if (!fz.desc.trim()) { toast("Describe the skill first."); return; }
    if (!ECON.canAfford(S.progress.wallet, ECON.PRICES.draft)) { toast(`Drafting costs ${ECON.PRICES.draft} Cycles.`); return; }
    fz.busy = true; rerender();
    try {
      const d = await A.draftSkill(S.ai.sample, fz.desc, fz.kind, forgeLevel());
      pay(ECON.PRICES.draft, "Claude drafted a skill");      // only charged when the draft works
      Object.assign(fz, { mode: "build", name: d.skill.name, style: d.skill.style, element: d.skill.element, effects: d.skill.effects.map((x) => withDefaults(x, fz.kind)),
                          cheaper: 0, why: d.why, note: d.scaled ? d.errors[0] : "" });
    } catch (e) {
      noteAiError(e && e.code);
      toast(e && e.message ? e.message : "The draft didn't work. Try describing it differently.");
    }
    fz.busy = false; rerender();
  }

  // ---------- AI availability ----------
  function aiUsable() { return !!(S.ai.sample && !S.ai.off && S.aiOn); }
  function aiStatusText() {
    if (!S.ai.ready) return "Checking whether Claude is available…";
    if (!S.ai.sample) return "Claude isn't available in this view, so battles run on instincts. Open the game on claude.ai or in the Claude app to use AI battles.";
    if (S.ai.off) return S.ai.reason;
    if (!S.aiOn) return "AI is off: battles run on instincts and rules, and use no Claude requests.";
    return "Claude plays every action for both fighters: up to 24 short requests from your Claude account per battle. You'll be asked to allow it the first time.";
  }
  function refreshAiUi() {
    const sw = $("ai-switch"); if (sw) { sw.setAttribute("aria-checked", String(aiUsable())); sw.disabled = !(S.ai.sample && !S.ai.off); }
    const st = $("ai-status"); if (st) st.textContent = aiStatusText();
  }
  function noteAiError(code) {
    if (PERMANENT_AI_CODES.has(code)) { S.ai.off = true; S.ai.reason = A.REASON_TEXT[code] || A.REASON_TEXT.unavailable; }
  }

  // ---------- coach (a paid review on request) ----------
  function queueReview(id, summary) {
    const prev = S.coach.pending && S.coach.pending.id === id ? S.coach.pending.summary + "\n\n" : "";
    S.coach.pending = { id, summary: (prev + summary).slice(-3000) };
    renderCoachBox();
  }
  function askCoach() {
    const p = S.coach.pending, f = p && find(p.id);
    if (!f || S.coach.busy) return;
    if (!aiUsable()) { toast("The coach needs Claude, which isn't available right now."); return; }
    if (!pay(ECON.PRICES.coach, `Coach review for ${f.name}`)) return;
    S.coach = { busy: true, forId: f.id, comment: "", playbook: "", error: "", pending: null };
    renderCoachBox();
    A.coach(S.ai.sample, f, p.summary).then((out) => {
      const latest = find(f.id);
      if (latest) saveFighter({ ...latest, playbook: out.playbook });
      S.coach = { ...S.coach, busy: false, comment: out.comment, playbook: out.playbook };
    }, (e) => {
      const code = e && e.code;
      noteAiError(code);
      earn(ECON.PRICES.coach, "Refund: coach review failed");
      S.coach = { ...S.coach, busy: false, pending: p, error: code === "rate_limited" ? "The coach is busy (rate limited). You weren't charged; try again later." : "The coach couldn't review this one. You weren't charged." };
    }).finally(() => { renderCoachBox(); renderActiveBar(); });
  }
  function coachHtml() {
    const c = S.coach, f = active();
    if (!f) return "";
    const ask = c.pending && c.pending.id === f.id && !c.busy
      ? `<div class="row"><button class="btn" type="button" id="ask-coach" ${aiUsable() ? "" : "disabled"}>Ask the coach to review · ${ECON.PRICES.coach} Cycles</button></div>` : "";
    if (c.busy && c.forId === f.id) return `<div class="coach"><span class="lab">Coach review</span><span class="dots">Reviewing</span></div>`;
    let body = "";
    if (c.forId === f.id && c.error) body = `<span class="small">${esc(c.error)}</span>`;
    else if (c.forId === f.id && c.playbook) body = `${c.comment ? `<span class="small"><b>${esc(c.comment)}</b></span>` : ""}<span class="small muted">New playbook (read before every action):</span><pre>${esc(c.playbook)}</pre>`;
    if (!body && !ask) return "";
    return `<div class="coach"><span class="lab">Coach review</span>${body}${ask || (body ? "" : "")}</div>`;
  }
  function renderCoachBox() { for (const el of document.querySelectorAll("[data-coach-box]")) el.innerHTML = coachHtml(); }
  document.addEventListener("click", (e) => { if (e.target.id === "ask-coach") askCoach(); });

  // ---------- gym ----------
  function needFighter(v, what) {
    v.innerHTML = `<div class="box"><h3>No fighter yet</h3><p class="muted">Design a fighter first, then bring it here to ${what}.</p>
      <div class="row"><button class="btn primary" type="button" data-go-design>Design a fighter</button></div></div>`;
    v.onclick = (e) => { if (e.target.closest("[data-go-design]")) { openDesigner(null); setTab("design"); } };
  }
  function partnerCards(level, selected) {
    return E.availablePartners(level).map((p) => {
      const lv = p.kind === "mirror" ? level : p.unlock > 1 ? p.level : Math.max(p.level, level);
      return `<button type="button" class="card${p.locked ? " locked" : ""}" data-partner="${p.id}" aria-pressed="${p.id === selected}" ${p.locked ? 'aria-disabled="true"' : ""}
        title="${esc(p.blurb)}"><canvas data-sprite="p:${p.id}" width="28" height="28" aria-hidden="true"></canvas>
        <span class="name">${esc(p.name)}</span><span class="lv">${p.locked ? `Unlocks at LV ${p.unlock}` : `LV ${lv}`}</span></button>`;
    }).join("");
  }
  function renderGym(v) {
    const f = active();
    if (!f) return needFighter(v, "train");
    if (S.spar) return renderSpar(v);
    const partner = E.PARTNERS.find((p) => p.id === S.partnerId);
    const rep = S.report && S.report.fighterId === f.id ? S.report : null;
    const q = ECON.gymQuote(S.progress.wallet, S.reps);
    const costNote = q.cost ? `${q.free} free, then ${q.paid} at ${ECON.ROUND_COST} Cycle each: <b>${q.cost} Cycles</b>.` : `Free (${q.freeLeft} free rounds left today after this).`;
    v.innerHTML = `<div class="two">
      <div class="panel">
        <div class="box">
          <h2>Sparring partner</h2>
          <div class="partners">${partnerCards(f.level, S.partnerId)}</div>
          <p class="note">${esc(partner.blurb)}</p>
          <div class="field"><span class="lab">Rounds</span>${seg("reps", S.reps, [[1, "1"], [10, "10"], [50, "50"]])}</div>
          <div class="row"><button class="btn primary" type="button" id="train">Train ${S.reps} round${S.reps > 1 ? "s" : ""}${q.cost ? ` · ${q.cost} Cycles` : ""}</button>
            <button class="btn" type="button" id="spar">Spar by hand</button></div>
          <p class="note">${costNote} Practice is instant and uses no Claude: it builds XP, mastery and instincts. In <b>Spar by hand</b> you choose each action and your fighter's instincts learn by copying you (free, double XP).</p>
        </div>
        ${rep ? reportBox(rep) : ""}
        <div data-coach-box>${coachHtml()}</div>
      </div>
      <div class="panel">
        <div class="box">
          <h2>Progress</h2>
          <div class="stats">
            <div class="stat"><b>${f.level}</b><span>Level</span></div>
            <div class="stat"><b>${f.record.w + f.record.l + f.record.d}</b><span>Practice rounds</span></div>
            <div class="stat"><b>${winPct(f.record)}</b><span>Practice win rate</span></div>
          </div>
          <div class="field"><span class="lab">Win rate per training session</span>${historyChart(f)}</div>
        </div>
        <div class="box">
          <h2>What ${esc(f.name)}'s instincts learned</h2>
          <p class="note">The skill its instincts favor in each situation. Claude sees this before every action.</p>
          ${brainRows(f)}
        </div>
      </div>
    </div>`;
    paintSprites(v);
    bindChart(v);
    v.onclick = (e) => {
      const p = e.target.closest("[data-partner]");
      if (p) { if (p.getAttribute("aria-disabled") === "true") { toast(p.querySelector(".lv").textContent + "."); return; } S.partnerId = p.dataset.partner; renderGym(v); return; }
      const sg = e.target.closest('[data-seg="reps"]');
      if (sg) { S.reps = +sg.dataset.val; renderGym(v); return; }
      if (e.target.id === "train") doTrain();
      if (e.target.id === "spar") startSpar();
      if (e.target.id === "watch-last" && S.report) { S.lastBattle = { match: S.report.lastMatch, foe: S.report.lastFoe, label: "Last practice round" }; setTab("battle"); }
    };
  }
  function winPct(rec) { const n = rec.w + rec.l + rec.d; return n ? Math.round(((rec.w + rec.d / 2) / n) * 100) + "%" : "–"; }
  function doTrain() {
    const f = active();
    if (!f) return;
    try {
      const partner = E.PARTNERS.find((p) => p.id === S.partnerId);
      if (f.level < partner.unlock) throw new Error(`${partner.name} unlocks at level ${partner.unlock}.`);
      const paid = ECON.payForGym(S.progress.wallet, S.reps);   // throws if you can't afford it
      const { fighter, report } = E.train(f, S.partnerId, S.reps);
      S.progress.wallet = paid.wallet; saveProgress();
      report.lastFoe = E.partnerFighter(S.partnerId, f);
      report.fighterId = f.id;
      saveFighter(fighter);                    // never waits on the network
      S.report = report;
      queueReview(f.id, A.gymSummary(report));
      render();
      if (report.levelAfter > report.levelBefore) toast(`Level up! ${fighter.name} is now level ${report.levelAfter}. Spend the stat point in Design.`);
    } catch (err) { toast(err.message); }
  }
  function reportBox(r) {
    const p = E.PARTNERS.find((x) => x.id === r.partner), f = active();
    const parts = [`${r.win} win${r.win === 1 ? "" : "s"}`, r.draw ? `${r.draw} draw${r.draw === 1 ? "" : "s"}` : "", `${r.loss} loss${r.loss === 1 ? "" : "es"}`].filter(Boolean);
    const rows = r.mastery.map((m) => { const sk = E.skillOf(f, m.move) || { name: m.move, style: "aggro" }; return `<div class="mrow" style="--c:${STYLE_VAR[sk.style]}">
        <span class="mv">${esc(sk.name)}</span>
        <span class="mtrack"><span class="was" style="width:${(m.before / 0.5) * 100}%"></span><span class="now" style="width:${(m.after / 0.5) * 100}%"></span></span>
        <span class="val">+${Math.round(m.after * 100)}%</span></div>`; }).join("");
    return `<div class="box">
      <h2>Session report · vs ${esc(p.name)}</h2>
      <div class="report-head">${parts.join(", ")}</div>
      <div class="row"><span class="badge">+${r.xpGained} XP</span>${r.levelAfter > r.levelBefore ? `<span class="badge">LEVEL ${r.levelBefore} → ${r.levelAfter}</span>` : ""}</div>
      <div class="field"><span class="lab">Skill mastery (bonus damage, max +50%)</span><div class="mastery">${rows}</div></div>
      <div class="row"><button class="btn" type="button" id="watch-last">Watch the last round</button></div>
    </div>`;
  }
  function brainRows(f) {
    return `<div class="brain">${E.brainMap(f).map((row) => {
      const sk = E.skillOf(f, row.best), c = STYLE_VAR[sk.style];
      const ctx = row.vs ? `After their ${E.STYLE_INFO[row.vs].label} move` : "First move";
      return `<div class="brow" style="--c:${c}"><span class="ctx">${ctx}</span>
        <span class="ans"><span class="chip">${esc(sk.name)}</span><span class="conf"><span style="width:${Math.round(row.confidence * 100)}%"></span></span>
        <span class="pct">${Math.round(row.confidence * 100)}%</span></span></div>`;
    }).join("")}</div>`;
  }
  function historyChart(f) {
    const h = (f.history || []).slice(-30);
    if (!h.length) return `<p class="note">Train a session to start the chart.</p>`;
    const W = 320, Hh = 120, padL = 30, padB = 18, padT = 6, n = h.length;
    const bw = Math.min(18, (W - padL - 4) / n - 2);
    const x = (i) => padL + 2 + i * ((W - padL - 4) / n);
    const y = (val) => padT + (1 - val) * (Hh - padT - padB);
    const bars = h.map((s, i) => {
      const rate = (s.win + s.draw / 2) / s.reps, top = y(rate), base = y(0), hgt = Math.max(2, base - top);
      return `<g data-i="${i}"><rect x="${x(i) - 2}" y="${padT}" width="${bw + 4}" height="${base - padT}" fill="transparent"></rect>
        <rect x="${x(i)}" y="${base - hgt}" width="${bw}" height="${hgt}" rx="3" fill="var(--accent)"></rect></g>`;
    }).join("");
    const grid = [0, 0.5, 1].map((val) => `<line x1="${padL}" x2="${W}" y1="${y(val)}" y2="${y(val)}" stroke="var(--line)" ${val === 0.5 ? 'stroke-dasharray="3 3"' : ""}></line>
      <text x="${padL - 6}" y="${y(val) + 3}" text-anchor="end" font-size="9" fill="var(--muted)">${val * 100}%</text>`).join("");
    const data = esc(JSON.stringify(h.map((s) => ({ p: E.PARTNERS.find((pp) => pp.id === s.partner)?.name || s.partner, w: s.win, l: s.loss, d: s.draw, n: s.reps, lv: s.level }))));
    return `<div class="chart" data-points="${data}"><svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Win rate for each of the last ${n} training sessions">${grid}${bars}
      <text x="${padL}" y="${Hh - 4}" font-size="9" fill="var(--muted)">older</text><text x="${W}" y="${Hh - 4}" text-anchor="end" font-size="9" fill="var(--muted)">latest</text></svg>
      <div class="tip" hidden></div></div>`;
  }
  function bindChart(v) {
    const chart = v.querySelector(".chart");
    if (!chart) return;
    const pts = JSON.parse(chart.dataset.points), tip = chart.querySelector(".tip"), svg = chart.querySelector("svg");
    const show = (g) => {
      const p = pts[+g.dataset.i], r = g.querySelector("rect:last-child").getBoundingClientRect(), c = chart.getBoundingClientRect();
      tip.textContent = `vs ${p.p} · ${p.w}W ${p.l}L ${p.d}D of ${p.n} · LV ${p.lv}`;
      tip.style.left = r.left - c.left + r.width / 2 + "px"; tip.style.top = r.top - c.top + "px"; tip.hidden = false;
    };
    svg.addEventListener("pointerover", (e) => { const g = e.target.closest("g[data-i]"); if (g) show(g); });
    svg.addEventListener("click", (e) => { const g = e.target.closest("g[data-i]"); if (g) show(g); });
    svg.addEventListener("pointerleave", () => (tip.hidden = true));
  }

  // ---------- spar by hand (imitation learning) ----------
  function startSpar() {
    const f = active();
    const partner = E.PARTNERS.find((p) => p.id === S.partnerId);
    if (f.level < partner.unlock) { toast(`${partner.name} unlocks at level ${partner.unlock}.`); return; }
    S.spar = { ...E.newSpar(f, S.partnerId), fighterId: f.id, busy: false, done: false };
    render();
  }
  function renderSpar(v) {
    const sp = S.spar, f = active(), st = sp.state, me = st.side[0];
    const mask = E.legalMask(st, 0);
    const btns = me.f.moves.map((m, i) => {
      const sk = E.skillOf(me.f, m);
      const why = mask[i] ? `${sk.energy}E` : me.cooldowns[m] > 0 ? "cooldown" : "no energy";
      return `<button type="button" class="act" data-act="${i}" style="--c:${STYLE_VAR[sk.style]}" ${mask[i] && !sp.busy && !sp.done ? "" : "disabled"}><b>${esc(sk.name)}</b><span>${E.STYLE_INFO[sk.style].label} · ${why}</span></button>`;
    }).join("") + (me.f.item ? `<button type="button" class="act" data-act="4" ${mask[4] && !sp.busy && !sp.done ? "" : "disabled"}><b>${E.ITEMS[me.f.item].name}</b><span>item · ${mask[4] ? "ready" : "used"}</span></button>` : "");
    v.innerHTML = `<div class="box"><h2>Spar by hand · vs ${esc(sp.foe.name)}</h2>
        <p class="note">You choose ${esc(f.name)}'s action each turn. Its instincts copy your choices and learn from how they turn out.</p></div>
      ${sceneHtml(f, true)}
      <div class="box"><h2>Your action</h2><div class="acts">${btns || ""}</div>
        <div class="row"><button class="btn" type="button" id="spar-quit">${sp.done ? "Back to the gym" : "Stop sparring"}</button></div>
        <div id="battle-result"></div><div data-coach-box>${coachHtml()}</div></div>
      <div class="box"><h2>Battle log</h2><ol class="log" id="log"></ol></div>`;
    paintSprites(v);
    prepareScene(me.f, sp.foe, "Sparring");
    const last = st.turns.at(-1);
    setHud(last?.state, [me.max, st.side[1].max]);
    if (last) { setHp("player", last.hp[0], me.max); setHp("foe", last.hp[1], st.side[1].max); }   // a redraw keeps the HP where it was
    if (st.turns.length) { for (const t of st.turns) for (const a of [...t.actions].sort((x, y) => x.order - y.order)) logLine(t.turn, a); }
    $("text").textContent = sp.done ? "Sparring finished." : `Turn ${st.turn}: choose an action.`;
    v.onclick = async (e) => {
      const b = e.target.closest("[data-act]");
      if (b && !b.disabled && !sp.busy && !sp.done) {
        sp.busy = true;
        for (const x of v.querySelectorAll("[data-act]")) x.disabled = true;
        const prev = st.turns.at(-1);
        const t = E.sparTurn(sp, +b.dataset.act);
        const anim = { seq: ++battleSeq, kind: "spar", cancelled: false, finished: false };
        S.battle = anim;
        try { await playTurn(anim, t, prev ? prev.hp.slice() : [me.max, st.side[1].max], [me.max, st.side[1].max]); } catch (err) { if (!(err instanceof Cancel)) console.error(err); }
        anim.finished = true;
        sp.busy = false;
        if (st.over) finishSparUi(v); else if (S.spar === sp) renderSpar(v);
        return;
      }
      if (e.target.id === "spar-quit") { S.spar = null; render(); }
    };
  }
  function finishSparUi(v) {
    const sp = S.spar, latest = find(sp.fighterId);
    if (!latest) { S.spar = null; render(); return; }
    const out = E.finishSpar(latest, sp);
    saveFighter(out.fighter);
    sp.done = true;
    queueReview(latest.id, `Hands-on sparring (the trainer chose every action) against ${sp.foe.name}: ${out.match.result}.`);
    renderSpar(v);
    $("battle-result").innerHTML = `<p class="outcome">${out.match.result === "win" ? "Victory" : out.match.result === "loss" ? "Defeat" : "Draw"}</p>
      <p class="small" style="margin:0">+${out.xp} XP. ${esc(latest.name)}'s instincts learned from your choices.</p>`;
    renderActiveBar();
  }

  // ---------- battle tab ----------
  function rivalState(i) {
    const rv = E.RIVALS[i];
    if (S.progress.beaten.includes(rv.id)) return "won";
    if (i === 0 || S.progress.beaten.includes(E.RIVALS[i - 1].id)) return "next";
    return "locked";
  }
  function renderBattle(v) {
    const f = active();
    if (!f) return needFighter(v, "battle");
    if (!S.rivalId) S.rivalId = (E.RIVALS.find((r, i) => rivalState(i) === "next") || E.RIVALS[0]).id;
    const pending = S.pendingChallenge;
    v.innerHTML = `
      ${pending ? "" : `<div class="box" id="ladder">${ladderHtml()}</div>`}
      <div class="box">
        <div class="airow"><button class="switch" type="button" role="switch" id="ai-switch" aria-checked="${aiUsable()}" aria-label="Claude plays every move"
          ${S.ai.sample && !S.ai.off ? "" : "disabled"}></button><b class="small">Claude plays every action</b></div>
        <p class="note" id="ai-status" style="margin:0">${esc(aiStatusText())}</p>
        <div class="airow"><button class="switch" type="button" role="switch" id="oc-switch" aria-checked="${S.overclock}" aria-label="Overclock"></button>
          <span class="small"><b>Overclock</b> · ${ECON.PRICES.overclock} Cycles: your fighter thinks with Claude's bigger model for the next battle. Smarter, but each turn takes longer.</span></div>
        <div class="row"><button class="btn" type="button" id="scout">Scouting report · ${ECON.PRICES.scout} Cycles</button></div>
        <div id="scout-out">${scoutHtml()}</div>
      </div>
      ${sceneHtml(f)}
      <div id="battle-result"></div>
      <div class="box"><h2>Battle log</h2><ol class="log" id="log"></ol></div>`;
    renderBattleBody(v, pending);
  }
  function foeKey() { return S.pendingChallenge ? `a:${S.pendingChallenge.owner}|${S.pendingChallenge.id}` : `r:${S.rivalId}`; }
  function scoutHtml() {
    const s = S.scouting[foeKey()];
    if (!s) return "";
    if (s.busy) return `<p class="small dots">Scouting</p>`;
    return `<div class="coach"><span class="lab">Scouting report (used in your next battle against this opponent)</span><pre>${esc(s.plan)}</pre></div>`;
  }
  function ladderHtml() {
    const rivals = E.RIVALS.map((rv, i) => {
      const st = rivalState(i);
      return `<button type="button" class="rival${st === "locked" ? " locked" : ""}" data-rival="${rv.id}" aria-pressed="${rv.id === S.rivalId}" ${st === "locked" ? 'aria-disabled="true"' : ""}>
        <canvas data-sprite="r:${rv.id}" width="28" height="28" aria-hidden="true"></canvas>
        <span class="name">${esc(rv.name)} <span class="lv">LV ${rv.level}</span></span>
        <span class="tag ${st}">${st === "won" ? "BEATEN" : st === "next" ? "NEXT UP" : "LOCKED"}</span>
        <span class="blurb">${st === "locked" ? `Beat ${esc(E.RIVALS[i - 1].name)} to unlock.` : `${esc(rv.persona)} Reward: ${ECON.rivalReward(rv.level, st !== "won")} Cycles.`}</span></button>`;
    }).join("");
    const rv = E.RIVALS.find((r) => r.id === S.rivalId) || E.RIVALS[0];
    return `<h2>Rival ladder</h2><div class="rivals">${rivals}</div>
      <div class="row"><button class="btn primary" type="button" id="fight" ${battleRunning() ? "disabled" : ""}>Fight ${esc(rv.name)}</button></div>`;
  }
  function refreshLadder() { const l = $("ladder"); if (l) { l.innerHTML = ladderHtml(); paintSprites(l); } }
  function renderBattleBody(v, pending) {
    const f = active();
    paintSprites(v);
    SP.draw($("mon-player"), f, { back: true });
    setupFx();
    v.onclick = (e) => {
      const r = e.target.closest("[data-rival]");
      if (r) {
        if (r.getAttribute("aria-disabled") === "true") { toast("Beat the rival before it to unlock this one."); return; }
        if (battleRunning()) return;
        S.rivalId = r.dataset.rival;
        for (const c of v.querySelectorAll("[data-rival]")) c.setAttribute("aria-pressed", String(c === r));
        $("fight").textContent = `Fight ${E.RIVALS.find((x) => x.id === S.rivalId).name}`;
        $("scout-out").innerHTML = scoutHtml();
        return;
      }
      if (e.target.id === "ai-switch") { S.aiOn = !S.aiOn; refreshAiUi(); return; }
      if (e.target.id === "oc-switch") { S.overclock = !S.overclock; e.target.setAttribute("aria-checked", String(S.overclock)); return; }
      if (e.target.id === "scout") { doScout(); return; }
      if (e.target.id === "fight") { if (!battleRunning()) startBattle("rival", { id: S.rivalId }); return; }
      if (e.target.id === "b-stop") { if (battleRunning()) { stopBattle(); $("text").textContent = "Battle stopped. No XP was given."; setControls(false); } return; }
      if (e.target.id === "b-play") { togglePause(e.target); return; }
      if (e.target.id === "b-speed") { cycleSpeed(e.target); return; }
      if (e.target.id === "again" && S.battle && S.battle.finished) { const b = S.battle; startBattle(b.kind, b.target); return; }
    };
    if (pending) { S.pendingChallenge = null; startBattle("arena", pending); }
    else if (S.lastBattle) { const lb = S.lastBattle; S.lastBattle = null; playReplay(lb); }
  }
  function currentFoe(kind, target) {
    if (kind === "rival") return E.rivalFighter(target.id);
    const foe = (S.arena.docs[target.owner] || []).find((p) => p.id === target.id);
    return foe ? E.clone(foe) : null;
  }
  async function doScout() {
    const me = active();
    if (!aiUsable()) { toast("Scouting needs Claude, which isn't available right now."); return; }
    const key = foeKey(), kind = key.startsWith("a:") ? "arena" : "rival";
    const target = kind === "rival" ? { id: S.rivalId } : S.pendingChallenge;
    const foe = currentFoe(kind, target);
    if (!foe || (S.scouting[key] && S.scouting[key].busy)) return;
    if (!pay(ECON.PRICES.scout, `Scouting ${foe.name}`)) return;
    S.scouting[key] = { busy: true };
    const out = $("scout-out"); if (out) out.innerHTML = scoutHtml();
    try { S.scouting[key] = { plan: await A.scout(S.ai.sample, me, foe) }; }
    catch (e) { noteAiError(e && e.code); delete S.scouting[key]; earn(ECON.PRICES.scout, "Refund: scouting failed"); toast("Scouting didn't work this time. You weren't charged."); }
    const o2 = $("scout-out"); if (o2) o2.innerHTML = scoutHtml();
  }
  function sceneHtml(f, spar) {
    return `<div class="console">
      <div class="scene" id="scene">
        <div class="pad foe"></div><div class="pad player"></div>
        <canvas class="mon foe" id="mon-foe" width="28" height="28" role="img" aria-label="Opponent"></canvas>
        <canvas class="mon player" id="mon-player" width="28" height="28" role="img" aria-label="${esc(f.name)}"></canvas>
        <div class="hud foe"><div class="hud-row"><span class="hud-name" id="name-foe">???</span><span class="hud-lv" id="lv-foe"></span></div>
          <div class="hp"><span class="hp-label">HP</span><span class="hp-track"><span class="hp-fill" id="hp-foe"></span></span></div>
          <div class="hud-sub"><span class="energy" id="en-foe"></span><span class="statuses" id="st-foe"></span></div></div>
        <div class="hud player"><div class="hud-row"><span class="hud-name" id="name-player">${esc(f.name)}</span><span class="hud-lv" id="lv-player">LV ${f.level}</span></div>
          <div class="hp"><span class="hp-label">HP</span><span class="hp-track"><span class="hp-fill" id="hp-player"></span></span></div>
          <div class="hud-sub"><span class="energy" id="en-player"></span><span class="statuses" id="st-player"></span></div>
          <div class="hp-num" id="hpnum-player"></div></div>
        <div class="banner" id="banner"></div>
        <canvas class="fx" id="fx"></canvas>
      </div>
      <div class="textbox"><p id="text">${spar ? "" : "Pick a rival and press Fight."}</p></div>
      <div class="sr-only" aria-live="polite" id="announce"></div>
      ${spar ? "" : `<div class="controls">
        <button class="btn primary" type="button" id="b-play" disabled>Pause</button>
        <button class="btn" type="button" id="b-speed">${B.speed}×</button>
        <button class="btn" type="button" id="b-stop" disabled>Stop</button>
        <span class="readout" id="readout">Ready</span>
      </div>`}
    </div>`;
  }

  // ---------- arena tab ----------
  function renderArena(v) {
    const f = active();
    const uid = S.me.id;
    const rows = [];
    for (const [owner, list] of Object.entries(S.arena.docs)) for (const p of list) rows.push({ owner, p, ...(S.arena.ratings[`${owner}/${p.id}`] || { rating: 1000, w: 0, l: 0, d: 0 }) });
    rows.sort((a, b) => b.rating - a.rating || b.w - a.w || a.p.name.localeCompare(b.p.name));
    const mine = f ? myArenaList().find((p) => p.id === f.id) : null;
    let pubBox = "";
    if (!S.arena.db) pubBox = `<p class="note">The arena needs claude.ai storage, which isn't available in this view.</p>`;
    else if (!uid) pubBox = `<p class="note">Sign in to claude.ai to publish fighters.</p>`;
    else if (S.me.canWrite === false) pubBox = `<p class="note">You have view-only access, so you can challenge fighters but not publish or record results. Ask the owner for Contributor access.</p>`;
    else if (!f) pubBox = `<p class="note">Create a fighter to publish it.</p>`;
    else {
      const outdated = mine && (mine.level !== f.level || mine.playbook !== f.playbook || mine.persona !== f.persona || mine.moves.join() !== f.moves.join()
        || JSON.stringify(mine.rules || []) !== JSON.stringify(f.rules || []) || (mine.passive?.id || null) !== (f.passive?.id || null) || (mine.item || null) !== (f.item || null));
      pubBox = `<p class="small" style="margin:0">${mine ? (outdated ? `${esc(f.name)} is in the arena at an older version (level ${mine.level}). Update it to share its latest training and loadout.` : `${esc(f.name)} is in the arena with its latest training.`)
        : `Publish ${esc(f.name)} so other players can challenge it. Its design, skills, rules, persona, playbook and instincts are shared.`}</p>
        <div class="row">${mine ? `${outdated ? `<button class="btn primary" type="button" id="publish">Update in arena</button>` : ""}<button class="btn" type="button" id="unpublish">Remove from arena</button>`
          : `<button class="btn primary" type="button" id="publish">Publish ${esc(f.name)}</button>`}</div>`;
    }
    const table = rows.length ? `<div class="lb-wrap"><table class="lb">
        <thead><tr><th>#</th><th>Fighter</th><th class="num">LV</th><th class="num">Rating</th><th class="num">W-L-D</th><th></th></tr></thead>
        <tbody>${rows.map((r, i) => {
          const own = r.owner === uid && f && r.p.id === f.id;
          return `<tr class="${r.owner === uid ? "mine" : ""}"><td class="num">${i + 1}</td>
            <td><div class="who"><canvas data-sprite="a:${esc(r.owner)}|${esc(r.p.id)}" width="28" height="28" aria-hidden="true"></canvas>
              <div><b>${esc(r.p.name)}</b><span>by <span data-owner="${esc(r.owner)}">…</span></span></div></div></td>
            <td class="num">${r.p.level}</td><td class="num">${r.rating}</td><td class="num">${r.w}-${r.l}-${r.d}</td>
            <td>${f && !own ? `<button class="btn" type="button" data-challenge="${esc(r.owner)}|${esc(r.p.id)}">Challenge</button>` : ""}</td></tr>`;
        }).join("")}</tbody></table></div>`
      : `<p class="note">${S.arena.loaded ? "No fighters in the arena yet. Publish yours, then share this game with friends so they can publish theirs." : S.arena.db ? "Loading the arena…" : ""}</p>`;
    v.innerHTML = `<div class="box">
        <h2>Arena</h2>
        <p class="small" style="margin:0">Fighters published by everyone who plays this game. When you challenge one, Claude plays both sides, each with its own persona, playbook, rules and instincts. The requests come from your Claude account. Wins pay ${ECON.arenaReward(ECON.newWallet(), "win", false)} Cycles (up to ${ECON.ARENA_REWARDS_PER_DAY} rewards a day; beating your own fighters pays nothing).</p>
        ${pubBox}
      </div>
      <div class="box"><h2>Leaderboard</h2>${table}
        <p class="note">To bring friends in, share this game with them as Contributors (Share menu). Results are worked out in the challenger's browser and every published fighter is re-checked by the game, but it's still a friendly league, not a tamper-proof one.</p>
      </div>`;
    paintSprites(v);
    fillOwnerNames(v);
    v.onclick = (e) => {
      if (e.target.id === "publish" && f) { publish(f); render(); return; }
      if (e.target.id === "unpublish" && f) { unpublish(f.id); toast(`${f.name} left the arena.`); render(); return; }
      const ch = e.target.closest("[data-challenge]");
      if (ch && f) { const [owner, id] = ch.dataset.challenge.split("|"); S.pendingChallenge = { owner, id }; setTab("battle"); }
    };
  }

  // ---------- battle engine on screen ----------
  const B = { speed: 1, paused: false, waiters: [], parts: [] };
  class Cancel extends Error {}
  let battleSeq = 0;
  function stopBattle() {
    const b = S.battle;
    if (b) { b.cancelled = true; b.finished = true; if (b.ctl) b.ctl.abort(); if (b.wake) b.wake(); }
    B.paused = false; B.waiters.splice(0).forEach((fn) => fn()); B.parts = [];
  }
  function setControls(running) {
    const play = $("b-play"), stop = $("b-stop"), fight = $("fight");
    if (play) { play.disabled = !running; play.textContent = "Pause"; }
    if (stop) stop.disabled = !running;
    if (fight) fight.disabled = running;
  }
  function togglePause(btn) { B.paused = !B.paused; btn.textContent = B.paused ? "Play" : "Pause"; if (!B.paused) B.waiters.splice(0).forEach((fn) => fn()); }
  function cycleSpeed(btn) { B.speed = B.speed === 1 ? 2 : B.speed === 2 ? 4 : 1; document.documentElement.style.setProperty("--spd", B.speed); btn.textContent = B.speed + "×"; }
  async function gate(b) {
    while (B.paused && !b.cancelled) await new Promise((res) => B.waiters.push(res));
    if (b.cancelled || S.battle !== b) throw new Cancel();
  }
  async function sleep(b, ms) { await gate(b); await new Promise((r) => setTimeout(r, ms / B.speed)); await gate(b); }
  function retrigger(el, cls, ms) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); setTimeout(() => el.classList.remove(cls), ms / B.speed + 50); }
  function textbox(html) { const el = $("text"); if (el) el.innerHTML = html; }
  async function say(b, text, hold = 650) {
    const el = $("text"); if (!el) throw new Cancel();
    $("announce").textContent = text;
    if (reduce) el.textContent = text;
    else for (let i = 1; i <= text.length; i++) { el.textContent = text.slice(0, i); await sleep(b, 14); }
    await sleep(b, hold);
  }
  async function quote(b, name, line, hold = 900) {
    $("announce").textContent = `${name}: ${line}`;
    textbox(`<span class="speaker">${esc(name)}</span><span class="quote">“${esc(line)}”</span>`);
    await sleep(b, hold);
  }
  function setHp(side, hp, max) {
    const pct = Math.max(0, Math.min(100, (hp / max) * 100)), fill = $("hp-" + side);
    if (!fill) return;
    fill.style.width = pct + "%";
    fill.classList.toggle("mid", pct <= 50 && pct > 20); fill.classList.toggle("low", pct <= 20);
    if (side === "player") $("hpnum-player").textContent = `${Math.ceil(hp)} / ${max}`;
  }
  /** Energy pips and status chips under each HP bar, from a turn's state snapshot. */
  function setHud(state, maxes) {
    const sides = ["player", "foe"];
    sides.forEach((side, i) => {
      const s = state ? state[i] : { energy: E.ENERGY.start, status: [], shield: 0 };
      const en = $("en-" + side), st = $("st-" + side);
      if (en) en.innerHTML = Array.from({ length: E.ENERGY.max }, (_, k) => `<i class="${k < s.energy ? "on" : ""}"></i>`).join("") + `<span class="sr-only">${s.energy} energy</span>`;
      if (st) st.innerHTML = [...(s.shield ? [`shield ${Math.round(s.shield)}`] : []), ...s.status].map((x) => `<span class="st st-${esc(String(x).split(/[×\s]/)[0])}">${esc(x)}</span>`).join("");
    });
  }
  function logLine(turn, a) {
    const li = document.createElement("li");
    const eff = a.effect === "super" ? " · super effective" : a.effect === "resisted" ? " · resisted" : "";
    const src = a.source === "ai" ? ["ai", "AI"] : a.source === "rule" ? ["rule", "RULE"] : a.source === "you" ? ["you", "YOU"] : ["", "INSTINCT"];
    const what = a.stunned ? "stunned" : a.fizzled ? "no energy" : a.dodged ? "dodged" : a.kind === "item" ? `item${a.healed ? ` +${a.healed} HP` : ""}` : a.kind === "rest" ? "rest" : `−${(a.points || 0).toFixed(1)} HP${eff}`;
    const extra = [a.applied.length ? a.applied.join(", ") : "", a.healed && a.kind === "skill" ? `+${a.healed} HP` : "", a.absorbed ? `${a.absorbed} blocked` : "", a.reflected ? `${a.reflected} reflected` : ""].filter(Boolean).join(" · ");
    li.innerHTML = `<span class="t">T${String(turn).padStart(2, "0")}</span><span class="chip" style="--c:${a.style ? STYLE_VAR[a.style] : "var(--muted)"}">${esc(a.name)}</span>
      <span class="who">${esc(a.agent_name)} <span class="src ${src[0]}">${src[1]}</span></span>
      <span class="pts">${what}${extra ? " · " + esc(extra) : ""}</span>${a.line ? `<span class="said">“${esc(a.line)}”</span>` : ""}${a.rule ? `<span class="said">${esc(a.rule)}</span>` : ""}`;
    const ol = $("log"); if (!ol) return;
    const atEnd = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
    ol.append(li); if (atEnd) ol.scrollTop = ol.scrollHeight;
  }

  // particles
  let fctx = null;
  function setupFx() {
    const fx = $("fx"); if (!fx) return;
    fctx = fx.getContext("2d");
    const r = $("scene").getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    fx.width = Math.round(r.width * dpr); fx.height = Math.round(r.height * dpr); fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", () => { if ($("fx")) setupFx(); });
  function center(el) { const s = $("scene").getBoundingClientRect(), r = el.getBoundingClientRect(); return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2, w: r.width }; }
  function spawn(kind, from, to, color) {
    const n = reduce ? 0.35 : 1, R = Math.random, W = to.w;
    const add = (p) => B.parts.push(Object.assign({ age: 0, delay: 0, g: 0, size: 3, color }, p));
    const k = (c) => Math.max(2, Math.round(c * n));
    if (kind === "burst") for (let i = 0; i < k(22); i++) { const a = R() * 6.283, s = 1.5 + R() * 3.5;
      add({ x: to.x, y: to.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1, g: 0.09, life: 30 + R() * 20, size: 3 + R() * 4, color: [color, "#ffd45c", "#ffffff"][i % 3] }); }
    else if (kind === "ghost") for (let i = 0; i < k(16); i++) add({ x: to.x + (R() - 0.5) * W, y: to.y + (R() - 0.3) * W * 0.6, vx: (R() - 0.5) * 0.6, vy: -0.6 - R(), life: 45, size: 4, delay: i * 2 });
    else if (kind === "bubbles" || kind === "coins") for (let i = 0; i < k(8); i++) { const fr = 38;
      add({ x: from.x, y: from.y - from.w * 0.15, vx: (to.x - from.x) / fr, vy: (to.y - from.y) / fr + (kind === "coins" ? -3 : 0), g: kind === "coins" ? 6 / fr : 0,
            life: fr, delay: i * 4, shape: kind === "coins" ? "sq" : "ring", size: kind === "coins" ? 4 : 5 + R() * 4, wob: R() * 6, color: kind === "coins" ? "#e8b923" : color }); }
    else if (kind === "glyphs") for (let i = 0; i < k(18); i++) add({ x: to.x + (R() - 0.5) * W, y: to.y - W * 0.6, vx: 0, vy: 1.6 + R() * 1.4, life: 36, delay: i * 2, shape: "text", text: "01{}<>/;="[Math.floor(R() * 9)], size: 11 + R() * 5 });
    else if (kind === "scan") { add({ x: to.x - W * 0.6, y: to.y, vx: (W * 1.2) / 30, vy: 0, life: 30, shape: "line", size: W * 0.9 });
      add({ x: to.x + W * 0.6, y: to.y, vx: -(W * 1.2) / 30, vy: 0, life: 30, shape: "line", size: W * 0.9, delay: 30 }); }
    else if (kind === "barrier") for (let i = 0; i < 3; i++) add({ x: from.x, y: from.y, vx: 0, vy: 0, life: 34, delay: i * 9, shape: "hex", size: from.w * 0.45, grow: from.w * 0.012 });
    else if (kind === "sparkle") for (let i = 0; i < k(10); i++) { const a = (i / 10) * 6.283;
      add({ x: from.x + Math.cos(a) * from.w * 0.5, y: from.y + Math.sin(a) * from.w * 0.4, vx: (to.x - from.x) / 40, vy: (to.y - from.y) / 40, life: 40, delay: 8 + i * 2, shape: "star", size: 5, color: "#fff4b0" }); }
  }
  function drawPart(p) {
    fctx.globalAlpha = Math.max(0, 1 - p.age / p.life); fctx.fillStyle = p.color; fctx.strokeStyle = p.color;
    if (p.shape === "ring") { fctx.lineWidth = 2; fctx.beginPath(); fctx.arc(p.x + Math.sin((p.age + p.wob) / 4) * 4, p.y, p.size, 0, 6.283); fctx.stroke(); }
    else if (p.shape === "text") { fctx.font = `600 ${p.size}px ui-monospace, Menlo, monospace`; fctx.fillText(p.text, p.x, p.y); }
    else if (p.shape === "line") { fctx.globalAlpha = 0.85; fctx.fillRect(p.x - 1.5, p.y - p.size / 2, 3, p.size); fctx.globalAlpha = 0.18; fctx.fillRect(p.x - 10, p.y - p.size / 2, 20, p.size); }
    else if (p.shape === "hex") { const r = p.size + p.age * p.grow; fctx.lineWidth = 3; fctx.beginPath();
      for (let i = 0; i <= 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; fctx[i ? "lineTo" : "moveTo"](p.x + Math.cos(a) * r, p.y + Math.sin(a) * r * 0.9); } fctx.stroke(); }
    else if (p.shape === "star") { fctx.fillRect(p.x - p.size, p.y - 0.75, p.size * 2, 1.5); fctx.fillRect(p.x - 0.75, p.y - p.size, 1.5, p.size * 2); }
    else fctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  let lastTs = 0;
  function tick(ts) {
    const steps = B.paused ? 0 : Math.min(4, Math.max(1, Math.round(((ts - lastTs) / 16.7) * B.speed)));
    lastTs = ts;
    if (B.parts.length && fctx && $("fx")) {
      for (let s = 0; s < steps; s++) {
        for (const p of B.parts) { if (p.delay > 0) { p.delay--; continue; } p.age++; p.x += p.vx; p.y += p.vy; p.vy += p.g; }
        B.parts = B.parts.filter((p) => p.age < p.life);
      }
      const r = $("scene").getBoundingClientRect(); fctx.clearRect(0, 0, r.width, r.height);
      for (const p of B.parts) if (p.delay <= 0) drawPart(p);
      fctx.globalAlpha = 1;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  function prepareScene(me, foe, label) {
    if ($("log") && !S.spar) $("log").innerHTML = "";
    if ($("battle-result") && !S.spar) $("battle-result").innerHTML = "";
    $("banner").className = "banner"; $("banner").textContent = "";
    for (const side of ["player", "foe"]) $("mon-" + side).className = "mon " + side;
    $("name-foe").textContent = foe.name; $("lv-foe").textContent = "LV " + (foe.level || 1);
    $("name-player").textContent = me.name; $("lv-player").textContent = "LV " + me.level;
    SP.draw($("mon-foe"), foe, {}); SP.draw($("mon-player"), me, { back: true });
    $("mon-foe").setAttribute("aria-label", foe.name);
    const mMax = E.maxHp(me.level, E.statsOf(me).vitality), fMax = E.maxHp(foe.level || 1, E.statsOf(foe).vitality);
    setHp("player", mMax, mMax); setHp("foe", fMax, fMax);
    setHud(null);
    setupFx();
    if ($("readout")) $("readout").textContent = label;
  }
  const STATUS_TEXT = { burn: "was burned", poison: "was poisoned", stun: "is stunned", weaken: "was weakened", shield: "raised a shield", regen: "started regenerating", focus: "is focusing", cleanse: "shook off its ailments" };
  /** Animate one resolved turn (shared by battles, replays and sparring). `cur` is HP at the start of the turn. */
  async function playTurn(b, t, cur, maxes) {
    const names = t.actions.map((a) => a.agent_name);
    const sides = ["player", "foe"];
    const ordered = [0, 1].sort((x, y) => (t.actions[x].order || x + 1) - (t.actions[y].order || y + 1));
    for (const i of ordered) {
      const a = t.actions[i], att = sides[i], def = sides[1 - i], target = 1 - i;
      if (a.skipped) continue;
      if (a.stunned) { await say(b, `${a.agent_name} is stunned and can't move!`, 450); logLine(t.turn, a); continue; }
      if (a.line) await quote(b, a.agent_name, a.line, 950);
      if (a.kind === "item") {
        await say(b, `${a.agent_name} uses ${a.name}!`, 300);
        spawn("sparkle", center($("mon-" + att)), center($("mon-" + att)), "#9fe0a8");
        if (a.healed) { cur[i] = Math.min(maxes[i], cur[i] + a.healed); setHp(att, cur[i], maxes[i]); await say(b, `${a.agent_name} recovered ${Math.round(a.healed)} HP.`, 350); }
        logLine(t.turn, a); continue;
      }
      if (a.kind === "rest") { await say(b, `${a.agent_name} rests to recover energy.`, 350); logLine(t.turn, a); continue; }
      if (a.fizzled) { await say(b, `${a.agent_name} doesn't have the energy for ${a.name}!`, 450); logLine(t.turn, a); continue; }
      if (a.dodged) { await say(b, `${a.agent_name} used ${a.name}, but it was dodged!`, 450); logLine(t.turn, a); continue; }
      const sk = a.kind === "skill" ? E.skillOf({ custom: {} }, a.skill) || { fx: "burst", color: "#c8402a" } : { fx: "burst" };
      await say(b, `${a.agent_name} used ${a.name}!`, 200);
      logLine(t.turn, a);
      const At = $("mon-" + att), D = $("mon-" + def);
      const fx = sk.fx || (a.applied.includes("shield") ? "barrier" : a.applied.includes("regen") ? "sparkle" : a.style === "mind" ? "glyphs" : a.style === "social" ? "bubbles" : a.style === "guard" ? "scan" : "burst");
      if (fx === "burst" && !reduce) retrigger(At, "lunge-" + att, 420);
      if (fx === "ghost") retrigger(At, "blink", 520);
      if (fx === "barrier" || fx === "sparkle") retrigger(At, "rise", 500);
      spawn(fx, center(At), center(D), a.style ? E.STYLE_COLOR[a.style] : "#c8402a");
      await sleep(b, fx === "scan" ? 800 : 500);
      if (a.points > 0) {
        retrigger(D, "hit", 480);
        if (!reduce && a.effect === "super") retrigger($("scene"), "shake", 380);
        cur[target] = Math.max(0, cur[target] - a.points);
        setHp(def, cur[target], maxes[target]);
      }
      if (a.absorbed) await say(b, `The shield blocked ${Math.round(a.absorbed)} damage.`, 300);
      if (a.healed) { cur[i] = Math.min(maxes[i], cur[i] + a.healed); setHp(att, cur[i], maxes[i]); }
      if (a.reflected) { cur[i] = Math.max(0, cur[i] - a.reflected); setHp(att, cur[i], maxes[i]); }
      await sleep(b, 240);
      if (a.effect === "super" && a.points > 0) await say(b, "It's super effective!", 380);
      else if (a.effect === "resisted" && a.points > 0) await say(b, "It's not very effective…", 340);
      for (const st of a.applied) {
        const selfish = ["shield", "regen", "focus", "cleanse"].includes(st);
        await say(b, `${selfish ? a.agent_name : names[target]} ${STATUS_TEXT[st] || st}!`, 300);
      }
    }
    for (const ev of t.events || []) {
      const idx = names[0] === ev.who ? 0 : 1;
      if (ev.kind === "regen") { cur[idx] = Math.min(maxes[idx], cur[idx] + ev.amount); await say(b, `${ev.who} regenerates ${Math.round(ev.amount)} HP.`, 300); }
      else { cur[idx] = Math.max(0, cur[idx] - ev.amount); retrigger($("mon-" + sides[idx]), "hit", 480); await say(b, `${ev.who} takes ${ev.amount} ${ev.kind} damage.`, 300); }
      setHp(sides[idx], cur[idx], maxes[idx]);
    }
    cur[0] = t.hp[0]; cur[1] = t.hp[1];
    setHp("player", cur[0], maxes[0]); setHp("foe", cur[1], maxes[1]);
    if (t.state) setHud(t.state, maxes);
  }

  /** Start a real battle: Claude (or rules, or instincts) choose, turns animate as they arrive. */
  function startBattle(kind, target) {
    const meRaw = active();
    if (!meRaw || !$("scene")) return;
    stopBattle();
    const foe = currentFoe(kind, target);
    if (!foe) { toast("That fighter has left the arena."); return; }
    const me = E.clone(meRaw);
    if (me.item && !(S.progress.inventory[me.item] > 0)) me.item = null;   // you only bring items you own
    const useAi = aiUsable();
    const overclock = !!(S.overclock && useAi);
    if (overclock && !pay(ECON.PRICES.overclock, `Overclock for ${me.name} vs ${foe.name}`)) return;
    const sKey = kind === "rival" ? `r:${target.id}` : `a:${target.owner}|${target.id}`;
    const scouting = S.scouting[sKey] && S.scouting[sKey].plan ? S.scouting[sKey].plan : null;
    const label = kind === "rival" ? "Rival battle" : "Arena challenge";
    const b = { seq: ++battleSeq, kind, target, me, foe, useAi, overclock, queue: [], done: false, finished: false, cancelled: false,
                out: null, error: null, ctl: new AbortController(), wake: null, paceWake: null, label };
    S.battle = b;
    prepareScene(me, foe, label);
    setControls(true);
    $("scene").closest(".console").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    const nextEvent = () => new Promise((res) => { b.wake = res; });
    const signalEvent = () => { const w = b.wake; b.wake = null; if (w) w(); };
    A.runAiBattle({
      a: me, b: foe, sample: useAi ? S.ai.sample : null, signal: b.ctl.signal, learnA: true,
      tiers: [overclock ? "overclock" : "quick", "quick"], scouting: [scouting, null],
      onTurn: (t) => { b.queue.push(t); signalEvent(); },
      pace: () => (b.queue.length < 1 ? Promise.resolve() : new Promise((res) => { b.paceWake = res; })),
    }).then((out) => { b.out = out; b.done = true; signalEvent(); },
      (err) => { if (!(err instanceof A.Cancelled)) { b.error = err; b.done = true; console.error(err); } signalEvent(); });
    animateBattle(b, nextEvent).catch((e) => { if (!(e instanceof Cancel)) console.error(e); });
  }
  async function animateBattle(b, nextEvent) {
    const me = b.me, foe = b.foe;
    const maxes = [E.maxHp(me.level, E.statsOf(me).vitality), E.maxHp(foe.level || 1, E.statsOf(foe).vitality)];
    await say(b, `${foe.name} wants to battle!`, 400);
    await say(b, `Go, ${me.name}!`, 300);
    const cur = maxes.slice();
    let phase = null;
    for (;;) {
      await gate(b);
      if (b.queue.length) {
        const t = b.queue.shift();
        if (b.paceWake) { const w = b.paceWake; b.paceWake = null; w(); }
        if (t.phase !== phase) {
          phase = t.phase;
          $("banner").textContent = phase.toUpperCase() + (t.multiplier > 1 ? `  ×${t.multiplier}` : "");
          retrigger($("banner"), "show", 1500); await sleep(b, 1200);
        }
        if ($("readout")) $("readout").textContent = `Turn ${t.turn} / ${E.TURNS} · ${phase.toUpperCase()}`;
        await playTurn(b, t, cur, maxes);
        continue;
      }
      if (b.done) break;
      if (b.useAi) textbox(`<span class="dots">${esc(me.name)} and ${esc(foe.name)} are thinking</span>`);
      await nextEvent();
    }
    await gate(b);
    if (b.error) { textbox("Something went wrong in this battle. Try again."); finishUi(b); return; }
    const m = b.out.match, w = m.winner;
    if ($("readout")) $("readout").textContent = `Final · ${m.turns.length} turns`;
    if (w === null) { $("banner").textContent = "DRAW"; $("banner").classList.add("stay"); await say(b, "It's a draw!", 300); }
    else {
      const loserSide = w === 0 ? "foe" : "player", winner = m.agents[w], loser = m.agents[1 - w];
      if (m.ko) { $("mon-" + loserSide).classList.add("faint"); await say(b, `${loser.name} fainted!`, 500); }
      else await say(b, "Time's up!", 400);
      $("banner").textContent = `${winner.name} WINS`; $("banner").classList.add("stay");
      await say(b, `${winner.name} wins with ${Math.ceil(winner.hp)} HP left.`, 200);
    }
    if (b.kind === "replay") $("battle-result").innerHTML = `<div class="box"><p class="small" style="margin:0">Replay of a practice round. Replays don't give XP.</p></div>`;
    else applyResult(b);
    finishUi(b);
  }
  function finishUi(b) { b.finished = true; setControls(false); }
  function applyResult(b) {
    const out = b.out, m = out.match;
    const latest = find(b.me.id);
    const lines = [];
    if (out.stoppedReason) {
      noteAiError(out.stoppedReason);
      lines.push(A.REASON_TEXT[out.stoppedReason] || A.REASON_TEXT.unavailable);
      if (b.overclock && out.stats.ai === 0) { earn(ECON.PRICES.overclock, "Refund: Overclock wasn't used"); lines.push("Overclock refunded."); }
    }
    if (latest) {
      const award = E.awardBattle(latest, m, 0);
      const f = award.fighter;
      f.brain = E.compactBrain(out.fighterA.brain);          // instincts also learn from real battles
      f.uses = { ...f.uses, ...out.fighterA.uses };
      saveFighter(f);
      lines.unshift(`+${award.xp} XP${award.levelAfter > award.levelBefore ? ` · Level ${award.levelBefore} → ${award.levelAfter} (spend the stat point in Design)` : ""}`);
      // items used in real battles are used up
      const usedItem = m.turns.some((t) => t.actions[0].kind === "item");
      if (usedItem && b.me.item) { S.progress.inventory[b.me.item] = Math.max(0, (S.progress.inventory[b.me.item] || 0) - 1); saveProgress(); lines.push(`${E.ITEMS[b.me.item].name} used up (${S.progress.inventory[b.me.item]} left).`); }
      if (b.kind === "rival") {
        const rv = E.RIVALS.find((r) => r.id === b.target.id);
        if (award.result === "win") {
          const first = !S.progress.beaten.includes(rv.id);
          const reward = ECON.rivalReward(rv.level, first);
          if (first) S.progress.beaten = [...S.progress.beaten, rv.id];
          earn(reward, `${first ? "First win" : "Win"} vs ${rv.name}`, rv.id);
          lines.push(`+${reward} Cycles.`);
          const i = E.RIVALS.findIndex((r) => r.id === rv.id), next = E.RIVALS[i + 1];
          if (first) lines.push(next ? `${rv.name} beaten. ${next.name} is unlocked.` : "You beat the champion. The ladder is yours.");
          if (first && next) S.rivalId = next.id;
          refreshLadder();
        }
      }
      if (b.kind === "arena") {
        lines.push(recordResult(b, m) ? "Result recorded on the arena leaderboard." : "This result isn't recorded (you need Contributor access and a sign-in).");
        const own = b.target.owner === S.me.id;
        const paid = ECON.payArena(S.progress.wallet, award.result, own, `${b.target.owner}/${b.target.id}`);
        if (paid.amount) { S.progress.wallet = paid.wallet; saveProgress(); lines.push(`+${paid.amount} Cycles.`); }
        else if (own) lines.push("No Cycles for beating your own fighter.");
        else if (!paid.amount) lines.push("Today's arena rewards are used up; more tomorrow.");
      }
      queueReview(f.id, A.battleSummary(m, 0, f));
    }
    const res = m.winner === null ? "Draw" : m.winner === 0 ? "Victory" : "Defeat";
    const s = out.stats;
    $("battle-result").innerHTML = `<div class="box">
      <div class="outcome">${res} vs ${esc(b.foe.name)}</div>
      ${lines.map((l) => `<p class="small" style="margin:0">${esc(l)}</p>`).join("")}
      <p class="note" style="margin:0">${s.ai} actions by Claude${b.overclock ? " (overclocked)" : ""}, ${s.rule || 0} by battle rules, ${s.instinct} by instinct.</p>
      <div class="row"><button class="btn primary" type="button" id="again">Rematch</button></div>
      <div data-coach-box>${coachHtml()}</div>
    </div>`;
    renderActiveBar(); renderWallet(); refreshAiUi();
  }
  /** Watch a finished practice round again (no AI, no XP). */
  async function playReplay(lb) {
    const me = active();
    stopBattle();
    const b = { seq: ++battleSeq, kind: "replay", me, foe: lb.foe, useAi: false, queue: lb.match.turns.slice(), done: true, finished: false, cancelled: false,
                out: { match: lb.match, stats: { ai: 0, instinct: 0 } }, label: lb.label };
    S.battle = b;
    prepareScene(me, lb.foe, lb.label);
    setControls(true);
    try { await animateBattle(b, () => Promise.resolve()); } catch (e) { if (!(e instanceof Cancel)) console.error(e); }
  }

  // ---------- boot ----------
  loadLocal();
  if (S.fighters.length) S.tab = "roster"; else openDesigner(null);
  render();
  connect();
})();
