import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isAddress } from "viem";
import { describe, expect, it } from "vitest";

/**
 * Every address written in mixed case is in its checksummed form (EIP-55). viem checks a mixed-case address strictly
 * wherever it encodes one: on 2026-10-07 the deterministic deployment proxy, written with one letter in the wrong case,
 * stopped the first passkey setup on Arc mainnet inside Circle's SDK, while every test that only computed addresses
 * passed. All lower case (or all upper) makes no checksum claim and stays allowed.
 */

const ROOTS = ["src", "scripts"];
const SOURCE = /\.(ts|tsx|mjs|js)$/;
const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : SOURCE.test(name) ? [full] : [];
  });
}

const mixedCase = (address: string) => {
  const hex = address.slice(2);
  return hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
};

describe("addresses written in the code", () => {
  it("are checksummed wherever they are written in mixed case", () => {
    const wrong = ROOTS.flatMap((root) => files(path.join(process.cwd(), root))).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(ADDRESS)]
        .map((match) => match[0])
        .filter((address) => mixedCase(address) && !isAddress(address))
        .map((address) => `${path.relative(process.cwd(), file)}: ${address}`)
    );
    expect(wrong).toEqual([]);
  });

  it("would catch the proxy as it was written on 2026-10-07", () => {
    expect(isAddress("0x4e59b44847b379578588920cA78FbF26c0b4956C")).toBe(false);
    expect(isAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C")).toBe(true);
  });
});
