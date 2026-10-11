/* Fighter Lab app: UI, storage, AI battles, rivals and the arena. */
(() => {
  "use strict";
  const E = window.FighterEngine, A = window.FighterAgent, SP = window.FighterSprites;
  const $ = (id) => document.getElementById(id);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const STYLE_VAR = { aggro: "var(--st-aggro)", social: "var(--st-social)", mind: "var(--st-mind)", guard: "var(--st-guard)" };
  const NAMES = ["NOVA", "RIVET", "EMBER", "QUILL", "VOLT", "MOSS", "ONYX", "PIXEL", "TANGO", "ZEPHYR", "BRAMBLE", "COMET"];
  const LOCAL_KEY = "fighterlab.v2", OLD_KEY = "fighterlab.v1";
  const ARENA_MAX = 6, RESULTS_MAX = 150;
  const PERMANENT_AI_CODES = new Set(["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"]);

  // ---------- state ----------
  const S = {
    fighters: [], deleted: [], progress: { beaten: [], rev: 0 },
    activeId: null, tab: "design", draft: null, editingId: null, confirmDelete: false,
    partnerId: "brawler", reps: 10, report: null,
    coach: { busy: false, forId: null, comment: "", playbook: "", error: "", pending: null },
    rivalId: null, aiOn: true,
    ai: { sample: null, ready: false, off: false, reason: "" },
    me: { id: null, user: null, canWrite: null },
    arena: { db: null, docs: {}, raw: {}, results: {}, resultsRaw: {}, loaded: false, error: "", ratings: {} },
    store: { mode: "starting", pending: 0, failed: {}, slow: false, coll: null },
    battle: null, lastBattle: null, pendingChallenge: null,
  };
  const active = () => S.fighters.find((f) => f.id === S.activeId) || null;
  const find = (id) => S.fighters.find((f) => f.id === id) || null;

  // ---------- local backup: always written first, so nothing waits on the network ----------
  function validOwn(f) {
    return f && typeof f.id === "string" && Array.isArray(f.moves) && f.moves.length === 4 && f.moves.every((m) => E.SKILLS[m])
      && f.brain && Array.isArray(f.brain.W);
  }
  function loadLocal() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"); } catch { data = null; }
    if (!data) {
      try { const old = JSON.parse(localStorage.getItem(OLD_KEY) || "null"); if (Array.isArray(old)) data = { fighters: old }; } catch { /* none */ }
    }
    data = data && typeof data === "object" ? data : {};
    S.fighters = (Array.isArray(data.fighters) ? data.fighters : []).filter(validOwn).map(E.upgradeFighter);
    S.deleted = Array.isArray(data.deleted) ? data.deleted.filter((x) => typeof x === "string") : [];
    if (data.progress && Array.isArray(data.progress.beaten)) S.progress = { beaten: data.progress.beaten.slice(), rev: data.progress.rev || 0 };
    S.activeId = find(data.activeId) ? data.activeId : S.fighters[0]?.id || null;
    sortFighters();
  }
  function saveLocal() {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ fighters: S.fighters, deleted: S.deleted, progress: S.progress, activeId: S.activeId })); }
    catch { /* storage blocked: the account copy still saves */ }
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
    // take it out of the arena too
    if (myArenaList().some((p) => p.id === id)) unpublish(id);
  }
  function saveProgress() {
    S.progress = { ...S.progress, rev: (S.progress.rev || 0) + 1 };
    saveLocal();
    if (S.store.coll) enqueue("progress", () => S.store.coll.doc("progress").set({ kind: "progress", ...E.clone(S.progress) }));
  }
  function mergeRemote(docs, initial, changes) {
    const remoteRev = {};
    for (const d of docs) {
      const data = d.data();
      if (!data) continue;
      if (d.id === "progress") {
        if ((data.rev || 0) > (S.progress.rev || 0) && Array.isArray(data.beaten)) S.progress = { beaten: data.beaten.slice(), rev: data.rev };
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
      // fighters made on this device (or saved by the old version) go up to the account
      for (const f of S.fighters) if (!(f.id in remoteRev) || remoteRev[f.id] < (f.rev || 0)) enqueue("f:" + f.id, writeFighter(f.id));
      for (const id of S.deleted) if (!(id in remoteRev)) S.deleted = S.deleted.filter((x) => x !== id);
      if ((S.progress.rev || 0) > 0) enqueue("progress", () => S.store.coll.doc("progress").set({ kind: "progress", ...E.clone(S.progress) }));
    }
    sortFighters();
    if (!active()) S.activeId = S.fighters[0]?.id || null;
    saveLocal();
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
    S.me.id = uid;
    if (user) user.can("data.write").then((v) => { S.me.canWrite = v; if (S.tab === "arena") render(); }, () => {});
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
    for (const s of spans) {
      const id = s.dataset.owner;
      s.textContent = id === S.me.id ? "you" : (ps[id] && ps[id].name) || "a player";
    }
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
    bar.innerHTML = `<div class="active">
      <canvas data-sprite="${esc(f.id)}" width="28" height="28" aria-hidden="true"></canvas>
      <div class="who"><span class="name">${esc(f.name)}</span>
        <span class="lv">LV ${f.level} · Battles ${br.w}W ${br.l}L ${br.d}D · ${next}</span>
        <span class="xpbar"><span style="width:${Math.round(levelProgress(f) * 100)}%"></span></span></div>
    </div>`;
    paintSprites(bar);
  }

  // ---------- tabs ----------
  function battleRunning() { return !!(S.battle && !S.battle.finished); }
  function setTab(tab) {
    if (tab === S.tab) return;
    if (battleRunning()) { stopBattle(); toast("Battle stopped. No XP was given."); }
    S.tab = tab;
    if (tab === "design" && !S.draft) openDesigner(S.activeId);
    render();
    window.scrollTo({ top: 0 });
  }
  document.querySelector(".tabs").addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) setTab(b.dataset.tab); });
  function render() {
    for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t.dataset.tab === S.tab));
    renderActiveBar();
    const v = $("view");
    v.onclick = v.oninput = v.onchange = null;
    if (S.tab === "roster") renderRoster(v);
    else if (S.tab === "design") renderDesigner(v);
    else if (S.tab === "gym") renderGym(v);
    else if (S.tab === "battle") renderBattle(v);
    else renderArena(v);
  }
  // Re-render after background data arrives, without disturbing typing or a battle in progress.
  function softRender() {
    renderActiveBar();
    if (S.tab === "design" || S.tab === "battle") return;
    render();
  }

  // ---------- roster ----------
  function renderRoster(v) {
    const published = new Set(myArenaList().map((p) => p.id));
    const cards = S.fighters.map((f) => `<button class="card" type="button" data-pick="${esc(f.id)}" aria-pressed="${f.id === S.activeId}">
        <canvas data-sprite="${esc(f.id)}" width="28" height="28" aria-hidden="true"></canvas>
        <span class="name">${esc(f.name)}</span>
        <span class="lv">LV ${f.level}${published.has(f.id) ? " · IN ARENA" : ""}</span>
        <span class="small muted">${f.moves.map((m) => E.SKILLS[m].move).join(" · ")}</span>
      </button>`).join("");
    v.innerHTML = `<div class="box">
      <h2>Your fighters</h2>
      <p class="note">${S.fighters.length ? "Tap a fighter to make it active for the Gym, Battle and Arena." : "No fighters yet. Design your first one."}</p>
      <div class="cards">${cards}<button class="card new" type="button" data-new><b>+</b><span>New fighter</span></button></div>
    </div>
    <div class="box"><h2>How it works</h2>
      <p class="small" style="margin:0">Each fighter is an AI agent. In a battle, Claude picks every move for both sides, guided by each fighter's
      persona, the playbook its coach wrote, and the instincts it built in the gym. Train in the <b>Gym</b>, climb the rival ladder in
      <b>Battle</b>, and take on other players' fighters in the <b>Arena</b>.</p></div>`;
    paintSprites(v);
    v.onclick = (e) => {
      const pick = e.target.closest("[data-pick]");
      if (pick) { S.activeId = pick.dataset.pick; S.report = null; saveLocal(); render(); return; }
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
    S.draft = f ? { name: f.name, design: { ...f.design }, personality: { ...f.personality }, moves: f.moves.slice(), persona: f.persona || "", playbook: f.playbook || "" }
      : { name: NAMES[Math.floor(Math.random() * NAMES.length)], design: randomDesign(),
          personality: { aggression: 0.6, caution: 0.5, creativity: 0.5, loyalty: 0.4 }, moves: ["fight", "talk", "strategize", "shield"],
          persona: "Reads the opponent for a turn, then hits the counter hard. Saves big moves for the endgame.", playbook: "" };
  }
  const seg = (field, value, options) => `<div class="seg" role="group">${options.map(([val, label]) =>
    `<button type="button" data-seg="${field}" data-val="${esc(val)}" aria-pressed="${String(val) === String(value)}">${label}</button>`).join("")}</div>`;
  const TRAIT_HELP = {
    aggression: "Starts out favoring Aggro moves.", caution: "Starts out favoring Guard moves.",
    creativity: "Starts out favoring Mind moves.", loyalty: "Starts out favoring Social moves.",
  };
  function coverageNote(moves) {
    const have = new Set(moves.map((m) => E.SKILLS[m].style));
    const missing = E.STYLES.filter((s) => !have.has(s));
    if (!missing.length) return `<p class="note">Covers all four styles, so it can counter anything.</p>`;
    return `<p class="warn">${missing.map((s) => {
      const beaten = E.STYLES.find((x) => E.BEATS[s] === x);
      return `No ${E.STYLE_INFO[s].label} move: nothing counters ${E.STYLE_INFO[beaten].label}.`;
    }).join(" ")}</p>`;
  }
  function renderDesigner(v) {
    const d = S.draft, editing = S.editingId && find(S.editingId);
    const trained = editing && editing.xp > 0;
    const dropped = editing ? editing.moves.filter((m) => !d.moves.includes(m)) : [];
    const skillBtns = E.STYLES.map((st) => `<div class="style-col" style="--c:${STYLE_VAR[st]}">
        <div class="style-head"><span class="dot" aria-hidden="true"></span>${E.STYLE_INFO[st].label}</div>
        <p class="note" style="margin:0">${E.STYLE_INFO[st].blurb}</p>
        ${E.SKILL_NAMES.filter((s) => E.SKILLS[s].style === st).map((s) => `<button type="button" class="skill" data-skill="${s}" aria-pressed="${d.moves.includes(s)}">
          <span><span class="mv">${E.SKILLS[s].move}</span> <span class="small muted">${s}</span></span><span class="pw">PWR ${E.SKILLS[s].power}</span></button>`).join("")}
      </div>`).join("");
    const canSave = d.moves.length === 4 && d.name.trim();
    v.innerHTML = `<div class="two">
      <div class="box">
        <h2>${editing ? "Edit fighter" : "New fighter"}</h2>
        <div class="stage"><div class="pad"></div><canvas data-sprite="draft" width="28" height="28" role="img" aria-label="Preview"></canvas></div>
        <div class="row"><button class="btn" type="button" id="randomize">Randomize look</button></div>
        ${!S.fighters.length ? `<p class="note">A starting design. Change anything, then create your fighter.</p>` : ""}
      </div>
      <div class="panel">
        <div class="box">
          <div class="field"><label for="f-name">Name</label>
            <input type="text" id="f-name" maxlength="16" value="${esc(d.name)}" autocomplete="off" spellcheck="false"></div>
        </div>
        <div class="box">
          <h2>Mind</h2>
          <div class="field"><label for="f-persona">Persona: how your fighter thinks</label>
            <textarea id="f-persona" maxlength="${E.PERSONA_MAX}" rows="3" placeholder="e.g. Patient. Opens with defense, punishes repetition, goes all in when points double.">${esc(d.persona)}</textarea>
            <span class="count" id="c-persona">${d.persona.length} / ${E.PERSONA_MAX}</span></div>
          <div class="field"><label for="f-playbook">Playbook: lessons from training</label>
            <textarea id="f-playbook" maxlength="${E.PLAYBOOK_MAX}" rows="5" placeholder="Your coach writes this after gym sessions and battles. You can edit it too.">${esc(d.playbook)}</textarea>
            <span class="count" id="c-playbook">${d.playbook.length} / ${E.PLAYBOOK_MAX}</span></div>
          <p class="note">Claude reads both before every move your fighter makes.</p>
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
          <h2>Instincts</h2>
          <p class="note">Personality sets your fighter's starting instincts. Gym practice then trains them.</p>
          <div class="grid2">${E.TRAITS.map((t) => `<div class="trait">
            <div class="top-line"><label for="t-${t}">${t[0].toUpperCase() + t.slice(1)}</label><b id="tv-${t}">${Math.round(d.personality[t] * 100)}</b></div>
            <input type="range" id="t-${t}" data-trait="${t}" min="0" max="1" step="0.05" value="${d.personality[t]}">
            <span class="note">${TRAIT_HELP[t]}</span></div>`).join("")}</div>
        </div>
        <div class="box">
          <h2>Moves · ${d.moves.length} of 4 picked</h2>
          <p class="note">Each style beats the next: Aggro → Social → Mind → Guard → Aggro. Effective hits do double damage, resisted hits half.</p>
          <div class="styles">${skillBtns}</div>
          ${d.moves.length === 4 ? coverageNote(d.moves) : `<p class="warn">Pick ${4 - d.moves.length} more.</p>`}
          ${trained && dropped.length ? `<p class="warn">${dropped.map((m) => E.SKILLS[m].move).join(" and ")} will lose ${dropped.length > 1 ? "their" : "its"} training. Moves you keep stay trained.</p>` : ""}
        </div>
        <div class="box">
          <div class="row">
            <button class="btn primary" type="button" id="save" ${canSave ? "" : "disabled"}>${editing ? "Save changes" : "Create fighter"}</button>
            ${editing ? (S.confirmDelete
              ? `<span class="small">Delete ${esc(editing.name)} and all its training?</span><button class="btn danger" type="button" id="del-yes">Delete</button><button class="btn" type="button" id="del-no">Keep</button>`
              : `<button class="btn danger" type="button" id="del">Delete fighter</button>`) : ""}
          </div>
          ${d.moves.length === 4 ? `<div class="field"><span class="lab">Register this design on aipvp</span>
            <div class="code"><pre id="cmd">${esc(E.aipvpCommand({ name: d.name || "FIGHTER", moves: d.moves, personality: d.personality }))}</pre><button class="btn" type="button" id="copy">Copy</button></div>
            <span class="note">Creates the agent on aipvp.io with these moves and personality. Training here stays in Fighter Lab.</span></div>` : ""}
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
  function refreshCommand() {
    const pre = $("cmd"), d = S.draft;
    if (pre && d.moves.length === 4) pre.textContent = E.aipvpCommand({ name: d.name || "FIGHTER", moves: d.moves, personality: d.personality });
  }
  function bindDesigner(v) {
    const d = S.draft;
    v.onclick = async (e) => {
      const sg = e.target.closest("[data-seg]");
      if (sg) {
        const f = sg.dataset.seg, raw = sg.dataset.val;
        d.design[f] = f === "spikes" ? +raw : f === "armor" ? raw === "true" : raw;
        for (const b of sg.parentElement.children) b.setAttribute("aria-pressed", String(b === sg));
        refreshPreview(v); return;
      }
      const sk = e.target.closest("[data-skill]");
      if (sk) {
        const s = sk.dataset.skill, i = d.moves.indexOf(s);
        if (i >= 0) d.moves.splice(i, 1);
        else if (d.moves.length < 4) d.moves.push(s);
        else { toast("A fighter has 4 moves. Unpick one first."); return; }
        renderDesigner(v); return;
      }
      const id = e.target.id;
      if (id === "randomize") { d.design = randomDesign(); renderDesigner(v); return; }
      if (id === "copy") {
        try { await navigator.clipboard.writeText($("cmd").textContent); toast("Copied."); }
        catch { const r = document.createRange(); r.selectNodeContents($("cmd")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast("Selected. Copy it from here."); }
        return;
      }
      if (id === "del") { S.confirmDelete = true; renderDesigner(v); return; }
      if (id === "del-no") { S.confirmDelete = false; renderDesigner(v); return; }
      if (id === "del-yes") {
        const name = find(S.editingId)?.name;
        deleteFighter(S.editingId);
        S.draft = null; S.editingId = null; S.tab = "roster"; render(); toast(`${name} deleted.`); return;
      }
      if (id === "save") {
        const name = d.name.trim().toUpperCase();
        try {
          const editing = S.editingId && find(S.editingId);
          let f = editing ? E.redesign(editing, { name, design: d.design, personality: d.personality, moves: d.moves })
                          : E.upgradeFighter(E.createFighter({ name, design: d.design, personality: d.personality, moves: d.moves }));
          f.persona = E.cleanText(d.persona, E.PERSONA_MAX, false);
          f.playbook = E.cleanText(d.playbook, E.PLAYBOOK_MAX, true);
          f = saveFighter(f);              // returns at once; the account copy saves in the background
          S.activeId = f.id; S.draft = null; S.editingId = null; S.report = null; saveLocal();
          toast(editing ? "Saved." : `${f.name} is ready. Take it to the Gym.`);
          S.tab = editing ? "roster" : "gym"; render();
        } catch (err) { toast(err.message); }
      }
    };
    v.oninput = (e) => {
      const t = e.target;
      if (t.id === "f-name") {
        d.name = t.value.toUpperCase().replace(/[^A-Z0-9 '\-]/g, "");
        if (t.value !== d.name) t.value = d.name;
        $("save").disabled = d.moves.length !== 4 || !d.name.trim(); return;
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
    v.onchange = (e) => { if (e.target.dataset.trait || e.target.id === "f-name") refreshCommand(); };
  }

  // ---------- AI availability ----------
  function aiUsable() { return !!(S.ai.sample && !S.ai.off && S.aiOn); }
  function aiStatusText() {
    if (!S.ai.ready) return "Checking whether Claude is available…";
    if (!S.ai.sample) return "Claude isn't available in this view, so battles run on instincts. Open the game on claude.ai or in the Claude app to use AI battles.";
    if (S.ai.off) return S.ai.reason;
    if (!S.aiOn) return "AI is off: battles run on instincts and use no Claude requests.";
    return "Claude plays every move for both fighters: about 24 short requests from your Claude account per battle. You'll be asked to allow it the first time.";
  }
  function refreshAiUi() {
    const sw = $("ai-switch"); if (sw) { sw.setAttribute("aria-checked", String(aiUsable())); sw.disabled = !(S.ai.sample && !S.ai.off); }
    const st = $("ai-status"); if (st) st.textContent = aiStatusText();
  }
  function noteAiError(code) {
    if (PERMANENT_AI_CODES.has(code)) { S.ai.off = true; S.ai.reason = A.REASON_TEXT[code] || A.REASON_TEXT.unavailable; }
  }

  // ---------- coach ----------
  // Gym sessions come in bursts: wait until training pauses, then review them all in one request.
  let coachTimer = 0;
  function coachSoon(id, summary) {
    if (!aiUsable()) return;
    const prev = S.coach.pending && S.coach.pending.id === id ? S.coach.pending.summary + "\n\n" : "";
    S.coach.pending = { id, summary: (prev + summary).slice(-3000) };
    renderCoachBox();
    clearTimeout(coachTimer);
    coachTimer = setTimeout(() => {
      if (S.coach.busy || battleRunning()) return;          // picked up when the current review or battle ends
      const next = S.coach.pending; S.coach.pending = null;
      if (next) coachAfter(next.id, next.summary);
    }, 3000);
  }
  function coachAfter(id, summary) {
    if (!aiUsable()) return;
    if (S.coach.busy || battleRunning()) {
      const prev = S.coach.pending && S.coach.pending.id === id ? S.coach.pending.summary + "\n\n" : "";
      S.coach.pending = { id, summary: (prev + summary).slice(-3000) };
      return;
    }
    const f = find(id);
    if (!f) return;
    S.coach = { busy: true, forId: id, comment: "", playbook: "", error: "", pending: null };
    renderCoachBox();
    A.coach(S.ai.sample, f, summary).then((out) => {
      const latest = find(id);
      if (latest) saveFighter({ ...latest, playbook: out.playbook });   // only the playbook changes
      S.coach = { ...S.coach, busy: false, comment: out.comment, playbook: out.playbook };
    }, (e) => {
      const code = e && e.code;
      noteAiError(code);
      const msg = code === "rate_limited" ? "The coach is busy right now (rate limited). It will review your next session."
        : code === "not_granted" ? "The coach needs permission to use Claude." : "The coach couldn't review this one.";
      S.coach = { ...S.coach, busy: false, error: msg };
    }).finally(() => {
      renderCoachBox(); renderActiveBar();
      const next = S.coach.pending;
      if (next) { S.coach.pending = null; setTimeout(() => coachAfter(next.id, next.summary), 500); }
    });
  }
  function coachHtml() {
    const c = S.coach, f = active();
    if (!f) return "";
    if (!c.busy && c.pending && c.pending.id === f.id) return `<div class="coach"><span class="lab">Coach review</span><span class="small muted">The coach will review your training when you take a short break.</span></div>`;
    if (c.forId !== f.id) return "";
    if (c.busy) return `<div class="coach"><span class="lab">Coach review</span><span class="dots">Reviewing the session</span></div>`;
    if (c.error) return `<div class="coach"><span class="lab">Coach review</span><span class="small">${esc(c.error)}</span></div>`;
    if (c.playbook) return `<div class="coach"><span class="lab">Coach review</span>${c.comment ? `<span class="small"><b>${esc(c.comment)}</b></span>` : ""}
      <span class="small muted">New playbook (your fighter reads this before every move):</span><pre>${esc(c.playbook)}</pre></div>`;
    return "";
  }
  function renderCoachBox() { const el = $("coach-box"); if (el) el.innerHTML = coachHtml(); }

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
    const partner = E.PARTNERS.find((p) => p.id === S.partnerId);
    const rep = S.report && S.report.fighterId === f.id ? S.report : null;
    v.innerHTML = `<div class="two">
      <div class="panel">
        <div class="box">
          <h2>Sparring partner</h2>
          <div class="partners">${partnerCards(f.level, S.partnerId)}</div>
          <p class="note">${esc(partner.blurb)}</p>
          <div class="field"><span class="lab">Rounds</span>${seg("reps", S.reps, [[1, "1"], [10, "10"], [50, "50"]])}</div>
          <div class="row"><button class="btn primary" type="button" id="train">Train ${S.reps} round${S.reps > 1 ? "s" : ""}</button></div>
          <p class="note">Practice is instant and uses no Claude requests. It builds XP, mastery and instincts. ${aiUsable() ? "Afterwards your AI coach rewrites the playbook." : ""}</p>
        </div>
        ${rep ? reportBox(rep) : ""}
        <div id="coach-box">${coachHtml()}</div>
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
          <p class="note">The move its instincts favor in each situation. Claude sees this before every move.</p>
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
      if (e.target.id === "watch-last" && S.report) { S.lastBattle = { match: S.report.lastMatch, foe: S.report.lastFoe, label: "Last practice round" }; setTab("battle"); }
    };
  }
  function winPct(rec) { const n = rec.w + rec.l + rec.d; return n ? Math.round(((rec.w + rec.d / 2) / n) * 100) + "%" : "–"; }
  function doTrain() {
    const f = active();
    if (!f) return;
    try {
      const { fighter, report } = E.train(f, S.partnerId, S.reps);
      report.lastFoe = E.partnerFighter(S.partnerId, f);
      report.fighterId = f.id;
      saveFighter(fighter);                    // never waits on the network
      S.report = report;
      render();
      if (report.levelAfter > report.levelBefore) toast(`Level up! ${fighter.name} is now level ${report.levelAfter}.`);
      coachSoon(f.id, A.gymSummary(report));
    } catch (err) { toast(err.message); }
  }
  function reportBox(r) {
    const p = E.PARTNERS.find((x) => x.id === r.partner);
    const parts = [`${r.win} win${r.win === 1 ? "" : "s"}`, r.draw ? `${r.draw} draw${r.draw === 1 ? "" : "s"}` : "", `${r.loss} loss${r.loss === 1 ? "" : "es"}`].filter(Boolean);
    const rows = r.mastery.map((m) => `<div class="mrow" style="--c:${STYLE_VAR[E.SKILLS[m.move].style]}">
        <span class="mv">${E.SKILLS[m.move].move}</span>
        <span class="mtrack"><span class="was" style="width:${(m.before / 0.5) * 100}%"></span><span class="now" style="width:${(m.after / 0.5) * 100}%"></span></span>
        <span class="val">+${Math.round(m.after * 100)}%</span></div>`).join("");
    return `<div class="box">
      <h2>Session report · vs ${esc(p.name)}</h2>
      <div class="report-head">${parts.join(", ")}</div>
      <div class="row"><span class="badge">+${r.xpGained} XP</span>${r.levelAfter > r.levelBefore ? `<span class="badge">LEVEL ${r.levelBefore} → ${r.levelAfter}</span>` : ""}</div>
      <div class="field"><span class="lab">Move mastery (bonus damage, max +50%)</span><div class="mastery">${rows}</div></div>
      <div class="row"><button class="btn" type="button" id="watch-last">Watch the last round</button></div>
    </div>`;
  }
  function brainRows(f) {
    return `<div class="brain">${E.brainMap(f).map((row) => {
      const sk = E.SKILLS[row.best], c = STYLE_VAR[sk.style];
      const ctx = row.vs ? `After their ${E.STYLE_INFO[row.vs].label} move` : "First move";
      return `<div class="brow" style="--c:${c}"><span class="ctx">${ctx}</span>
        <span class="ans"><span class="chip">${sk.move}</span><span class="conf"><span style="width:${Math.round(row.confidence * 100)}%"></span></span>
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
    const rv = E.RIVALS.find((r) => r.id === S.rivalId);
    const pending = S.pendingChallenge;
    v.innerHTML = `
      ${pending ? "" : `<div class="box" id="ladder">${ladderHtml()}</div>`}
      <div class="box">
        <div class="airow"><button class="switch" type="button" role="switch" id="ai-switch" aria-checked="${aiUsable()}" aria-label="Claude plays every move"
          ${S.ai.sample && !S.ai.off ? "" : "disabled"}></button><b class="small">Claude plays every move</b></div>
        <p class="note" id="ai-status" style="margin:0">${esc(aiStatusText())}</p>
      </div>
      ${sceneHtml(f)}
      <div id="battle-result"></div>
      <div class="box"><h2>Battle log</h2><ol class="log" id="log"></ol></div>`;
    void rv;
    renderBattleBody(v, pending);
  }
  function ladderHtml() {
    const rivals = E.RIVALS.map((rv, i) => {
      const st = rivalState(i);
      return `<button type="button" class="rival${st === "locked" ? " locked" : ""}" data-rival="${rv.id}" aria-pressed="${rv.id === S.rivalId}" ${st === "locked" ? 'aria-disabled="true"' : ""}>
        <canvas data-sprite="r:${rv.id}" width="28" height="28" aria-hidden="true"></canvas>
        <span class="name">${esc(rv.name)} <span class="lv">LV ${rv.level}</span></span>
        <span class="tag ${st}">${st === "won" ? "BEATEN" : st === "next" ? "NEXT UP" : "LOCKED"}</span>
        <span class="blurb">${st === "locked" ? `Beat ${esc(E.RIVALS[i - 1].name)} to unlock.` : esc(rv.persona)}</span></button>`;
    }).join("");
    const rv = E.RIVALS.find((r) => r.id === S.rivalId) || E.RIVALS[0];
    return `<h2>Rival ladder</h2>
        <div class="rivals">${rivals}</div>
        <div class="row"><button class="btn primary" type="button" id="fight" ${battleRunning() ? "disabled" : ""}>Fight ${esc(rv.name)}</button></div>`;
  }
  function refreshLadder() {
    const l = $("ladder");
    if (l) { l.innerHTML = ladderHtml(); paintSprites(l); }
  }
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
        return;
      }
      if (e.target.id === "ai-switch") {
        S.aiOn = !S.aiOn; e.target.setAttribute("aria-checked", String(aiUsable())); $("ai-status").textContent = aiStatusText(); return;
      }
      if (e.target.id === "fight") { if (!battleRunning()) startBattle("rival", { id: S.rivalId }); return; }
      if (e.target.id === "b-stop") { if (battleRunning()) { stopBattle(); $("text").textContent = "Battle stopped. No XP was given."; setControls(false); } return; }
      if (e.target.id === "b-play") { togglePause(e.target); return; }
      if (e.target.id === "b-speed") { cycleSpeed(e.target); return; }
      if (e.target.id === "again" && S.battle && S.battle.finished) { const b = S.battle; startBattle(b.kind, b.target); return; }
    };
    if (pending) { S.pendingChallenge = null; startBattle("arena", pending); }
    else if (S.lastBattle) { const lb = S.lastBattle; S.lastBattle = null; playReplay(lb); }
  }
  function sceneHtml(f) {
    return `<div class="console">
      <div class="scene" id="scene">
        <div class="pad foe"></div><div class="pad player"></div>
        <canvas class="mon foe" id="mon-foe" width="28" height="28" role="img" aria-label="Opponent"></canvas>
        <canvas class="mon player" id="mon-player" width="28" height="28" role="img" aria-label="${esc(f.name)}"></canvas>
        <div class="hud foe"><div class="hud-row"><span class="hud-name" id="name-foe">???</span><span class="hud-lv" id="lv-foe"></span></div>
          <div class="hp"><span class="hp-label">HP</span><span class="hp-track"><span class="hp-fill" id="hp-foe"></span></span></div></div>
        <div class="hud player"><div class="hud-row"><span class="hud-name" id="name-player">${esc(f.name)}</span><span class="hud-lv" id="lv-player">LV ${f.level}</span></div>
          <div class="hp"><span class="hp-label">HP</span><span class="hp-track"><span class="hp-fill" id="hp-player"></span></span></div>
          <div class="hp-num" id="hpnum-player"></div></div>
        <div class="banner" id="banner"></div>
        <canvas class="fx" id="fx"></canvas>
      </div>
      <div class="textbox"><p id="text">Pick a rival and press Fight.</p></div>
      <div class="sr-only" aria-live="polite" id="announce"></div>
      <div class="controls">
        <button class="btn primary" type="button" id="b-play" disabled>Pause</button>
        <button class="btn" type="button" id="b-speed">${B.speed}×</button>
        <button class="btn" type="button" id="b-stop" disabled>Stop</button>
        <span class="readout" id="readout">Ready</span>
      </div>
    </div>`;
  }

  // ---------- arena tab ----------
  function renderArena(v) {
    const f = active();
    const uid = S.me.id;
    const rows = [];
    for (const [owner, list] of Object.entries(S.arena.docs)) {
      for (const p of list) {
        const r = S.arena.ratings[`${owner}/${p.id}`] || { rating: 1000, w: 0, l: 0, d: 0 };
        rows.push({ owner, p, ...r });
      }
    }
    rows.sort((a, b) => b.rating - a.rating || b.w - a.w || a.p.name.localeCompare(b.p.name));
    const mine = f ? myArenaList().find((p) => p.id === f.id) : null;
    let pubBox = "";
    if (!S.arena.db) pubBox = `<p class="note">The arena needs claude.ai storage, which isn't available in this view.</p>`;
    else if (!uid) pubBox = `<p class="note">Sign in to claude.ai to publish fighters.</p>`;
    else if (S.me.canWrite === false) pubBox = `<p class="note">You have view-only access, so you can challenge fighters but not publish or record results. Ask the owner for Contributor access.</p>`;
    else if (!f) pubBox = `<p class="note">Create a fighter to publish it.</p>`;
    else {
      const outdated = mine && (mine.level !== f.level || mine.playbook !== f.playbook || mine.persona !== f.persona || mine.moves.join() !== f.moves.join());
      pubBox = `<p class="small" style="margin:0">${mine ? (outdated ? `${esc(f.name)} is in the arena, but at an older version (level ${mine.level}). Update it to share its latest training.` : `${esc(f.name)} is in the arena with its latest training.`)
        : `Publish ${esc(f.name)} so other players can challenge it. Its design, persona, playbook and instincts are shared.`}</p>
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
        <p class="small" style="margin:0">Fighters published by everyone who plays this game. When you challenge one, Claude plays both sides, each with its own persona, playbook and instincts. The requests come from your Claude account.</p>
        ${pubBox}
      </div>
      <div class="box"><h2>Leaderboard</h2>${table}
        <p class="note">To bring friends in, share this game with them as Contributors (Share menu). Results are worked out in the challenger's browser and fighters' stats are reported by their owners, so this is a friendly league, not a tamper-proof one.</p>
      </div>`;
    paintSprites(v);
    fillOwnerNames(v);
    v.onclick = (e) => {
      if (e.target.id === "publish" && f) { publish(f); render(); return; }
      if (e.target.id === "unpublish" && f) { unpublish(f.id); toast(`${f.name} left the arena.`); render(); return; }
      const ch = e.target.closest("[data-challenge]");
      if (ch && f) {
        const [owner, id] = ch.dataset.challenge.split("|");
        S.pendingChallenge = { owner, id };
        setTab("battle");
      }
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
  function togglePause(btn) {
    B.paused = !B.paused; btn.textContent = B.paused ? "Play" : "Pause";
    if (!B.paused) B.waiters.splice(0).forEach((fn) => fn());
  }
  function cycleSpeed(btn) {
    B.speed = B.speed === 1 ? 2 : B.speed === 2 ? 4 : 1;
    document.documentElement.style.setProperty("--spd", B.speed); btn.textContent = B.speed + "×";
  }
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
    else for (let i = 1; i <= text.length; i++) { el.textContent = text.slice(0, i); await sleep(b, 16); }
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
  function logLine(turn, a) {
    const sk = E.SKILLS[a.skill];
    const li = document.createElement("li");
    const eff = a.effect === "super" ? " · super effective" : a.effect === "resisted" ? " · resisted" : "";
    li.innerHTML = `<span class="t">T${String(turn).padStart(2, "0")}</span><span class="chip" style="--c:${STYLE_VAR[sk.style]}">${sk.move}</span>
      <span class="who">${esc(a.agent_name)} <span class="src ${a.source === "ai" ? "ai" : ""}">${a.source === "ai" ? "AI" : "INSTINCT"}</span></span>
      <span class="pts">−${a.points.toFixed(1)} HP${eff}</span>${a.line ? `<span class="said">“${esc(a.line)}”</span>` : ""}`;
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
    $("log").innerHTML = ""; $("battle-result").innerHTML = "";
    $("banner").className = "banner"; $("banner").textContent = "";
    for (const side of ["player", "foe"]) $("mon-" + side).className = "mon " + side;
    $("name-foe").textContent = foe.name; $("lv-foe").textContent = "LV " + (foe.level || 1);
    $("name-player").textContent = me.name; $("lv-player").textContent = "LV " + me.level;
    SP.draw($("mon-foe"), foe, {}); SP.draw($("mon-player"), me, { back: true });
    $("mon-foe").setAttribute("aria-label", foe.name);
    setHp("player", E.maxHp(me.level), E.maxHp(me.level)); setHp("foe", E.maxHp(foe.level || 1), E.maxHp(foe.level || 1));
    $("readout").textContent = label;
  }

  /** Start a real battle: Claude (or instincts) choose, turns animate as they arrive. */
  function startBattle(kind, target) {
    const me = active();
    if (!me || !$("scene")) return;
    stopBattle();
    let foe, label;
    if (kind === "rival") { foe = E.rivalFighter(target.id); label = "Rival battle"; }
    else {
      foe = (S.arena.docs[target.owner] || []).find((p) => p.id === target.id);
      if (!foe) { toast("That fighter has left the arena."); return; }
      foe = E.clone(foe); label = "Arena challenge";
    }
    const useAi = aiUsable();
    const b = { seq: ++battleSeq, kind, target, me: E.clone(me), foe, useAi, queue: [], done: false, finished: false, cancelled: false,
                out: null, error: null, ctl: new AbortController(), wake: null, paceWake: null, label };
    S.battle = b;
    prepareScene(b.me, foe, label);
    setControls(true);
    $("scene").closest(".console").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    const nextEvent = () => new Promise((res) => { b.wake = res; });
    const signalEvent = () => { const w = b.wake; b.wake = null; if (w) w(); };
    A.runAiBattle({
      a: b.me, b: foe, sample: useAi ? S.ai.sample : null, signal: b.ctl.signal, learnA: true,
      onTurn: (t) => { b.queue.push(t); signalEvent(); },
      // stay at most one turn ahead of the animation, so Stop wastes little
      pace: () => (b.queue.length < 1 ? Promise.resolve() : new Promise((res) => { b.paceWake = res; })),
    }).then((out) => { b.out = out; b.done = true; signalEvent(); },
      (err) => { if (!(err instanceof A.Cancelled)) { b.error = err; b.done = true; console.error(err); } signalEvent(); });
    animateBattle(b, nextEvent).catch((e) => { if (!(e instanceof Cancel)) console.error(e); });
  }
  async function animateBattle(b, nextEvent) {
    const me = b.me, foe = b.foe;
    const meMax = E.maxHp(me.level), foeMax = E.maxHp(foe.level || 1);
    await say(b, `${foe.name} wants to battle!`, 450);
    await say(b, `Go, ${me.name}!`, 350);
    const cur = [meMax, foeMax];
    let phase = null;
    for (;;) {
      await gate(b);
      if (b.queue.length) {
        const t = b.queue.shift();
        if (b.paceWake) { const w = b.paceWake; b.paceWake = null; w(); }
        if (t.phase !== phase) {
          phase = t.phase;
          $("banner").textContent = phase.toUpperCase() + (t.multiplier > 1 ? `  ×${t.multiplier}` : "");
          retrigger($("banner"), "show", 1500); await sleep(b, 1250);
        }
        $("readout").textContent = `Turn ${t.turn} / ${E.TURNS} · ${phase.toUpperCase()}`;
        for (let i = 0; i < 2; i++) {
          const a = t.actions[i], att = i === 0 ? "player" : "foe", def = i === 0 ? "foe" : "player";
          const sk = E.SKILLS[a.skill];
          if (a.line) await quote(b, a.agent_name, a.line, 1000);
          await say(b, `${a.agent_name} used ${sk.move}!`, 200);
          logLine(t.turn, a);
          const At = $("mon-" + att), D = $("mon-" + def);
          if (sk.fx === "burst" && !reduce) retrigger(At, "lunge-" + att, 420);
          if (sk.fx === "ghost") retrigger(At, "blink", 520);
          if (sk.fx === "barrier" || sk.fx === "sparkle") retrigger(At, "rise", 500);
          spawn(sk.fx, center(At), center(D), sk.color);
          await sleep(b, sk.fx === "scan" ? 850 : 520);
          retrigger(D, "hit", 480);
          if (!reduce && a.effect === "super") retrigger($("scene"), "shake", 380);
          const target = 1 - i;
          cur[target] = Math.max(0, cur[target] - a.points);
          setHp(def, cur[target], target === 0 ? meMax : foeMax);
          await sleep(b, 280);
          if (a.effect === "super") await say(b, "It's super effective!", 420);
          else if (a.effect === "resisted") await say(b, "It's not very effective…", 380);
        }
        cur[0] = t.hp[0]; cur[1] = t.hp[1];
        setHp("player", cur[0], meMax); setHp("foe", cur[1], foeMax);
        continue;
      }
      if (b.done) break;
      // waiting on Claude for the next turn
      if (b.useAi) textbox(`<span class="dots">${esc(me.name)} and ${esc(foe.name)} are thinking</span>`);
      await nextEvent();
    }
    await gate(b);
    if (b.error) { textbox("Something went wrong in this battle. Try again."); finishUi(b); return; }
    const m = b.out.match;
    const w = m.winner;
    $("readout").textContent = `Final · ${m.turns.length} turns`;
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
  function finishUi(b) {
    b.finished = true;
    setControls(false);
    const pc = S.coach.pending;
    if (pc) { S.coach.pending = null; coachAfter(pc.id, pc.summary); }
  }
  function applyResult(b) {
    const out = b.out, m = out.match;
    const latest = find(b.me.id);
    let lines = [];
    if (out.stoppedReason) { noteAiError(out.stoppedReason); lines.push(A.REASON_TEXT[out.stoppedReason] || A.REASON_TEXT.unavailable); }
    if (latest) {
      const award = E.awardBattle(latest, m, 0);
      const f = award.fighter;
      f.brain = E.compactBrain(out.fighterA.brain);          // instincts also learn from real battles
      f.uses = { ...f.uses, ...out.fighterA.uses };
      saveFighter(f);
      lines.unshift(`+${award.xp} XP${award.levelAfter > award.levelBefore ? ` · Level ${award.levelBefore} → ${award.levelAfter}` : ""}`);
      if (b.kind === "rival" && award.result === "win" && !S.progress.beaten.includes(b.target.id)) {
        S.progress.beaten = [...S.progress.beaten, b.target.id];
        saveProgress();
        const i = E.RIVALS.findIndex((r) => r.id === b.target.id);
        const next = E.RIVALS[i + 1];
        lines.push(next ? `${E.RIVALS[i].name} beaten. ${next.name} is unlocked.` : "You beat the champion. The ladder is yours.");
        if (next) S.rivalId = next.id;
        refreshLadder();
      }
      if (b.kind === "arena") lines.push(recordResult(b, m) ? "Result recorded on the arena leaderboard." : "This result isn't recorded (you need Contributor access and a sign-in).");
      coachAfter(f.id, A.battleSummary(m, 0));
    }
    const res = m.winner === null ? "Draw" : m.winner === 0 ? "Victory" : "Defeat";
    const s = out.stats;
    $("battle-result").innerHTML = `<div class="box">
      <div class="outcome">${res} vs ${esc(b.foe.name)}</div>
      ${lines.map((l) => `<p class="small" style="margin:0">${esc(l)}</p>`).join("")}
      <p class="note" style="margin:0">${s.ai} moves by Claude, ${s.instinct} by instinct.</p>
      <div class="row"><button class="btn primary" type="button" id="again">Rematch</button></div>
      <div id="coach-box">${coachHtml()}</div>
    </div>`;
    renderActiveBar();
    refreshAiUi();
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
    // the queue is already full; animateBattle skips the reward step for replays
    try { await animateBattle(b, () => Promise.resolve()); }
    catch (e) { if (!(e instanceof Cancel)) console.error(e); }
  }

  // ---------- boot ----------
  loadLocal();
  if (S.fighters.length) S.tab = "roster"; else openDesigner(null);
  render();
  connect();
})();
