import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No new hard-coded Arc testnet identifier (docs/superpowers/specs/2026-10-05-network-foundation-design.md N8). Each
 * network's facts belong in its profile (src/lib/network.ts). The files that still hold a testnet identifier are listed
 * with how many each holds, so a new one fails here, and moving one into the profile lowers the count, which is then
 * written down here. Comments are not counted, and neither is copy that says "Arc testnet".
 */

const ROOT = process.cwd();
const IDENTIFIER =
  /ARC-TESTNET|rpc\.testnet\.arc|explorer\.testnet\.arc\.io|5042002|gateway-api-testnet|iris-api-sandbox|0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a|Arc_Testnet|ArcTestnet/g;
const PROFILE = "src/lib/network.ts";

/** The files that still hold a testnet identifier, and how many: lower these as they move into the profile. */
const ALLOWED: Record<string, number> = {
  "src/app/api/v1/counterparties/route.ts": 1,
  "src/app/design/fixtures.ts": 4,
  "src/app/docs-shots/shots.tsx": 3,
  "src/app/o/[slug]/contractors/page.tsx": 2,
  "src/components/intake/CounterpartyIntake.tsx": 1,
  "src/components/payee/PayeeJourney.tsx": 2,
  "src/components/vx/map.ts": 1,
  "src/lib/api/schemas.ts": 1,
  "src/lib/github/bounties.ts": 1,
  "src/lib/intake-validation.ts": 1,
  "src/lib/pay-freelancer.ts": 2,
  "src/lib/platform/payee-links.ts": 1,
  "src/lib/platform/workspace.ts": 2,
  "src/lib/sample-data.ts": 1,
  "src/lib/seed.ts": 9,
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

function identifiersIn(source: string): number {
  return code(source).match(IDENTIFIER)?.length ?? 0;
}

describe("hard-coded Arc testnet identifiers (network foundation N8)", () => {
  it("appear only where they did when the profile was made, no more often", () => {
    const counts: Record<string, number> = {};
    for (const file of walk(path.join(ROOT, "src")).filter((name) => /\.(ts|tsx)$/.test(name))) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (rel === PROFILE) continue;
      const found = identifiersIn(readFileSync(file, "utf8"));
      if (found > 0) counts[rel] = found;
    }
    expect(counts, "a testnet identifier belongs in src/lib/network.ts; a count that went down is written down here").toEqual(ALLOWED);
  });

  it("finds an identifier in code, and not in a comment or a URL's slashes", () => {
    expect(identifiersIn(`const chain = "ARC-TESTNET";`)).toBe(1);
    expect(identifiersIn(`// pays on ARC-TESTNET\nconst x = 1;`)).toBe(0);
    expect(identifiersIn(`/** on ARC-TESTNET */\nconst x = 1;`)).toBe(0);
    expect(identifiersIn(`const url = "https://explorer.testnet.arc.io/tx/";`)).toBe(1);
  });
});
