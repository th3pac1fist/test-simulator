// The test token contract on an in-memory EVM. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther, decodeEventLog } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { deployToken, randomAddress, OWNER } from "./token-helpers.mjs";
import { ABI, ARTIFACT } from "../src/chain.mjs";
import { compile } from "../scripts/compile.mjs";

const soon = (t, s = 3600) => BigInt(t.chain.now() + s);

test("the committed build matches the source", () => {
  const fresh = compile();
  assert.equal(fresh.bytecode, ARTIFACT.bytecode, "run npm run compile and commit contracts/build/CycleToken.json");
  assert.deepEqual(fresh.abi, ARTIFACT.abi);
});

test("a test token with nothing pre-minted", async () => {
  const t = await deployToken();
  assert.equal(await t.read("name"), "Fighter Lab Test Cycles");
  assert.equal(await t.read("symbol"), "tCYC");
  assert.equal(await t.read("decimals"), 18);
  assert.equal(await t.read("totalSupply"), 0n);
  assert.equal(await t.read("signer"), t.signer.address);
  assert.equal((await t.read("owner")).toLowerCase(), OWNER.toLowerCase());
});

test("claim: a voucher mints once, to the address it names", async () => {
  const t = await deployToken();
  const me = randomAddress(), v = { to: me, amount: parseEther("25"), nonce: 7n, deadline: soon(t) };
  const sig = await t.voucher(v);
  const rc = await t.send(me, "claim", [v.amount, v.nonce, v.deadline, sig]);
  assert.equal(rc.status, "success");
  assert.equal(await t.read("balanceOf", [me]), v.amount);
  assert.equal(await t.read("used", [7n]), true);
  const claimed = rc.logs.map((l) => { try { return decodeEventLog({ abi: ABI, ...l }); } catch { return null; } }).find((e) => e && e.eventName === "Claimed");
  assert.deepEqual(claimed.args, { to: me, amount: v.amount, nonce: 7n });
  assert.equal(await t.revertName(me, "claim", [v.amount, v.nonce, v.deadline, sig]), "VoucherUsed", "replay");
});

test("claim: wrong signer, someone else's voucher, changed numbers, expired and malformed are refused", async () => {
  const t = await deployToken();
  const me = randomAddress(), thief = randomAddress();
  const v = { to: me, amount: parseEther("10"), nonce: 1n, deadline: soon(t, 600) };
  const sig = await t.voucher(v);
  const stranger = privateKeyToAccount(generatePrivateKey());
  assert.equal(await t.revertName(me, "claim", [v.amount, v.nonce, v.deadline, await t.voucher(v, stranger)]), "BadSignature", "not the server's key");
  assert.equal(await t.revertName(thief, "claim", [v.amount, v.nonce, v.deadline, sig]), "BadSignature", "someone else's voucher");
  assert.equal(await t.revertName(me, "claim", [v.amount * 10n, v.nonce, v.deadline, sig]), "BadSignature", "a bigger amount");
  assert.equal(await t.revertName(me, "claim", [v.amount, v.nonce, v.deadline + 999n, sig]), "BadSignature", "a later deadline");
  assert.equal(await t.revertName(me, "claim", [0n, v.nonce, v.deadline, sig]), "ZeroAmount");
  assert.equal(await t.revertName(me, "claim", [v.amount, v.nonce, v.deadline, "0x1234"]), "ECDSAInvalidSignatureLength");
  t.chain.increaseTime(601); await t.chain.mine();
  assert.equal(await t.revertName(me, "claim", [v.amount, v.nonce, v.deadline, sig]), "VoucherExpired");
  assert.equal(await t.read("totalSupply"), 0n);
});

test("deposit burns tokens and emits Deposited; you can't burn what you don't have", async () => {
  const t = await deployToken();
  const me = randomAddress();
  const v = { to: me, amount: parseEther("30"), nonce: 2n, deadline: soon(t) };
  await t.send(me, "claim", [v.amount, v.nonce, v.deadline, await t.voucher(v)]);
  const rc = await t.send(me, "deposit", [parseEther("12")]);
  assert.equal(rc.status, "success");
  assert.equal(await t.read("balanceOf", [me]), parseEther("18"));
  assert.equal(await t.read("totalSupply"), parseEther("18"));
  const ev = await t.pub.getContractEvents({ address: t.token, abi: ABI, eventName: "Deposited", fromBlock: 0n });
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].args, { from: me, amount: parseEther("12") });
  assert.equal(await t.revertName(me, "deposit", [parseEther("19")]), "ERC20InsufficientBalance");
  assert.equal(await t.revertName(me, "deposit", [0n]), "ZeroAmount");
});

test("key rotation: only the owner can change the signer; old-key vouchers stop working", async () => {
  const t = await deployToken();
  const me = randomAddress(), next = privateKeyToAccount(generatePrivateKey());
  const v = { to: me, amount: parseEther("5"), nonce: 3n, deadline: soon(t) };
  const oldSig = await t.voucher(v);
  assert.equal(await t.revertName(me, "setSigner", [next.address]), "OwnableUnauthorizedAccount");
  assert.equal(await t.revertName(OWNER, "setSigner", ["0x0000000000000000000000000000000000000000"]), "ZeroAddress");
  assert.equal((await t.send(OWNER, "setSigner", [next.address])).status, "success");
  assert.equal(await t.read("signer"), next.address);
  assert.equal(await t.revertName(me, "claim", [v.amount, v.nonce, v.deadline, oldSig]), "BadSignature");
  assert.equal((await t.send(me, "claim", [v.amount, v.nonce, v.deadline, await t.voucher(v, next)])).status, "success");
});

test("deploy script: the token gets the server's signer, and the deployer owns it", async () => {
  const { devChain } = await import("./devchain.mjs");
  const { createPublicClient, createWalletClient, custom } = await import("viem");
  const { deploy } = await import("../scripts/deploy.mjs");
  const chain = await devChain();
  const transport = custom(chain.provider);
  const me = randomAddress(), signer = randomAddress();
  const out = await deploy({ publicClient: createPublicClient({ transport }), walletClient: createWalletClient({ transport }), account: me, signerAddress: signer, owner: me });
  const read = (functionName) => createPublicClient({ transport }).readContract({ address: out.token, abi: ABI, functionName });
  assert.equal(await read("signer"), signer);
  assert.equal(await read("owner"), me);
  assert.equal(await read("totalSupply"), 0n);
  assert.ok(out.block > 0n);
});
