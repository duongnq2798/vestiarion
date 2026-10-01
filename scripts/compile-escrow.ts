import { writeFileSync } from "node:fs";
import path from "node:path";
import { compileSolidity, compilerVersion, solcSettings } from "./solidity";

/**
 * Writes the escrow contract's ABI and bytecode to src/lib/escrow/artifact.json, which the app deploys
 * through Circle's Smart Contract Platform. Run after changing contracts/VestiarionEscrow.sol:
 *
 *   npm run escrow:compile
 *
 * tests/escrow-contract.test.ts fails when the committed artifact is not what this compiles.
 */

const compiled = compileSolidity("contracts/VestiarionEscrow.sol", "VestiarionEscrow");
const artifact = {
  contractName: "VestiarionEscrow",
  source: "contracts/VestiarionEscrow.sol",
  compiler: compilerVersion(),
  settings: solcSettings(),
  abi: compiled.abi,
  bytecode: compiled.bytecode,
};
const out = path.resolve(import.meta.dirname, "../src/lib/escrow/artifact.json");
writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`wrote ${out} (${(compiled.bytecode.length - 2) / 2} bytes of bytecode)`);
