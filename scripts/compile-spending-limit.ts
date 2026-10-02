import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileSolidity, compilerVersion, solcSettings } from "./solidity";

/**
 * Writes the spending limit contract's ABI and bytecode to src/lib/spending-limit/artifact.json, which the app
 * deploys through Circle's Smart Contract Platform. Run after changing contracts/VestiarionSpendingLimit.sol:
 *
 *   npm run spending-limit:compile
 *
 * tests/spending-limit-contract.test.ts fails when the committed artifact is not what this compiles.
 */

const compiled = compileSolidity("contracts/VestiarionSpendingLimit.sol", "VestiarionSpendingLimit");
const artifact = {
  contractName: "VestiarionSpendingLimit",
  source: "contracts/VestiarionSpendingLimit.sol",
  compiler: compilerVersion(),
  settings: solcSettings(),
  abi: compiled.abi,
  bytecode: compiled.bytecode,
};
const out = path.resolve(import.meta.dirname, "../src/lib/spending-limit/artifact.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`wrote ${out} (${(compiled.bytecode.length - 2) / 2} bytes of bytecode)`);
