// Deploy the test token (tCYC) to Base Sepolia with your own TEST wallet. Run on your computer:
//
//   npm run deploy
//
// Reads .env: RPC_URL, DEPLOYER_KEY (a test wallet with a little Base Sepolia ETH from a faucet) and
// SIGNER_KEY (the server's voucher key; only its address is used here). The deployer becomes the
// token's owner, the only account that can rotate the signing key. Prints the lines to add to .env.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { ABI, ARTIFACT } from "../src/chain.mjs";

export const TEST_CHAINS = { 84532: baseSepolia, 31337: null };   // Base Sepolia, or a local dev chain

/** Deploy with clients you made; returns { token, block, hash }. */
export async function deploy({ publicClient, walletClient, account, signerAddress, owner }) {
  const hash = await walletClient.deployContract({
    abi: ABI, bytecode: ARTIFACT.bytecode, args: [getAddress(signerAddress), getAddress(owner)], account, chain: walletClient.chain ?? null,
  });
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`The deploy transaction failed (${hash}).`);
  return { token: getAddress(rc.contractAddress), block: rc.blockNumber, hash };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env")); } catch { /* use the environment */ }
  const { RPC_URL, DEPLOYER_KEY, SIGNER_KEY } = process.env;
  const missing = ["RPC_URL", "DEPLOYER_KEY", "SIGNER_KEY"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Set ${missing.join(", ")} in .env first (see .env.example). npm run new-key makes a fresh key.`);
    process.exit(1);
  }
  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const chainId = await publicClient.getChainId();
  if (!(chainId in TEST_CHAINS)) {
    console.error(`RPC_URL is chain ${chainId}. This prototype deploys only to Base Sepolia (84532) or a local dev chain (31337).`);
    process.exit(1);
  }
  const account = privateKeyToAccount(DEPLOYER_KEY);
  const signerAddress = privateKeyToAccount(SIGNER_KEY).address;
  if (signerAddress === account.address) console.warn("Tip: use different keys for DEPLOYER_KEY (owner) and SIGNER_KEY (vouchers).");
  const gas = await publicClient.getBalance({ address: account.address });
  if (gas === 0n) {
    console.error(`${account.address} has no test ETH for gas. Get some from a Base Sepolia faucet: https://docs.base.org/base-chain/tools/network-faucets`);
    process.exit(1);
  }
  console.log(`Deploying Fighter Lab Test Cycles from ${account.address} (${formatEther(gas)} test ETH) on chain ${chainId}…`);
  const walletClient = createWalletClient({ account, chain: TEST_CHAINS[chainId] || undefined, transport: http(RPC_URL) });
  const out = await deploy({ publicClient, walletClient, account, signerAddress, owner: account.address });
  console.log(`\nDeployed in block ${out.block}. Add these to .env, then npm start:\n\nTOKEN_ADDRESS=${out.token}\nSTART_BLOCK=${out.block}\n`);
  if (chainId === 84532) console.log(`Explorer: https://sepolia.basescan.org/address/${out.token}`);
}
