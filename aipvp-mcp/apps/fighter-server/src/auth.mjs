// Sign-In with Ethereum (EIP-4361): the wallet address is the account. Each sign-in message carries a
// single-use nonce from this server and must name this site and the test network; sessions are random
// tokens kept in an HttpOnly cookie.
import { randomBytes } from "node:crypto";
import { getAddress, isAddress, verifyMessage } from "viem";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";

export const NONCE_TTL = 10 * 60 * 1000;
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
export const COOKIE = "fl_session";

export class AuthError extends Error {
  constructor(message) { super(message); this.status = 401; }
}

/** cfg: { origin: "http://localhost:8787", chainId: 84532, statement }; game.join(address) makes new accounts. */
export function createAuth(st, cfg, game) {
  const site = new URL(cfg.origin);
  return {
    /** What the browser needs to write the sign-in message (with the address checksummed, as EIP-4361 asks). */
    nonce(now = Date.now(), address = null) {
      const nonce = generateSiweNonce();
      st.addNonce(nonce, now + NONCE_TTL);
      const checksummed = typeof address === "string" && isAddress(address, { strict: false }) ? getAddress(address) : null;
      return { nonce, domain: site.host, uri: site.origin, chainId: cfg.chainId, version: "1", statement: cfg.statement, address: checksummed };
    },
    /** Check a signed sign-in message; returns { address, token, expires }. */
    async login({ message, signature } = {}, now = Date.now()) {
      if (typeof message !== "string" || message.length > 2000 || typeof signature !== "string" || !/^0x[0-9a-fA-F]{130,}$/.test(signature)) {
        throw new AuthError("Send the signed sign-in message.");
      }
      let msg;
      try { msg = parseSiweMessage(message); } catch { throw new AuthError("That isn't a sign-in message."); }
      const ok = validateSiweMessage({ message: msg, domain: site.host, scheme: msg.scheme ? site.protocol.slice(0, -1) : undefined, time: new Date(now) });
      if (!ok) throw new AuthError("The sign-in message is for another site, or it has expired.");
      if (msg.version !== "1" || msg.chainId !== cfg.chainId) throw new AuthError(`Sign in on the test network (chain ${cfg.chainId}).`);
      if (typeof msg.uri !== "string" || new URL(msg.uri).origin !== site.origin) throw new AuthError("The sign-in message is for another site.");
      const valid = await verifyMessage({ address: msg.address, message, signature }).catch(() => false);
      if (!valid) throw new AuthError("The signature doesn't match the address.");
      // the nonce is spent only after the signature checks out, so a bad attempt can't burn someone else's
      if (!st.takeNonce(msg.nonce, now)) throw new AuthError("This sign-in message was already used or has expired. Try again.");
      const address = getAddress(msg.address);
      game.join(address, now);
      const token = randomBytes(32).toString("hex");
      const expires = now + SESSION_TTL;
      st.addSession(token, address, expires);
      return { address, token, expires };
    },
    /** The signed-in address for a session token, or null. */
    who(token, now = Date.now()) {
      if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
      const s = st.session(token, now);
      return s ? s.address : null;
    },
    logout(token) { if (typeof token === "string") st.dropSession(token); },
    cookie(token, expires, now = Date.now()) {
      const secure = site.protocol === "https:" ? "; Secure" : "";
      return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(0, Math.floor((expires - now) / 1000))}${secure}`;
    },
    clearCookie() { return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`; },
  };
}
