import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The access gates Plan 1 put in place, pinned as source structure.
 *
 * They are structural on purpose. A layout does not gate its child segments in
 * this Next version, so the only gate is the first thing each page does; a
 * server action is a public POST endpoint, so the only gate is the first thing
 * each action does. Neither is visible to a unit test of the function behind
 * it, and both are one careless edit away from gone.
 */

const ROOT = process.cwd();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Names awaited in a block of source, in order: `await foo(` → "foo", `await params` → "params". */
function awaitedNames(source: string): string[] {
  return [...source.matchAll(/await\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
}

function defaultExportBody(source: string): string {
  const start = source.indexOf("export default async function");
  return start >= 0 ? source.slice(start) : "";
}

/** Each top-level `export async function`, with its text up to the next top-level export. */
function exportedAsyncFunctions(source: string): Array<{ name: string; body: string }> {
  return source.split(/\n(?=export )/).flatMap((part) => {
    const match = /^export async function (\w+)/.exec(part.trimStart());
    return match ? [{ name: match[1], body: part }] : [];
  });
}

const PAGES = walk(path.join(ROOT, "src", "app", "o")).filter((file) => file.endsWith(`${path.sep}page.tsx`));
const ACTION_DIR = path.join(ROOT, "src", "app", "actions");
const ACTION_FILES = readdirSync(ACTION_DIR).filter((name) => name.endsWith(".ts")).map((name) => path.join(ACTION_DIR, name));
const V1_ROUTES = walk(path.join(ROOT, "src", "app", "api", "v1")).filter((file) => file.endsWith(`${path.sep}route.ts`));

describe("every /o/[slug] page", () => {
  it("exists — the list is not empty", () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(7);
  });

  it.each(PAGES.map(rel))("%s awaits its params, then requireMembership, before anything else", (file) => {
    const names = awaitedNames(defaultExportBody(read(path.join(ROOT, file))));
    expect(names.slice(0, 2)).toEqual(["params", "requireMembership"]);
  });

  it.each(PAGES.map(rel))("%s renders per request", (file) => {
    expect(read(path.join(ROOT, file))).toContain('export const dynamic = "force-dynamic"');
  });

  it.each(PAGES.map(rel))("%s loads its data inside the organization's scope", (file) => {
    const body = defaultExportBody(read(path.join(ROOT, file)));
    expect(body).toMatch(/const access = await requireMembership\(slug\);/);
    expect(body).toMatch(/return inOrg\(access, async \(\) =>/);
  });
});

describe("every server action", () => {
  it("lives in src/app/actions, except the public sign-in action", () => {
    const withDirective = walk(path.join(ROOT, "src")).filter(
      (file) => /\.(ts|tsx)$/.test(file) && /^\s*["']use server["']/.test(read(file))
    );
    const outside = withDirective.map(rel).filter((file) => !file.startsWith("src/app/actions/"));
    expect(outside).toEqual(["src/app/login/actions.ts"]);
  });

  const actions = ACTION_FILES.flatMap((file) =>
    exportedAsyncFunctions(read(file)).map((fn) => ({ label: `${rel(file)} ${fn.name}`, body: fn.body }))
  );

  it("exists — the list is not empty", () => {
    expect(actions.length).toBeGreaterThanOrEqual(5);
  });

  it.each(actions.map((action) => [action.label, action.body]))("%s awaits authorizeMutation first", (_label, body) => {
    expect(awaitedNames(body)[0]).toBe("authorizeMutation");
  });

  it.each(actions.map((action) => [action.label, action.body]))("%s does its work inside the organization's scope", (_label, body) => {
    expect(body).toMatch(/return inOrg\(auth, async \(\) =>/);
  });
});

describe("the entry points bound to the founding organization", () => {
  it("the cron enters it explicitly", () => {
    expect(read(path.join(ROOT, "src", "app", "api", "agent", "tick", "route.ts"))).toContain("withFoundingOrg(");
  });

  it("the ledger verify route checks the session and the membership before verifying", () => {
    const source = read(path.join(ROOT, "src", "app", "api", "ledger", "verify", "route.ts"));
    const session = source.indexOf("getSessionUser(");
    const membership = source.indexOf("membershipFor(");
    const verify = source.indexOf("verifyLedger(");
    expect(session).toBeGreaterThan(-1);
    expect(membership).toBeGreaterThan(session);
    expect(verify).toBeGreaterThan(membership);
  });
});

describe("the membership lookup", () => {
  const source = read(path.join(ROOT, "src", "lib", "auth", "membership.ts"));

  it("inner-joins the organization, so filtering by slug drops rows instead of nulling the join", () => {
    // Without `!inner`, `.eq("orgs.slug", slug)` only empties the embedded
    // organization; the membership row still comes back, and a member of one
    // workspace would pass the gate of every other.
    expect(source).toMatch(/const SELECT = "role, orgs!inner\(/);
    expect(source).toContain('.eq("orgs.slug", slug)');
  });
});

describe("every /api/v1 route", () => {
  it.each(V1_ROUTES.map(rel))("%s checks the bearer token before any work", (file) => {
    const source = read(path.join(ROOT, file));
    const handlers = source.split(/\n(?=export async function (?:GET|POST|PUT|PATCH|DELETE)\b)/).slice(1);
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) {
      const guard = handler.indexOf("guardApiRequest(");
      expect(guard).toBeGreaterThan(-1);
      const firstWork = Math.min(
        ...[handler.indexOf("await "), handler.indexOf("handleApiRequest(")].filter((index) => index >= 0)
      );
      expect(guard).toBeLessThan(firstWork);
    }
  });
});
