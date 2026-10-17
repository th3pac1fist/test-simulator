// The test token, seen from the game server: Cycles -> tCYC withdrawals as signed vouchers, refunds for
// vouchers that expire unclaimed, and tCYC -> Cycles deposits credited once per on-chain event.
// The server never holds or sends tokens; it only signs vouchers and reads the chain.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPublicClient, encodeFunctionData, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ECON, GameError } from "./game.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ARTIFACT = JSON.parse(fs.readFileSync(path.resolve(HERE, "../contracts/build/CycleToken.json"), "utf8"));
export const ABI = ARTIFACT.abi;
export const UNIT = 10n ** 18n;                 // 1 Cycle = 1 tCYC (18 decimals)
export const WALLET_LIMITS = {
  min: 10, max: 500,                            // Cycles per voucher
  daily: 1000,                                  // Cycles withdrawn per account in any 24 hours (refunds don't count)
  open: 3,                                      // unclaimed vouchers per account
  ttl: 60 * 60,                                 // seconds a voucher can be claimed
  refundGrace: 10 * 60,                         // chain seconds past the deadline before an unclaimed voucher is refunded
  logRange: 2000n,                              // blocks per log query
};
const DAY = 24 * 60 * 60 * 1000;
const fail = (msg, status) => { throw new GameError(msg, status); };

/** The EIP-712 voucher the contract checks in claim(). */
export function claimTypedData({ token, chainId, to, amount, nonce, deadline }) {
  return {
    domain: { name: "Fighter Lab Test Cycles", version: "1", chainId, verifyingContract: token },
    types: { Claim: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Claim",
    message: { to, amount, nonce, deadline },
  };
}

/**
 * cfg: { token, signerKey, rpcUrl | transport, explorer?, confirmations?, startBlock? }.
 * Returns the factory createApp() takes as opts.chain.
 */
export function chainModule(cfg) {
  return ({ store: st, game, chainId }) => {
    const token = getAddress(cfg.token);
    const signer = privateKeyToAccount(cfg.signerKey);
    const client = createPublicClient({ transport: cfg.transport || http(cfg.rpcUrl) });
    const confirmations = BigInt(cfg.confirmations ?? 2);
    const explorer = cfg.explorer || "https://sepolia.basescan.org";
    let syncing = null, verified = false;
    const read = (functionName, args) => client.readContract({ address: token, abi: ABI, functionName, args });
    const view = (w) => ({ nonce: w.nonce, cycles: w.cycles, amount: w.amount, deadline: w.deadline, status: w.status, createdAt: w.created_at,
                           claim: w.status === "issued" ? claimTx(w) : null });
    const claimTx = (w) => ({ to: token, data: encodeFunctionData({ abi: ABI, functionName: "claim", args: [BigInt(w.amount), BigInt(w.nonce), BigInt(w.deadline), w.signature] }) });

    /** The RPC is the configured chain and the token's signer is this server's key; vouchers wait until it is. */
    async function check() {
      const id = await client.getChainId();
      if (id !== chainId) throw new Error(`RPC_URL is chain ${id}, but the server is set up for chain ${chainId}.`);
      const onChain = getAddress(await read("signer"));
      if (onChain !== signer.address) throw new Error(`SIGNER_KEY is ${signer.address}, but the token's signer is ${onChain}.`);
      verified = true;
    }
    /** Cycles -> a signed voucher. The Cycles leave the ledger in the same transaction that records the voucher. */
    async function withdraw(address, { cycles } = {}, now = Date.now()) {
      if (!verified) {
        try { await check(); } catch (e) { console.error("Token check failed:", e.shortMessage || e.message); fail("Withdrawals are paused: the server's token settings don't match the chain.", 503); }
      }
      const n = Number(cycles);
      if (!Number.isInteger(n) || n < WALLET_LIMITS.min || n > WALLET_LIMITS.max) fail(`Withdraw a whole number of Cycles from ${WALLET_LIMITS.min} to ${WALLET_LIMITS.max}.`);
      const nonce = BigInt("0x" + randomBytes(16).toString("hex"));
      const deadline = BigInt(Math.floor(now / 1000) + WALLET_LIMITS.ttl);
      const amount = BigInt(n) * UNIT;
      // signed first (signing is async), handed out only if the debit below commits
      const signature = await signer.signTypedData(claimTypedData({ token, chainId, to: address, amount, nonce, deadline }));
      return game.act(address, (p) => {
        const open = st.withdrawals(address).filter((w) => w.status === "issued").length;
        if (open >= WALLET_LIMITS.open) fail(`You have ${open} vouchers waiting. Claim them (or let them expire and be refunded) first.`);
        const recent = st.withdrawnSince(address, now - DAY);
        if (recent + n > WALLET_LIMITS.daily) fail(`You can withdraw ${WALLET_LIMITS.daily} Cycles a day; ${Math.max(0, WALLET_LIMITS.daily - recent)} left today.`);
        p.wallet = ECON.spend(p.wallet, n, `Withdrew ${n} Cycles as tCYC`, `w:${nonce.toString(36)}`, now);
        const w = { nonce: nonce.toString(), address, cycles: n, amount: amount.toString(), deadline: Number(deadline), signature, createdAt: now };
        st.addWithdrawal(w);
        return { voucher: { ...view({ ...w, status: "issued", created_at: now }), token, chainId, to: address, signature } };
      }, now);
    }

    /** One pass over the chain: claimed and expired vouchers, then new deposits. Safe to call at any time. */
    function sync(now = Date.now()) {
      if (!syncing) syncing = runSync(now).finally(() => { syncing = null; });
      return syncing;
    }
    async function runSync(now) {
      const out = { claimed: 0, refunded: 0, deposits: 0 };
      const head = await client.getBlock({ blockTag: "latest" });
      const chainNow = Number(head.timestamp);
      for (const w of st.openWithdrawals()) {
        if (await read("used", [BigInt(w.nonce)])) { if (st.setWithdrawal(w.nonce, "claimed").changes) out.claimed++; continue; }
        if (chainNow <= w.deadline + WALLET_LIMITS.refundGrace) continue;
        // expired on chain and never claimed: claim() now reverts for it, so the Cycles go back
        game.act(w.address, (p) => {
          if (!st.setWithdrawal(w.nonce, "refunded").changes) return {};
          p.wallet = ECON.credit(p.wallet, w.cycles, `Refund: voucher for ${w.cycles} Cycles expired`, `w:${BigInt(w.nonce).toString(36)}`, now);
          out.refunded++;
          return {};
        }, now);
      }
      const safe = head.number - confirmations;
      let from = BigInt(st.get("deposits.next") ?? cfg.startBlock ?? 0);
      while (from <= safe) {
        const to = from + WALLET_LIMITS.logRange - 1n < safe ? from + WALLET_LIMITS.logRange - 1n : safe;
        const events = await client.getContractEvents({ address: token, abi: ABI, eventName: "Deposited", fromBlock: from, toBlock: to });
        for (const ev of events) {
          const address = getAddress(ev.args.from), cycles = Number(ev.args.amount / UNIT);   // whole Cycles; dust stays burned
          game.join(address, now);
          game.act(address, (p) => {
            if (!st.addDeposit({ txHash: ev.transactionHash, logIndex: ev.logIndex, address, amount: ev.args.amount.toString(), cycles, at: now })) return {};
            if (cycles > 0) p.wallet = ECON.credit(p.wallet, cycles, `Deposited ${cycles} tCYC`, `d:${ev.transactionHash.slice(2, 14)}`, now);
            out.deposits++;
            return {};
          }, now);
        }
        st.set("deposits.next", (to + 1n).toString());
        from = to + 1n;
      }
      return out;
    }

    async function wallet(address) {
      const balance = await read("balanceOf", [address]).catch(() => null);
      return {
        token, chainId, explorer, signer: signer.address,
        limits: { min: WALLET_LIMITS.min, max: WALLET_LIMITS.max, daily: WALLET_LIMITS.daily, open: WALLET_LIMITS.open, ttl: WALLET_LIMITS.ttl },
        tokenBalance: balance === null ? null : balance.toString(),
        withdrawals: st.withdrawals(address).slice(0, 20).map(view),
        withdrawnToday: st.withdrawnSince(address, Date.now() - DAY),
      };
    }
    function depositTx({ cycles }) {
      const n = Number(cycles);
      if (!Number.isInteger(n) || n < 1 || n > 1_000_000) fail("Deposit a whole number of tCYC.");
      return { to: token, data: encodeFunctionData({ abi: ABI, functionName: "deposit", args: [BigInt(n) * UNIT] }) };
    }
    const lastSync = new Map();
    return {
      info: () => ({ token, chainId, explorer }),
      check, withdraw, sync, wallet, depositTx,
      routes: () => [
        ["GET", /^\/api\/wallet$/, (c) => wallet(c.address), true],
        ["POST", /^\/api\/wallet\/withdraw$/, (c) => withdraw(c.address, c.body, c.now), true],
        ["GET", /^\/api\/wallet\/deposit$/, (c) => depositTx({ cycles: c.url.searchParams.get("cycles") }), true],
        // "I just sent a transaction": look at the chain now instead of waiting for the next pass
        ["POST", /^\/api\/wallet\/sync$/, async (c) => {
          if (c.now - (lastSync.get(c.address) || 0) < 3000) fail("Checking already. Try again in a moment.", 429);
          lastSync.set(c.address, c.now);
          await sync(c.now);
          return { ...(await wallet(c.address)), progress: game.state(c.address, c.now).progress };
        }, true],
      ],
    };
  };
}
