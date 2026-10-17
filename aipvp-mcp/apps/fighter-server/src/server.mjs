// Fighter Lab battle server: a JSON API over the game rules, plus the website (the same game files the
// claude.ai version uses, with platform-web.js in front). No framework: node:http and node:sqlite.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "./store.mjs";
import { createGame, GameError } from "./game.mjs";
import { createAuth, AuthError, COOKIE } from "./auth.mjs";
import { chainModule } from "./chain.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR = path.resolve(HERE, "../../fighter-lab");
const PUBLIC_DIR = path.resolve(HERE, "../public");
const GAME_FILES = ["engine.js", "economy.js", "optimizer.js", "agent.js", "sprites.js", "app.js"];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml" };
const BODY_MAX = 64 * 1024;
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
};

/** The website page: the game's index.html in the same skeleton claude.ai wraps it in, with the web platform first. */
function sitePage() {
  const page = fs.readFileSync(path.join(GAME_DIR, "index.html"), "utf8");
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<style>body{margin:0}[hidden]{display:none!important}</style></head><body><script src="platform-web.js"></script>' + page + "</body></html>";
}

/** Fixed-window request limits per client address. */
function limiter(perMinute) {
  const hits = new Map();
  return (key, now) => {
    const h = hits.get(key);
    if (!h || now >= h.reset) {
      if (hits.size > 10000) for (const [k, v] of hits) if (now >= v.reset) hits.delete(k);
      hits.set(key, { n: 1, reset: now + 60_000 });
      return true;
    }
    return ++h.n <= perMinute;
  };
}

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
async function readJson(req) {
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) throw new GameError("Send JSON.", 415);
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > BODY_MAX) throw new GameError("Request too large.", 413);
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new GameError("That isn't valid JSON.", 400); }
}

/**
 * opts: { store?, dbFile?, origin, chainId, chain? (token module, added with the contract), trustProxy? }
 * Returns { server, store, game, auth }; call server.listen(port) to start.
 */
export function createApp(opts = {}) {
  const origin = opts.origin || "http://localhost:8787";
  const chainId = opts.chainId || 84532;
  const store = opts.store || openStore(opts.dbFile || ":memory:");
  const game = createGame(store);
  const auth = createAuth(store, { origin, chainId, statement: "Sign in to Fighter Lab (test network, no real money)." }, game);
  const chain = opts.chain ? opts.chain({ store, game, origin, chainId }) : null;
  const general = limiter(opts.perMinute || 300), signin = limiter(opts.authPerMinute || 30);
  const page = sitePage();

  // [method, pattern, handler, needs sign-in]
  const routes = [
    ["GET", /^\/api\/auth\/nonce$/, (c) => auth.nonce(c.now, c.url.searchParams.get("address")), false],
    ["POST", /^\/api\/auth\/login$/, async (c) => {
      const s = await auth.login(c.body, c.now);
      c.res.setHeader("set-cookie", auth.cookie(s.token, s.expires, c.now));
      return { address: s.address };
    }, false],
    ["POST", /^\/api\/auth\/logout$/, (c) => { auth.logout(cookieOf(c.req, COOKIE)); c.res.setHeader("set-cookie", auth.clearCookie()); return { ok: true }; }, false],
    ["GET", /^\/api\/me$/, (c) => ({ address: c.address, chainId, chain: chain ? chain.info() : null }), false],
    ["GET", /^\/api\/state$/, (c) => game.state(c.address, c.now), true],
    ["POST", /^\/api\/fighters$/, (c) => game.createFighter(c.address, c.body), true],
    ["PUT", /^\/api\/fighters\/([\w-]{1,64})$/, (c) => game.updateFighter(c.address, c.params[0], c.body), true],
    ["DELETE", /^\/api\/fighters\/([\w-]{1,64})$/, (c) => game.deleteFighter(c.address, c.params[0]), true],
    ["POST", /^\/api\/fighters\/([\w-]{1,64})\/train$/, (c) => game.train(c.address, c.params[0], c.body), true],
    ["POST", /^\/api\/fighters\/([\w-]{1,64})\/spar$/, (c) => game.startSpar(c.address, c.params[0], c.body, c.now), true],
    ["POST", /^\/api\/spar\/([\w-]{1,64})\/turn$/, (c) => game.sparTurn(c.address, c.params[0], c.body, c.now), true],
    ["POST", /^\/api\/fighters\/([\w-]{1,64})\/battle$/, (c) => game.battle(c.address, c.params[0], c.body), true],
    ["POST", /^\/api\/fighters\/([\w-]{1,64})\/publish$/, (c) => game.publish(c.address, c.params[0]), true],
    ["DELETE", /^\/api\/fighters\/([\w-]{1,64})\/publish$/, (c) => game.unpublish(c.address, c.params[0]), true],
    ["GET", /^\/api\/arena$/, () => game.arena(), false],
    ["GET", /^\/api\/battles\/([\w-]{1,64})$/, (c) => game.battleRecord(c.address, c.params[0]), true],
    ["POST", /^\/api\/forge$/, (c) => game.forge(c.address, c.body), true],
    ["POST", /^\/api\/codex$/, (c) => game.codex(c.address, c.body), true],
    ["POST", /^\/api\/shop$/, (c) => game.buy(c.address, c.body), true],
    ["DELETE", /^\/api\/library\/([\w-]{1,64})$/, (c) => game.dropFile(c.address, c.params[0]), true],
    ...(chain ? chain.routes() : []),
  ];

  function send(res, status, body, headers = {}) {
    const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { ...SECURITY_HEADERS, "cache-control": "no-store", ...headers });
    res.end(data);
  }
  function serveStatic(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed." }, { "content-type": TYPES[".json"] });
    if (pathname === "/" || pathname === "/index.html") return send(res, 200, page, { "content-type": TYPES[".html"] });
    const name = pathname.slice(1);
    let file = null;
    if (GAME_FILES.includes(name)) file = path.join(GAME_DIR, name);
    else if (/^[\w.-]+$/.test(name) && !name.startsWith(".")) {
      const p = path.join(PUBLIC_DIR, name);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) file = p;
    }
    if (!file) return send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
    send(res, 200, fs.readFileSync(file), { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  }

  const server = http.createServer(async (req, res) => {
    const now = Date.now();
    const url = new URL(req.url, origin);
    const ip = (opts.trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url.pathname);
    const json = { "content-type": TYPES[".json"] };
    try {
      if (!general(ip, now) || (url.pathname.startsWith("/api/auth/") && !signin(ip, now))) throw new GameError("Too many requests. Slow down a little.", 429);
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!route) throw new GameError(routes.some(([, re]) => re.test(url.pathname)) ? "Method not allowed." : "Not found.", routes.some(([, re]) => re.test(url.pathname)) ? 405 : 404);
      const [method, re, handler, needsAuth] = route;
      // no cross-site writes: browsers send Origin on every POST/PUT/DELETE, and it must be this site
      if (method !== "GET" && req.headers.origin && req.headers.origin !== new URL(origin).origin) throw new GameError("Cross-site request refused.", 403);
      const address = auth.who(cookieOf(req, COOKIE), now);
      if (needsAuth && !address) throw new AuthError("Sign in with your wallet first.");
      const body = method === "GET" || method === "DELETE" ? {} : await readJson(req);
      const out = await handler({ req, res, url, now, address, body, params: url.pathname.match(re).slice(1) });
      send(res, 200, out, json);
    } catch (e) {
      // GameError/AuthError carry a status; plain Errors from the engine or economy are the player's to fix
      // ("Not enough Cycles", "Only 3 stat points"); anything else is a bug and isn't shown.
      const status = e.status || (e.constructor === Error ? 400 : 500);
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? "Something went wrong on the server." : e.message }, json);
    }
  });
  return { server, store, game, auth, chain };
}

// `node src/server.mjs`: settings come from the environment (or a .env file next to package.json)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.resolve(HERE, "../.env")); } catch { /* no .env: defaults */ }
  const env = process.env;
  const port = Number(env.PORT || 8787);
  const chainId = Number(env.CHAIN_ID || 84532);
  if (![84532, 31337].includes(chainId)) {   // Base Sepolia or a local dev chain: never a network with real money
    console.error(`CHAIN_ID ${chainId} isn't a test network. This prototype runs on Base Sepolia (84532) only.`);
    process.exit(1);
  }
  const tokenVars = ["TOKEN_ADDRESS", "SIGNER_KEY", "RPC_URL"].filter((k) => env[k]);
  if (tokenVars.length && tokenVars.length < 3) console.warn("Set TOKEN_ADDRESS, SIGNER_KEY and RPC_URL together to turn on the wallet. Running without it.");
  const app = createApp({
    origin: env.ORIGIN || `http://localhost:${port}`,
    chainId,
    dbFile: env.DB_FILE || path.resolve(HERE, "../fighter-lab.db"),
    trustProxy: env.TRUST_PROXY === "1",
    chain: tokenVars.length === 3 ? chainModule({ token: env.TOKEN_ADDRESS, signerKey: env.SIGNER_KEY, rpcUrl: env.RPC_URL,
      startBlock: env.START_BLOCK, confirmations: env.CONFIRMATIONS, explorer: env.EXPLORER_URL }) : null,
  });
  app.server.listen(port, () => console.log(`Fighter Lab server on http://localhost:${port}${app.chain ? "" : " (no test token configured)"}`));
  if (app.chain) {
    app.chain.check().then(() => console.log(`Test token ${env.TOKEN_ADDRESS} on chain ${chainId}: settings match.`),
      (e) => console.error("Token check failed (withdrawals stay paused until it passes):", e.shortMessage || e.message));
    const tick = () => app.chain.sync().catch((e) => console.error("Chain sync:", e.shortMessage || e.message));
    setInterval(tick, Number(env.SYNC_SECONDS || 15) * 1000);
    tick();
  }
}
