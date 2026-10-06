import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No module reads Arc testnet's profile, or a constant named for it, where it acts for a workspace
 * (docs/superpowers/specs/2026-10-05-network-threading-design.md P8). Each reads its workspace's profile, or its
 * record's. The files below read the testnet profile on purpose (P7), each with why; a new reader fails here.
 * Comments are not counted.
 */

const ROOT = process.cwd();
const IDENTIFIER = /\bARC_TESTNET\b|\bARC_TESTNET_[A-Z_]+\b|\bARC_NATIVE_USDC\b|\bUSDC_BY_CHAIN\b|\bPAYEE_CHAINS\b|\bPASSKEY_WALLET_NETWORK\b/g;
const PROFILE = "src/lib/network.ts";

/** The files that read the testnet profile on purpose, how often, and why (P7). */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "src/app/open/page.tsx": { count: 3, why: "/open shows both networks by design" },
  "src/components/wallet/PasskeyWallet.tsx": { count: 4, why: "the passkey wallet page, /wallet, is Arc testnet's: Modular Wallets run there only" },
  "src/lib/passkey-wallet-sdk.ts": { count: 5, why: "the passkey wallet's chain for viem, Arc testnet" },
  "src/lib/passkey-wallet-send.ts": { count: 3, why: "the passkey wallet's sends, on Arc testnet" },
  "src/lib/passkey-wallet.ts": { count: 6, why: "Modular Wallets run on Arc testnet only; a link offers one when its chain is Arc testnet's" },
  "src/lib/x402/offer.ts": { count: 5, why: "the platform's own x402 service sells on Arc testnet" },
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** The source without its comments: block comments, and line comments not inside a URL or a string's quotes. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function readersIn(source: string): number {
  return code(source).match(IDENTIFIER)?.length ?? 0;
}

describe("readers of Arc testnet's profile (network threading P8)", () => {
  it("are the files that read it on purpose, no more often", () => {
    const counts: Record<string, number> = {};
    for (const file of walk(path.join(ROOT, "src")).filter((name) => /\.(ts|tsx)$/.test(name))) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (rel === PROFILE) continue;
      const found = readersIn(readFileSync(file, "utf8"));
      if (found > 0) counts[rel] = found;
    }
    const allowed = Object.fromEntries(Object.entries(ALLOWED).map(([file, { count }]) => [file, count]));
    expect(counts, "a module reads its workspace's network (workspaceNetwork(), or its record's); a count that went down is written down here").toEqual(allowed);
  });

  it("finds a reader in code, and not in a comment", () => {
    expect(readersIn(`const usdc = ARC_TESTNET.tokens.USDC;`)).toBe(1);
    expect(readersIn(`import { ARC_TESTNET_USDC } from "./cctp";`)).toBe(1);
    expect(readersIn(`// reads ARC_TESTNET\nconst x = 1;`)).toBe(0);
    expect(readersIn(`const mainnet = ARC_MAINNET.rpcUrl;`)).toBe(0);
  });
});
