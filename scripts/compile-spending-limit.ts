import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileSolidity, compilerVersion, solcSettings } from "./solidity";

/**
 * Writes both versions of the spending limit contract's ABI and bytecode to src/lib/spending-limit/artifact.json, under
 * `v1` and `v2` (docs/superpowers/specs/2026-10-19-spending-limit-v2-cross-chain-design.md V7), which the app deploys
 * and checks deployments against. Version 1's source never changes: contracts deployed from it are checked against its
 * code. Run after changing contracts/VestiarionSpendingLimitV2.sol:
 *
 *   npm run spending-limit:compile
 *
 * tests/spending-limit-contract.test.ts fails when either committed artifact is not what this compiles.
 */

const versions = {
  v1: { source: "contracts/VestiarionSpendingLimit.sol", contractName: "VestiarionSpendingLimit" },
  v2: { source: "contracts/VestiarionSpendingLimitV2.sol", contractName: "VestiarionSpendingLimitV2" },
};

const artifact = Object.fromEntries(
  Object.entries(versions).map(([version, { source, contractName }]) => {
    const compiled = compileSolidity(source, contractName);
    return [version, { contractName, source, compiler: compilerVersion(), settings: solcSettings(), abi: compiled.abi, bytecode: compiled.bytecode }];
  })
);
const out = path.resolve(import.meta.dirname, "../src/lib/spending-limit/artifact.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
for (const [version, entry] of Object.entries(artifact)) console.log(`${version}: ${(entry.bytecode.length - 2) / 2} bytes of bytecode`);
console.log(`wrote ${out}`);
