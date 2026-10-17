/* Fighter Lab website platform: the battle server's API and the player's wallet.
 * The server loads this before the game, on the website only; claude.ai never loads it, so the game
 * there runs exactly as before. app.js finds it as window.FighterServer.
 * Test network only (Base Sepolia): nothing here touches real money. */
(() => {
  "use strict";
  const CHAIN = { id: 84532, hex: "0x14a34", name: "Base Sepolia", rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
  const listeners = [], progressListeners = [];
  const ui = { busy: false, error: "", note: null, wallet: null, loading: false, withdraw: 25, deposit: 5 };

  async function call(method, path, body) {
    const r = await fetch(path, {
      method, credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || `The battle server answered ${r.status}.`);
      err.status = r.status;
      if (r.status === 401 && NET.address && path !== "/api/auth/login") NET.signedOut();
      throw err;
    }
    return data;
  }
  const changed = () => {
    ui.wallet = null; ui.note = null;
    render(); loadWallet();
    for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } }
  };
  /** Tell the game about Cycles that changed outside it (withdrawals, refunds, deposits). */
  const progressChanged = (p) => { if (p) for (const fn of progressListeners) { try { fn(p); } catch (e) { console.error(e); } } };

  // ---------- Sign-In with Ethereum (EIP-4361) ----------
  function siweMessage(m) {
    return `${m.domain} wants you to sign in with your Ethereum account:\n${m.address}\n\n${m.statement}\n\n`
      + `URI: ${m.uri}\nVersion: ${m.version}\nChain ID: ${m.chainId}\nNonce: ${m.nonce}\nIssued At: ${m.issuedAt}`;
  }
  const utf8Hex = (s) => "0x" + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
  function wallet() {
    const eth = window.ethereum;
    if (!eth || typeof eth.request !== "function") throw new Error("No wallet found. Install a browser wallet such as MetaMask, then reload this page.");
    return eth;
  }
  /** Ask the wallet to use Base Sepolia, adding the network if it doesn't know it. */
  async function useTestChain(eth) {
    if ((await eth.request({ method: "eth_chainId" })) === CHAIN.hex) return;
    try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.hex }] }); }
    catch (e) {
      if (!e || e.code !== 4902) throw e;
      await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN.hex, chainName: CHAIN.name, rpcUrls: [CHAIN.rpc],
        nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: [CHAIN.explorer] }] });
    }
  }

  const NET = {
    address: null,
    chain: CHAIN,
    /** Resolves once the server says who (if anyone) is signed in. */
    ready: null,
    onChange(fn) { listeners.push(fn); },
    onProgress(fn) { progressListeners.push(fn); },
    /** The test token's { token, chainId, explorer }, or null when the server has none set up. */
    token: null,
    signedOut() { if (!NET.address) return; NET.address = null; changed(); },
    async signIn() {
      const eth = wallet();
      const [account] = await eth.request({ method: "eth_requestAccounts" });
      if (!account) throw new Error("The wallet didn't share an account.");
      try { await useTestChain(eth); } catch { /* signing in doesn't need it; claiming tokens will ask again */ }
      const n = await call("GET", `/api/auth/nonce?address=${encodeURIComponent(account)}`);
      const message = siweMessage({ ...n, address: n.address || account, issuedAt: new Date().toISOString() });
      const signature = await eth.request({ method: "personal_sign", params: [utf8Hex(message), account] });
      const me = await call("POST", "/api/auth/login", { message, signature });
      NET.address = me.address;
      changed();
    },
    async signOut() {
      try { await call("POST", "/api/auth/logout", {}); } finally { NET.address = null; changed(); }
    },
    // ---------- game actions (each answer carries the new fighter and/or progress) ----------
    state: () => call("GET", "/api/state"),
    createFighter: (d) => call("POST", "/api/fighters", d),
    updateFighter: (id, d) => call("PUT", `/api/fighters/${encodeURIComponent(id)}`, d),
    deleteFighter: (id) => call("DELETE", `/api/fighters/${encodeURIComponent(id)}`),
    train: (id, body) => call("POST", `/api/fighters/${encodeURIComponent(id)}/train`, body),
    spar: (id, partner) => call("POST", `/api/fighters/${encodeURIComponent(id)}/spar`, { partner }),
    sparTurn: (sparId, slot) => call("POST", `/api/spar/${encodeURIComponent(sparId)}/turn`, { slot }),
    battle: (id, target) => call("POST", `/api/fighters/${encodeURIComponent(id)}/battle`, target),
    battleRecord: (id) => call("GET", `/api/battles/${encodeURIComponent(id)}`),
    publish: (id) => call("POST", `/api/fighters/${encodeURIComponent(id)}/publish`, {}),
    unpublish: (id) => call("DELETE", `/api/fighters/${encodeURIComponent(id)}/publish`),
    arena: () => call("GET", "/api/arena"),
    forge: (skill, fighter) => call("POST", "/api/forge", { skill, fighter }),
    codex: (key) => call("POST", "/api/codex", { key }),
    buy: (item) => call("POST", "/api/shop", { item }),
    dropFile: (id) => call("DELETE", `/api/library/${encodeURIComponent(id)}`),
  };
  NET.ready = call("GET", "/api/me").then((me) => { NET.address = me.address || null; NET.token = me.chain || null; render(); loadWallet(); }, () => { render(); });
  window.FighterServer = NET;

  // ---------- test tokens: Cycles -> tCYC (a voucher you claim) and tCYC -> Cycles (a burn the server sees) ----------
  const UNIT = 10n ** 18n;
  const tokens = (wei) => { const v = BigInt(wei || 0); const whole = v / UNIT, cents = (v % UNIT) / 10n ** 16n; return cents ? `${whole}.${String(cents).padStart(2, "0")}` : String(whole); };
  const time = (s) => new Date(s * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  async function loadWallet() {
    if (!NET.address || !NET.token || ui.loading) return;
    ui.loading = true;
    try { ui.wallet = await call("GET", "/api/wallet"); } catch { /* shown as unavailable */ }
    finally { ui.loading = false; render(); }
  }
  /** Send a transaction from the signed-in account on the test network; resolves to its hash. */
  async function sendTx(tx) {
    const eth = wallet();
    await useTestChain(eth);
    const [from] = await eth.request({ method: "eth_requestAccounts" });
    if (!from || from.toLowerCase() !== NET.address.toLowerCase()) throw new Error(`Switch your wallet to ${short(NET.address)}, the account you signed in with.`);
    return eth.request({ method: "eth_sendTransaction", params: [{ from, to: tx.to, data: tx.data }] });
  }
  /** Ask the server to look at the chain until `done(wallet)` or about a minute passes. */
  async function settle(done) {
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, i ? 5000 : 1500));
      try {
        const w = await call("POST", "/api/wallet/sync", {});
        ui.wallet = w; progressChanged(w.progress); render();
        if (done(w)) return true;
      } catch (e) { if (e.status !== 429) throw e; }
    }
    return false;
  }
  const txLink = (hash) => `<a href="${esc(NET.token.explorer)}/tx/${esc(hash)}" target="_blank" rel="noopener noreferrer">view on the explorer</a>`;
  async function withdraw() {
    const n = Math.round(Number(ui.withdraw));
    const r = await call("POST", "/api/wallet/withdraw", { cycles: n });
    progressChanged(r.progress);
    ui.wallet = { ...(ui.wallet || {}), withdrawals: [r.voucher, ...((ui.wallet && ui.wallet.withdrawals) || [])] };
    ui.note = { text: `${n} Cycles are in a voucher. Confirm the claim in your wallet to mint ${n} tCYC.` };
    render();
    await claim(r.voucher);
  }
  async function claim(v) {
    let hash;
    try { hash = await sendTx(v.claim); }
    catch (e) {
      ui.note = { text: `The voucher is saved below. Claim it by ${time(v.deadline)}; if it expires unclaimed, the Cycles come back.` };
      throw e;
    }
    ui.note = { text: "Claim sent.", hash }; render();
    const ok = await settle((w) => w.withdrawals.some((x) => x.nonce === v.nonce && x.status === "claimed"));
    ui.note = ok ? { text: `Claimed: ${tokens(v.amount)} tCYC are in your wallet.`, hash } : { text: "Claim sent. It shows here once the network confirms it.", hash };
  }
  async function deposit() {
    const n = Math.round(Number(ui.deposit));
    const tx = await call("GET", `/api/wallet/deposit?cycles=${encodeURIComponent(n)}`);
    const before = (await call("GET", "/api/state")).progress.balance;
    const hash = await sendTx(tx);
    ui.note = { text: `Deposit sent: ${n} tCYC become Cycles once the network confirms it.`, hash }; render();
    const ok = await settle((w) => w.progress.balance >= before + n);
    if (ok) ui.note = { text: `Deposited: +${n} Cycles.`, hash };
  }

  // ---------- the account box (above the tabs) ----------
  let box = null;
  function walletHtml() {
    if (!NET.token) return `<p class="note" style="margin:0">Test tokens aren't set up on this server yet.</p>`;
    const w = ui.wallet;
    if (!w) return `<p class="note" style="margin:0">${ui.loading ? "Loading your wallet…" : "Wallet unavailable right now."}</p>`;
    const open = (w.withdrawals || []).filter((x) => x.status === "issued");
    const lim = w.limits || {};
    return `<h2>Test tokens</h2>
      <p class="small" style="margin:0">Turn Cycles into <b>tCYC</b>, a token on the ${CHAIN.name} test network, and back. Test tokens have no value.
        Your wallet: <b id="web-tokens">${w.tokenBalance === null ? "?" : tokens(w.tokenBalance)} tCYC</b> ·
        <a href="${esc(w.explorer)}/token/${esc(w.token)}" target="_blank" rel="noopener noreferrer">token contract</a></p>
      <div class="row"><input id="web-withdraw-n" type="number" min="${lim.min}" max="${lim.max}" step="1" value="${esc(ui.withdraw)}" aria-label="Cycles to withdraw" style="width:6em">
        <button class="btn primary" type="button" id="web-withdraw" ${ui.busy ? "disabled" : ""}>Withdraw as tCYC</button>
        <span class="note">${lim.min}–${lim.max} at a time, ${lim.daily} a day. You pay the test network's (free) gas.</span></div>
      <div class="row"><input id="web-deposit-n" type="number" min="1" step="1" value="${esc(ui.deposit)}" aria-label="tCYC to deposit" style="width:6em">
        <button class="btn" type="button" id="web-deposit" ${ui.busy ? "disabled" : ""}>Deposit tCYC as Cycles</button></div>
      ${open.length ? `<ul class="ledger" id="web-vouchers">${open.map((v) => `<li><span>Voucher: ${v.cycles} Cycles · claim by ${time(v.deadline)}</span>
        <button class="btn" type="button" data-claim="${esc(v.nonce)}" ${ui.busy ? "disabled" : ""}>Claim</button></li>`).join("")}</ul>` : ""}
      ${ui.note ? `<p class="small" id="web-note" role="status" style="margin:0">${esc(ui.note.text)}${ui.note.hash ? ` (${txLink(ui.note.hash)})` : ""}</p>` : ""}`;
  }
  function render() {
    if (!box) return;
    const body = NET.address
      ? `<p class="small" style="margin:0">Signed in as <b title="${esc(NET.address)}">${esc(short(NET.address))}</b>. Your fighters and Cycles are kept on the battle server.</p>
         <div class="row"><button class="btn" type="button" id="web-signout" ${ui.busy ? "disabled" : ""}>Sign out</button></div>
         ${walletHtml()}`
      : `<p class="small" style="margin:0">Play right away (saved on this device only), or sign in with a wallet to keep your fighters on the battle server and earn Cycles that count.
           Sign-in uses the ${CHAIN.name} test network: no real money, and signing costs nothing.</p>
         <div class="row"><button class="btn primary" type="button" id="web-signin" ${ui.busy ? "disabled" : ""}>${ui.busy ? "Check your wallet…" : "Sign in with wallet"}</button></div>`;
    box.innerHTML = `<h2>Account</h2>${body}${ui.error ? `<p class="warn" role="alert" style="margin:0">${esc(ui.error)}</p>` : ""}`;
  }
  async function run(fn) {
    ui.busy = true; ui.error = ""; render();
    try { await fn(); }
    catch (e) { ui.error = e && e.code === 4001 ? "The request was cancelled in your wallet." : (e && e.message) || "That didn't work. Try again."; }
    finally { ui.busy = false; render(); }
  }
  function mount() {
    const top = document.querySelector("header.top");
    if (!top || box) return;
    box = document.createElement("section");
    box.className = "box";
    box.id = "web-account";
    box.setAttribute("aria-label", "Account");
    top.after(box);
    box.addEventListener("click", (e) => {
      if (ui.busy) return;
      const id = e.target.id, c = e.target.closest("[data-claim]");
      if (id === "web-signin") run(() => NET.signIn());
      if (id === "web-signout") run(() => NET.signOut());
      if (id === "web-withdraw") run(withdraw);
      if (id === "web-deposit") run(deposit);
      if (c) { const v = ui.wallet && ui.wallet.withdrawals.find((x) => x.nonce === c.dataset.claim); if (v) run(() => claim(v)); }
    });
    box.addEventListener("input", (e) => {
      if (e.target.id === "web-withdraw-n") ui.withdraw = e.target.value;
      if (e.target.id === "web-deposit-n") ui.deposit = e.target.value;
    });
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
