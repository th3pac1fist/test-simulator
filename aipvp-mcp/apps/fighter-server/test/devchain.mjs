// An in-memory chain for tests: the ethereumjs EVM behind a small EIP-1193 provider, so viem clients
// (and the server's chain module) can deploy, call, send transactions and read logs without a network.
// Accounts are unlocked: eth_sendTransaction runs as `from` with no signature (tests only). One block
// per transaction; the clock only moves when a test moves it.
import { createVM } from "@ethereumjs/vm";
import { createCustomCommon, Mainnet, Hardfork } from "@ethereumjs/common";
import { createBlock } from "@ethereumjs/block";
import { createAddressFromString, hexToBytes, bytesToHex } from "@ethereumjs/util";
import { keccak256, toHex, numberToHex } from "viem";

const ZERO_BLOOM = "0x" + "00".repeat(256);
const hex = (n) => numberToHex(BigInt(n));

export async function devChain({ chainId = 84532, time = Math.floor(Date.now() / 1000) } = {}) {
  const common = createCustomCommon({ chainId }, Mainnet, { hardfork: Hardfork.Cancun });
  const vm = await createVM({ common });
  let clock = BigInt(time);
  const blocks = [{ number: 0n, timestamp: clock, hash: keccak256(toHex("genesis")), parentHash: "0x" + "00".repeat(32), txs: [] }];
  const receipts = new Map(), logs = [];
  let seq = 0;
  const latest = () => blocks[blocks.length - 1];
  const header = (b) => createBlock({ header: { number: b.number, timestamp: b.timestamp, gasLimit: 30_000_000n, baseFeePerGas: 0n } }, { common, skipConsensusFormatValidation: true });
  const revert = (r) => Object.assign(new Error("execution reverted"), { code: 3, data: bytesToHex(r.execResult.returnValue) });

  async function run(tx, b, commit) {
    const opts = {
      caller: createAddressFromString(tx.from || "0x" + "00".repeat(20)),
      origin: createAddressFromString(tx.from || "0x" + "00".repeat(20)),
      to: tx.to ? createAddressFromString(tx.to) : undefined,
      data: hexToBytes(tx.data || tx.input || "0x"),
      value: tx.value ? BigInt(tx.value) : 0n,
      gasLimit: 30_000_000n, gasPrice: 0n, skipBalance: true, block: header(b),
    };
    if (commit) return vm.evm.runCall(opts);
    await vm.stateManager.checkpoint();
    try { return await vm.evm.runCall(opts); } finally { await vm.stateManager.revert(); }
  }
  function blockAt(tag) {
    if (tag === undefined || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") return latest();
    if (tag === "earliest") return blocks[0];
    return blocks[Number(BigInt(tag))] || null;
  }
  const blockJson = (b) => b && ({
    number: hex(b.number), hash: b.hash, parentHash: b.parentHash, timestamp: hex(b.timestamp), nonce: "0x0000000000000000",
    gasLimit: hex(30_000_000), gasUsed: "0x0", baseFeePerGas: "0x0", miner: "0x" + "00".repeat(20), logsBloom: ZERO_BLOOM,
    difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x0", sha3Uncles: "0x" + "00".repeat(32),
    stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), transactionsRoot: "0x" + "00".repeat(32),
    transactions: b.txs, uncles: [],
  });
  function matches(log, f) {
    if (f.address) {
      const list = [].concat(f.address).map((a) => a.toLowerCase());
      if (!list.includes(log.address.toLowerCase())) return false;
    }
    const from = f.fromBlock === undefined ? 0n : BigInt(blockAt(f.fromBlock)?.number ?? 0n);
    const to = f.toBlock === undefined ? latest().number : BigInt(blockAt(f.toBlock)?.number ?? latest().number);
    const n = BigInt(log.blockNumber);
    if (n < from || n > to) return false;
    return (f.topics || []).every((t, i) => t === null || t === undefined || [].concat(t).map((x) => x.toLowerCase()).includes((log.topics[i] || "").toLowerCase()));
  }

  async function sendTransaction(tx) {
    const prev = latest();
    const b = { number: prev.number + 1n, timestamp: clock > prev.timestamp ? clock : prev.timestamp + 1n, parentHash: prev.hash, txs: [] };
    clock = b.timestamp;
    b.hash = keccak256(toHex(`block:${b.number}`));
    const hash = keccak256(toHex(`tx:${++seq}`));
    const r = await run(tx, b, true);
    const failed = !!r.execResult.exceptionError;
    const txLogs = failed ? [] : (r.execResult.logs || []).map(([addr, topics, data], i) => ({
      address: bytesToHex(addr), topics: topics.map(bytesToHex), data: bytesToHex(data),
      blockNumber: hex(b.number), blockHash: b.hash, transactionHash: hash, transactionIndex: "0x0", logIndex: hex(i), removed: false,
    }));
    logs.push(...txLogs);
    b.txs.push(hash);
    blocks.push(b);
    receipts.set(hash, {
      transactionHash: hash, transactionIndex: "0x0", blockHash: b.hash, blockNumber: hex(b.number), from: tx.from, to: tx.to || null,
      contractAddress: !failed && r.createdAddress ? r.createdAddress.toString() : null, status: failed ? "0x0" : "0x1",
      gasUsed: hex(r.execResult.executionGasUsed || 0n), cumulativeGasUsed: hex(r.execResult.executionGasUsed || 0n),
      effectiveGasPrice: "0x0", logs: txLogs, logsBloom: ZERO_BLOOM, type: "0x2",
      revertData: failed ? bytesToHex(r.execResult.returnValue) : undefined,
    });
    return hash;
  }

  const provider = {
    async request({ method, params = [] }) {
      switch (method) {
        case "eth_chainId": return hex(chainId);
        case "net_version": return String(chainId);
        case "eth_blockNumber": return hex(latest().number);
        case "eth_getBlockByNumber": return blockJson(blockAt(params[0]));
        case "eth_getBlockByHash": return blockJson(blocks.find((b) => b.hash === params[0]) || null);
        case "eth_gasPrice": case "eth_maxPriorityFeePerGas": return "0x0";
        case "eth_estimateGas": {
          const r = await run(params[0], latest(), false);
          if (r.execResult.exceptionError) throw revert(r);
          return hex(100_000n + (r.execResult.executionGasUsed || 0n));
        }
        case "eth_getTransactionCount": return hex((await vm.stateManager.getAccount(createAddressFromString(params[0])))?.nonce ?? 0n);
        case "eth_getBalance": return "0x0";
        case "eth_getCode": return bytesToHex(await vm.stateManager.getCode(createAddressFromString(params[0])));
        case "eth_call": {
          const r = await run(params[0], blockAt(params[1]) || latest(), false);
          if (r.execResult.exceptionError) throw revert(r);
          return bytesToHex(r.execResult.returnValue);
        }
        case "eth_sendTransaction": return sendTransaction(params[0]);
        case "eth_getTransactionReceipt": { const r = receipts.get(params[0]); if (!r) return null; const { revertData, ...out } = r; return out; }
        case "eth_getTransactionByHash": {
          const r = receipts.get(params[0]);
          return r && { hash: r.transactionHash, blockHash: r.blockHash, blockNumber: r.blockNumber, from: r.from, to: r.to, input: "0x", value: "0x0",
                        gas: "0x0", gasPrice: "0x0", nonce: "0x0", transactionIndex: "0x0", type: "0x0", v: "0x0", r: "0x0", s: "0x0", chainId: hex(chainId) };
        }
        case "eth_getLogs": return logs.filter((l) => matches(l, params[0] || {}));
        default: throw Object.assign(new Error(`devchain: ${method} isn't supported`), { code: -32601 });
      }
    },
  };
  return {
    provider, vm,
    /** Move the clock forward; the next block gets the new time. */
    increaseTime(seconds) { clock += BigInt(seconds); },
    /** Mine an empty block (at the current clock). */
    mine() { return sendTransaction({ from: "0x" + "00".repeat(20), to: "0x000000000000000000000000000000000000dEaD", data: "0x" }); },
    now: () => Number(latest().timestamp),
    receipt: (h) => receipts.get(h),
  };
}
