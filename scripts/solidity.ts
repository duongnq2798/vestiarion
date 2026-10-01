import { readFileSync } from "node:fs";
import path from "node:path";
// solc ships CommonJS; its default export is the compiler wrapper.
import solc from "solc";

/**
 * Compiles a Solidity source with the project's pinned compiler and settings (contracts/solc-settings.json):
 * `evmVersion: "paris"`, because Arc testnet rejects the PUSH0 opcode later versions emit. Shared by the
 * artifact script (scripts/compile-escrow.ts) and the tests, so the two can never compile differently.
 */

export interface CompiledContract {
  abi: unknown[];
  bytecode: `0x${string}`;
  deployedBytecode: `0x${string}`;
}

const ROOT = path.resolve(import.meta.dirname, "..");

export function solcSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(ROOT, "contracts/solc-settings.json"), "utf8")) as Record<string, unknown>;
}

export function compilerVersion(): string {
  return (solc as { version(): string }).version();
}

export function compileSolidity(file: string, contract: string): CompiledContract {
  const source = readFileSync(path.join(ROOT, file), "utf8");
  const input = { language: "Solidity", sources: { [file]: { content: source } }, settings: solcSettings() };
  const output = JSON.parse((solc as { compile(input: string): string }).compile(JSON.stringify(input))) as {
    errors?: Array<{ severity: string; formattedMessage: string }>;
    contracts?: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>>;
  };
  const errors = (output.errors ?? []).filter((error) => error.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((error) => error.formattedMessage).join("\n"));
  const compiled = output.contracts?.[file]?.[contract];
  if (!compiled) throw new Error(`${contract} not found in ${file}`);
  return {
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`,
    deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
  };
}
