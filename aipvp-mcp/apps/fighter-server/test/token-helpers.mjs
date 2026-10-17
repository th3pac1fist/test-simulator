// Deploy the test token on a fresh in-memory chain, with helpers to send, read and see revert reasons.
import { createPublicClient, createWalletClient, custom, getAddress, ContractFunctionRevertedError } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { devChain } from "./devchain.mjs";
import { ABI, ARTIFACT, claimTypedData } from "../src/chain.mjs";

export const CHAIN_ID = 84532;
export const OWNER = "0x1111111111111111111111111111111111111111";
export const randomAddress = () => privateKeyToAccount(generatePrivateKey()).address;

export async function deployToken({ signerKey = generatePrivateKey(), owner = OWNER } = {}) {
  const chain = await devChain({ chainId: CHAIN_ID });
  const transport = custom(chain.provider);
  const pub = createPublicClient({ transport });
  const wallet = createWalletClient({ transport });
  const signer = privateKeyToAccount(signerKey);
  const hash = await wallet.deployContract({ abi: ABI, bytecode: ARTIFACT.bytecode, args: [signer.address, owner], account: owner, chain: null });
  const token = getAddress((await pub.waitForTransactionReceipt({ hash })).contractAddress);
  const t = {
    chain, transport, pub, wallet, token, signer, signerKey, owner,
    read: (functionName, args) => pub.readContract({ address: token, abi: ABI, functionName, args }),
    /** Send a contract call as `from`; resolves to the receipt. */
    async send(from, functionName, args) {
      const h = await wallet.writeContract({ address: token, abi: ABI, functionName, args, account: from, chain: null });
      return pub.waitForTransactionReceipt({ hash: h });
    },
    /** Send raw { to, data } as `from` (what the website hands the browser wallet). */
    async sendTx(from, tx) {
      const h = await wallet.sendTransaction({ account: from, to: tx.to, data: tx.data, chain: null });
      return pub.waitForTransactionReceipt({ hash: h });
    },
    /** The custom error a call would revert with, or null if it would succeed. */
    async revertName(from, functionName, args) {
      try { await pub.simulateContract({ address: token, abi: ABI, functionName, args, account: from }); return null; }
      catch (e) {
        const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
        return r?.data?.errorName ?? e.shortMessage;
      }
    },
    voucher: ({ to, amount, nonce, deadline }, key = signer) => key.signTypedData(claimTypedData({ token, chainId: CHAIN_ID, to, amount, nonce, deadline })),
  };
  return t;
}
