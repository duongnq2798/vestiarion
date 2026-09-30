import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A server component may render a client component, or pass it props, but may
 * never call a function a "use client" module exports: Next throws at request
 * time ("Attempted to call X() from the server but X is on the client"), and
 * neither the type checker, the build nor a node test notices, since here the
 * import is an ordinary function. The Counterparties page broke this way in
 * production (counterpartiesRefreshMs, 2026-09-30). This reads every server
 * file under src/app and fails on any such call.
 */

const ROOT = process.cwd();
const APP = path.join(ROOT, "src", "app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const isClient = (source: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source);

/** The file an `@/…` or relative import names, if it is one of ours. */
function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? path.join(ROOT, "src", specifier.slice(2)) : specifier.startsWith(".") ? path.resolve(path.dirname(from), specifier) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, path.join(base, "index.tsx"), path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every name a file imports, with the file it comes from. */
function imports(file: string, source: string): Array<{ name: string; from: string }> {
  const found: Array<{ name: string; from: string }> = [];
  for (const match of source.matchAll(/import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
    if (match[1]) continue;
    const target = resolveImport(file, match[3]);
    if (!target) continue;
    const clause = match[2];
    const names: string[] = [];
    const defaultName = /^([A-Za-z_$][\w$]*)/.exec(clause.trim());
    if (defaultName && !clause.trim().startsWith("{")) names.push(defaultName[1]);
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) {
      for (const part of named[1].split(",")) {
        const trimmed = part.trim();
        if (!trimmed || trimmed.startsWith("type ")) continue;
        names.push(trimmed.split(/\s+as\s+/).pop() as string);
      }
    }
    for (const name of names) found.push({ name, from: target });
  }
  return found;
}

describe("server files under src/app", () => {
  it("never call a function exported by a \"use client\" module", () => {
    const offences: string[] = [];
    for (const file of walk(APP).filter((f) => /\.(ts|tsx)$/.test(f))) {
      const source = readFileSync(file, "utf8");
      if (isClient(source)) continue;
      for (const { name, from } of imports(file, source)) {
        if (!isClient(readFileSync(from, "utf8"))) continue;
        // A call, not JSX (`<Name`) or a reference passed as a prop.
        if (new RegExp(`(?<![<\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`).test(source)) {
          offences.push(`${path.relative(ROOT, file).replace(/\\/g, "/")} calls ${name}() from ${path.relative(ROOT, from).replace(/\\/g, "/")}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});
