import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../sdk/src/version";

/** The TypeScript SDK as a package (docs/superpowers/specs/2026-10-03-typescript-sdk-design.md R1, R2). */

const pkg = JSON.parse(readFileSync("sdk/package.json", "utf8")) as Record<string, unknown>;

describe("the SDK package", () => {
  it("states its version once: VERSION is package.json's", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("is an ESM package for Node 20 or later, with no runtime dependencies", () => {
    expect(pkg).toMatchObject({ name: "@vestiarion/sdk", type: "module", license: "MIT", engines: { node: ">=20" } });
    expect(pkg.dependencies).toBeUndefined();
  });

  it("uses fetch and Web Crypto only: nothing in sdk/src imports a node: module", () => {
    for (const file of readdirSync("sdk/src")) {
      expect(readFileSync(`sdk/src/${file}`, "utf8"), file).not.toMatch(/from "node:|require\(/);
    }
  });
});
