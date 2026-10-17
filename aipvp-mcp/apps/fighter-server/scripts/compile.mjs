// Compile contracts/CycleToken.sol with the npm Solidity compiler (solc-js) and write
// contracts/build/CycleToken.json (ABI + bytecode). The server and the deploy script read that file,
// so they don't need the compiler. Run: npm run compile
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = "contracts/CycleToken.sol";
export const ARTIFACT = path.join(ROOT, "contracts/build/CycleToken.json");
const SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" };

/** Compile and return { contractName, compiler, settings, abi, bytecode }; throws on any compiler error. */
export function compile() {
  const solc = require("solc");
  const input = {
    language: "Solidity",
    sources: { [SOURCE]: { content: fs.readFileSync(path.join(ROOT, SOURCE), "utf8") } },
    settings: { ...SETTINGS, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const findImports = (p) => {
    if (!p.startsWith("@openzeppelin/contracts/")) return { error: `Not found: ${p}` };
    try { return { contents: fs.readFileSync(require.resolve(p), "utf8") }; } catch { return { error: `Not found: ${p}` }; }
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts[SOURCE].CycleToken;
  return { contractName: "CycleToken", compiler: solc.version(), settings: SETTINGS, abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const art = compile();
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  fs.writeFileSync(ARTIFACT, JSON.stringify(art, null, 2) + "\n");
  console.log(`Wrote ${path.relative(ROOT, ARTIFACT)} (${(art.bytecode.length - 2) / 2} bytes of bytecode, solc ${art.compiler})`);
}
