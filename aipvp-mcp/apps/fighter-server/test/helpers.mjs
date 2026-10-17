// Test helpers: a server on a free port, wallets that sign in, and a small JSON client.
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { createApp } from "../src/server.mjs";

export const ORIGIN = "http://fighter.test";

export async function startServer(opts = {}) {
  // generous limits by default: the suite signs in many players from one address
  const app = createApp({ origin: ORIGIN, perMinute: 100000, authPerMinute: 100000, ...opts });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
  app.close = () => new Promise((r) => { app.server.closeAllConnections?.(); app.server.close(r); });
  return app;
}

/** A JSON client for one player; `cookie` is set by signIn. */
export function client(base) {
  const c = {
    cookie: null,
    async call(method, path, body, headers = {}) {
      const r = await fetch(base + path, {
        method,
        headers: { ...(c.cookie ? { cookie: c.cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, body: json, text, headers: r.headers };
    },
    get: (p) => c.call("GET", p),
    post: (p, b = {}) => c.call("POST", p, b),
    put: (p, b = {}) => c.call("PUT", p, b),
    del: (p) => c.call("DELETE", p),
  };
  return c;
}

/** Write and sign a sign-in message; `edit` can tamper with its fields first. */
export async function siwe(base, account, edit = (m) => m) {
  const n = await (await fetch(base + "/api/auth/nonce")).json();
  const fields = edit({ address: account.address, chainId: n.chainId, domain: n.domain, nonce: n.nonce, uri: n.uri, version: "1", statement: n.statement });
  const message = createSiweMessage(fields);
  return { message, signature: await account.signMessage({ message }) };
}

export async function signIn(base, account = privateKeyToAccount(generatePrivateKey())) {
  const c = client(base);
  const r = await c.post("/api/auth/login", await siwe(base, account));
  if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${r.text}`);
  c.cookie = r.headers.get("set-cookie").split(";")[0];
  c.address = r.body.address;
  c.account = account;
  return c;
}

export const newAccount = () => privateKeyToAccount(generatePrivateKey());
export const BASIC_MOVES = ["fight", "talk", "strategize", "shield"];
