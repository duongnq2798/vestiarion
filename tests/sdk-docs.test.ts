import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSource } from "@/lib/docs/content";
import { Vestiarion, type FetchLike } from "../sdk/src/index";

/** The SDK's docs page and README name only what the SDK has, and the install that works (TypeScript SDK design R8). */

const pkg = JSON.parse(readFileSync("sdk/package.json", "utf8")) as { version: string; exports: Record<string, unknown> };
const never: FetchLike = async () => { throw new Error("not called"); };
const sdk = new Vestiarion({ apiKey: `vxk_abcdefgh_${"A".repeat(43)}`, fetch: never }) as unknown as Record<string, Record<string, unknown>>;

describe.each([
  ["the docs page", () => readSource("get-started/sdk")],
  ["the README", () => readFileSync("sdk/README.md", "utf8")],
])("%s", (_label, read) => {
  it("installs this version from the site", () => {
    expect(read()).toContain(`https://www.vestiarion.xyz/sdk/vestiarion-sdk-${pkg.version}.tgz`);
  });

  it("calls only methods the client has", () => {
    const calls = [...read().matchAll(/vestiarion\.(\w+)\.(\w+)\(/g)];
    expect(calls.length).toBeGreaterThan(5);
    for (const [, resource, method] of calls) expect(typeof sdk[resource]?.[method], `${resource}.${method}`).toBe("function");
  });

  it("imports only what the package exports", () => {
    for (const [, from] of read().matchAll(/from "(@vestiarion\/sdk[^"]*)"/g)) {
      expect(Object.keys(pkg.exports), from).toContain(from === "@vestiarion/sdk" ? "." : `./${from.slice("@vestiarion/sdk/".length)}`);
    }
  });
});
