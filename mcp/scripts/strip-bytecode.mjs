// Remove compiled EVM contract bytecode that viem and ox embed as string
// constants, from the bundled server.
//
// Why: the Claude plugin directory's security scan treats bytecode as code it
// cannot read and holds the plugin. The constants are only used to verify
// smart-contract-wallet signatures (verifyHash, ERC-6492, ERC-8010) and to run
// deploy-less calls or a multicall with no deployed address. The SDK verifies EOA signatures locally and deployed ERC-1271 wallets by
// calling isValidSignature directly; it does not use these deploy-less paths.
// Celo has a deployed multicall3.
// If one of those paths were ever reached, the call would carry "0x" as code
// and fail at the RPC rather than run anything.
//
//   node scripts/strip-bytecode.mjs dist/server.mjs
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/strip-bytecode.mjs <bundle>");
const src = readFileSync(file, "utf8");

let n = 0;
const out = src.replace(/"0x(?:[0-9a-fA-F]{2}){200,}"/g, () => {
  n++;
  return '"0x" /* EVM bytecode removed by scripts/strip-bytecode.mjs */';
});

writeFileSync(file, out.replace(/[ \t]+$/gm, ""));
console.error(`strip-bytecode: ${n} bytecode constant(s) removed from ${file}`);
