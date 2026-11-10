import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Next.js ships as packages that move together: `next`, `@next/mdx` (the docs' MDX) and `eslint-config-next` (the lint
 * rules). Each is pinned to one exact version, the same for all three, so an upgrade that bumps `next` alone fails here
 * instead of building with mixed versions. The lock must also carry `next`'s compiler for Linux, where CI and Vercel
 * build: an install on Windows can drop platform builds it cannot use (scripts/check-lockfile.mjs).
 */

type Pkg = { dependencies: Record<string, string>; devDependencies: Record<string, string> };
type Lock = { packages: Record<string, { version?: string }> };

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Pkg;
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as Lock;

const declared = {
  next: pkg.dependencies.next,
  "@next/mdx": pkg.dependencies["@next/mdx"],
  "eslint-config-next": pkg.devDependencies["eslint-config-next"],
};

describe("the Next.js packages", () => {
  it("are each pinned to an exact version", () => {
    for (const [name, version] of Object.entries(declared)) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("are all pinned to the same version", () => {
    expect(new Set(Object.values(declared))).toEqual(new Set([declared.next]));
  });

  it("are locked at the version package.json declares", () => {
    for (const [name, version] of Object.entries(declared)) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
    }
  });

  it("lock every compiler build at next's version, Linux x64 included", () => {
    const builds = Object.entries(lock.packages).filter(([key]) => key.startsWith("node_modules/@next/swc-"));
    expect(builds.map(([key]) => key)).toContain("node_modules/@next/swc-linux-x64-gnu");
    for (const [key, entry] of builds) expect(entry.version, key).toBe(declared.next);
  });
});
