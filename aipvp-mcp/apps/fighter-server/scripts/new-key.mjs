// Print a fresh private key and its address, for SIGNER_KEY or a test DEPLOYER_KEY in .env.
// Run it on your own computer and paste the key only into .env (git ignores it). Never share it,
// never paste it into a chat, and never send real funds to a key made for testing.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
console.log(`Address: ${privateKeyToAccount(key).address}\nKey:     ${key}\n\nPut the key in .env only.`);
