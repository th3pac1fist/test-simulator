/* Fighter Lab website platform: the battle server's API and the player's wallet.
 * The server loads this before the game, on the website only; claude.ai never loads it, so the game
 * there runs exactly as before. app.js finds it as window.FighterServer.
 * Test network only (Base Sepolia): nothing here touches real money. */
(() => {
  "use strict";
  const CHAIN = { id: 84532, hex: "0x14a34", name: "Base Sepolia", rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
  const listeners = [];
  const ui = { busy: false, error: "" };

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
  const changed = () => { render(); for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } };

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
  NET.ready = call("GET", "/api/me").then((me) => { NET.address = me.address || null; render(); }, () => { render(); });
  window.FighterServer = NET;

  // ---------- the account box (above the tabs) ----------
  let box = null;
  function render() {
    if (!box) return;
    const body = NET.address
      ? `<p class="small" style="margin:0">Signed in as <b title="${esc(NET.address)}">${esc(short(NET.address))}</b>. Your fighters and Cycles are kept on the battle server.</p>
         <div class="row"><button class="btn" type="button" id="web-signout" ${ui.busy ? "disabled" : ""}>Sign out</button></div>`
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
      if (e.target.id === "web-signin") run(() => NET.signIn());
      if (e.target.id === "web-signout") run(() => NET.signOut());
    });
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
