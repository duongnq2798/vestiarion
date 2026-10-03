import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  it("lives in src/app/actions, except sign-in, accepting an invitation, creating a first workspace, your own account, a payee's own address, and a client's payment check", () => {
    const withDirective = walk(path.join(ROOT, "src")).filter(
      (file) => /\.(ts|tsx)$/.test(file) && /^\s*["']use server["']/.test(read(file))
    );
    const outside = withDirective.map(rel).filter((file) => !file.startsWith("src/app/actions/"));
    expect(outside.sort()).toEqual([
      "src/app/account/actions.ts", "src/app/invite/actions.ts", "src/app/login/actions.ts", "src/app/onboarding/actions.ts",
      "src/app/pay/[token]/actions.ts", "src/app/payee/[token]/actions.ts",
    ]);
  });

  const actions = ACTION_FILES.flatMap((file) =>
    exportedAsyncFunctions(read(file)).map((fn) => ({ label: `${rel(file)} ${fn.name}`, body: fn.body }))
  );

  it("exists — the list is not empty", () => {
    expect(actions.length).toBeGreaterThanOrEqual(5);
  });

  it.each(actions.map((action) => [action.label, action.body]))("%s awaits authorize first", (_label, body) => {
    expect(awaitedNames(body)[0]).toBe("authorize");
  });

  it.each(actions.map((action) => [action.label, action.body]))("%s does its work inside the organization's scope", (_label, body) => {
    expect(body).toMatch(/return inOrg\(auth, async \(\) =>/);
  });

  it("passes a permission string literal as the second argument to authorize", () => {
    const bodies = actions.map((action) => action.body).join("\n");
    const matches = bodies.match(/authorize\([^,]+,\s*"[a-z_.]+"\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });
});

describe("the payee's address action", () => {
  // A payee has no account: the one-time link is the credential, and whatever they
  // enter waits for a member's confirmation (payee links spec R1). So its gate is the
  // link itself — checked, claimed once, before anything else — never a session.
  const PAYEE_ACTIONS = path.join(ROOT, "src", "app", "payee", "[token]", "actions.ts");
  const actions = exportedAsyncFunctions(read(PAYEE_ACTIONS));

  it("is the one submit action", () => {
    expect(actions.map((action) => action.name)).toEqual(["submitPayeeAddressAction"]);
  });

  it("awaits the link check first, and enters no workspace itself", () => {
    const [action] = actions;
    expect(awaitedNames(action.body)[0]).toBe("submitPayeeAddress");
    expect(action.body).not.toMatch(/inOrg|withOrg|authorize/);
  });
});

describe("every onboarding action", () => {
  // Creating a workspace happens before there is an organization to authorize
  // against, so the gate is the session: a signed-out POST must stop there.
  const ONBOARDING_ACTIONS = path.join(ROOT, "src", "app", "onboarding", "actions.ts");
  const actions = existsSync(ONBOARDING_ACTIONS) ? exportedAsyncFunctions(read(ONBOARDING_ACTIONS)) : [];

  it("exists — the list is not empty", () => {
    expect(actions.map((action) => action.name)).toContain("createWorkspaceAction");
  });

  it.each(actions.map((action) => [action.name, action.body]))("%s awaits getSessionUser first", (_name, body) => {
    expect(awaitedNames(body)[0]).toBe("getSessionUser");
  });
});

describe("every invite action", () => {
  // Accepting an invitation happens before the visitor is necessarily a
  // member of the organization it names, so the gate is the session, exactly
  // as for the onboarding actions above.
  const INVITE_ACTIONS = path.join(ROOT, "src", "app", "invite", "actions.ts");
  const actions = existsSync(INVITE_ACTIONS) ? exportedAsyncFunctions(read(INVITE_ACTIONS)) : [];

  it("exists — the list is not empty", () => {
    expect(actions.map((action) => action.name)).toContain("acceptInvitationAction");
  });

  it.each(actions.map((action) => [action.name, action.body]))("%s awaits getSessionUser first", (_name, body) => {
    expect(awaitedNames(body)[0]).toBe("getSessionUser");
  });
});

describe("every account action", () => {
  // Deleting your own account needs no workspace role (spec §6, A1): the gate
  // is the session, and the person acted on is always the session's user.
  const ACCOUNT_ACTIONS = path.join(ROOT, "src", "app", "account", "actions.ts");
  const actions = existsSync(ACCOUNT_ACTIONS) ? exportedAsyncFunctions(read(ACCOUNT_ACTIONS)) : [];

  it("exists — the list is not empty", () => {
    expect(actions.map((action) => action.name).sort()).toEqual(["accountDeletionPlanAction", "deleteAccountAction"]);
  });

  it.each(actions.map((action) => [action.name, action.body]))("%s awaits getSessionUser first", (_name, body) => {
    expect(awaitedNames(body)[0]).toBe("getSessionUser");
  });

  it.each(actions.map((action) => [action.name, action.body]))("%s reads no user id from the form", (_name, body) => {
    expect(body).not.toMatch(/formData\.get\(["'](?:userId|user_id|id)["']\)/);
    expect(body).toMatch(/userId: user\.id|\(user\.id\)/);
  });
});

describe("the invite acceptance page", () => {
  it("does not import acceptInvitation — only the action does", () => {
    const source = read(path.join(ROOT, "src", "app", "invite", "[token]", "page.tsx"));
    expect(source).not.toMatch(/acceptInvitation/);
  });
});

describe("the entry points bound to the founding organization", () => {
  it("the demo reset enters it explicitly", () => {
    expect(read(path.join(ROOT, "src", "app", "api", "agent", "reset", "route.ts"))).toContain("withFoundingOrg(");
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

describe("the cron", () => {
  it("runs every live organization instead of the founding one (spec §4.4)", () => {
    const source = read(path.join(ROOT, "src", "app", "api", "agent", "tick", "route.ts"));
    expect(source).toContain("runLiveOrganizations(");
    expect(source).not.toContain("withFoundingOrg(");
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

/** Modules that read or write tenant data, or hand out an organization's secrets. */
const TENANT_DATA_MODULES = [
  "src/lib/queries", "src/lib/ledger", "src/lib/insights", "src/lib/landing", "src/lib/dal",
  "src/lib/circle", "src/lib/compliance", "src/lib/payments", "src/lib/seed",
];

function loadsTenantData(modulePath: string): boolean {
  return TENANT_DATA_MODULES.includes(modulePath) || modulePath.startsWith("src/lib/dal/");
}

/**
 * Every import that loads a module at run time, with the names it binds:
 * `default`, `*` for a namespace, a re-export or `import()`, and none for a
 * bare side-effect import. `import type` and a named block whose every
 * specifier is `type` are erased by the compiler, so they are not listed.
 */
function valueImports(source: string): Array<{ specifier: string; names: string[] }> {
  const found: Array<{ specifier: string; names: string[] }> = [];
  const valueNames = (block: string) =>
    block.split(",").map((part) => part.trim()).filter((part) => part && !/^type\s/.test(part)).map((part) => part.split(/\s+as\s+/)[0]);
  for (const [, clause, specifier] of source.matchAll(/^\s*import\s+([^"';]*?)\s+from\s+["']([^"']+)["']/gm)) {
    if (/^type\s/.test(clause)) continue;
    const block = /\{([^}]*)\}/.exec(clause);
    const names = block ? valueNames(block[1]) : [];
    for (const part of clause.replace(/\{[^}]*\}/, "").split(",").map((piece) => piece.trim()).filter(Boolean)) {
      names.push(part.startsWith("*") ? "*" : "default");
    }
    if (names.length > 0) found.push({ specifier, names });
  }
  for (const [, specifier] of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) found.push({ specifier, names: [] });
  for (const [, clause, specifier] of source.matchAll(/^\s*export\s+([^"';]*?)\s+from\s+["']([^"']+)["']/gm)) {
    if (/^type\s/.test(clause)) continue;
    const block = /\{([^}]*)\}/.exec(clause);
    const names = block ? valueNames(block[1]) : ["*"];
    if (names.length > 0) found.push({ specifier, names });
  }
  for (const [, specifier] of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) found.push({ specifier, names: ["*"] });
  return found;
}

/** The repository path an application specifier names (`@/…` or relative), or `null` for a package. */
function moduleOf(specifier: string, file: string): string | null {
  const target = specifier.startsWith("@/")
    ? path.join(ROOT, "src", specifier.slice(2))
    : specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : null;
  return target ? rel(target).replace(/\.(tsx?|jsx?|mjs)$/, "").replace(/\/index$/, "") : null;
}

describe("every component", () => {
  // A page loads its data inside `inOrg` and hands it down, because React can
  // render a component after the page function has returned — outside the
  // organization's scope, where a tenant read refuses — and a component in a
  // client bundle has no database at all. So a component takes tenant data
  // as props and never loads it: a type from these modules is fine, a value
  // is not. The one exception reads platform configuration, not tenant data:
  // Shell's `import { screeningMode } from "@/lib/compliance"`.
  const COMPONENTS = walk(path.join(ROOT, "src", "components")).filter((file) => /\.(ts|tsx)$/.test(file));

  it("exists — the list is not empty", () => {
    expect(COMPONENTS.length).toBeGreaterThanOrEqual(10);
  });

  it("never value-imports a module that loads tenant data", () => {
    const offending = COMPONENTS.flatMap((file) =>
      valueImports(read(file)).flatMap(({ specifier, names }) => {
        const imported = moduleOf(specifier, file);
        if (!imported || !loadsTenantData(imported)) return [];
        if (imported === "src/lib/compliance" && names.length > 0 && names.every((name) => name === "screeningMode")) return [];
        return [`${rel(file)}: { ${names.join(", ")} } from "${specifier}"`];
      })
    );
    expect(offending).toEqual([]);
  });

  it("reads imports the way that check depends on", () => {
    // Without this, a parser that found nothing would pass the check above.
    expect(valueImports(read(path.join(ROOT, "src", "components", "vx", "Shell.tsx")))).toContainEqual({
      specifier: "@/lib/compliance",
      names: ["screeningMode"],
    });
    expect(valueImports('import type { LedgerEntry } from "@/lib/ledger";\nimport { type A,\n  type B } from "@/lib/queries";\n')).toEqual([]);
    expect(
      valueImports(
        'import { stats, type Stats } from "@/lib/queries";\nimport * as ledger from "../../lib/ledger";\nimport "@/lib/seed";\n' +
          'export { db } from "@/lib/dal";\nconst later = () => import("@/lib/payments");\n'
      )
    ).toEqual([
      { specifier: "@/lib/queries", names: ["stats"] },
      { specifier: "../../lib/ledger", names: ["*"] },
      { specifier: "@/lib/seed", names: [] },
      { specifier: "@/lib/dal", names: ["db"] },
      { specifier: "@/lib/payments", names: ["*"] },
    ]);
    expect(moduleOf("../../lib/dal/scope", path.join(ROOT, "src", "components", "vx", "Shell.tsx"))).toBe("src/lib/dal/scope");
  });
});

/**
 * The one v1 route that takes no key: the OpenAPI document describes the
 * surface and holds no workspace data. It is named here, not matched by
 * pattern, so a second public route is a deliberate edit to this list.
 */
const PUBLIC_V1_ROUTES = ["src/app/api/v1/openapi.json/route.ts"];

/**
 * Every src module a file loads at run time, followed through its imports.
 * A module `stop` names is listed but not followed.
 */
function reachableModules(file: string, seen = new Set<string>(), stop: (module: string) => boolean = () => false): Set<string> {
  for (const { specifier } of valueImports(read(file))) {
    const target = moduleOf(specifier, file);
    if (!target || !target.startsWith("src/") || seen.has(target)) continue;
    seen.add(target);
    if (stop(target)) continue;
    const source = [".ts", ".tsx", "/index.ts"].map((ext) => path.join(ROOT, target + ext)).find((candidate) => existsSync(candidate));
    if (source) reachableModules(source, seen, stop);
  }
  return seen;
}

describe("the public /api/v1 routes", () => {
  it.each(PUBLIC_V1_ROUTES)("%s exists, and loads no module that reads tenant data or checks a key", (file) => {
    expect(V1_ROUTES.map(rel)).toContain(file);
    const modules = [...reachableModules(path.join(ROOT, file))];
    // Without this, a walk that found nothing would pass the check below.
    expect(modules).toContain("src/lib/api/openapi");
    expect(modules.filter((name) => loadsTenantData(name) || name === "src/lib/api/guard")).toEqual([]);
  });
});

describe("every /api/v1 route", () => {
  it.each(V1_ROUTES.map(rel).filter((file) => !PUBLIC_V1_ROUTES.includes(file)))("%s authenticates the API key before any work, and serves that key's workspace", (file) => {
    const source = read(path.join(ROOT, file));
    const handlers = source.split(/\n(?=export async function (?:GET|POST|PUT|PATCH|DELETE)\b)/).slice(1);
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) {
      // A write asks for the write scope and its issuer as they are now; every read, for read (write API R1; part 2, W5).
      const write = /^export async function POST\b/.test(handler.trimStart());
      expect(awaitedNames(handler)[0]).toBe(write ? "guardApiWrite" : "guardApiRequest");
      const call = write ? "const guard = await guardApiWrite(request);" : 'const guard = await guardApiRequest(request, { scope: "read" });';
      const guard = handler.indexOf(`${call}\n  if ("denied" in guard) return guard.denied;`);
      expect(guard).toBeGreaterThan(-1);
      const handle = handler.indexOf("handleApiRequest(");
      expect(handle).toBeGreaterThan(guard);
      expect(handler.slice(handle)).toMatch(/^handleApiRequest\(\s*"[^"]+",\s*guard\.key,/);
    }
  });

  it("checks a write's key and scope before it reads the key's issuer (write API part 2, W5)", () => {
    const source = read(path.join(ROOT, "src/lib/api/guard.ts"));
    const write = source.slice(source.indexOf("export async function guardApiWrite("));
    const body = write.slice(0, write.indexOf("\n}\n"));
    expect(awaitedNames(body)[0]).toBe("guardApiRequest");
    expect(body).toContain('const guard = await guardApiRequest(request, { scope: "write" });\n  if ("denied" in guard) return guard;');
    expect(body.indexOf("memberActor(")).toBeGreaterThan(body.indexOf("guardApiRequest("));
  });
});

/**
 * The MCP server (docs/superpowers/specs/2026-09-30-mcp-server-design.md, M2
 * and M3) is keyed like a v1 route and reads nothing itself: a tool call runs
 * a keyed v1 route handler, which checks the key again and enters that key's
 * workspace. It is named here by its exact file, like the public route above.
 */
const MCP_ROUTE = "src/app/api/mcp/route.ts";

describe("the MCP route", () => {
  const source = read(path.join(ROOT, MCP_ROUTE));
  const handler = source.slice(source.indexOf("async function handler("));

  it("authenticates the API key before handing the request to the MCP handler, for every method", () => {
    expect(awaitedNames(handler)[0]).toBe("guardApiRequest");
    const guard = handler.indexOf('const guard = await guardApiRequest(request, { scope: "read" });\n  if ("denied" in guard) {');
    expect(guard).toBeGreaterThan(-1);
    expect(handler.indexOf("return serve(request);")).toBeGreaterThan(guard);
    expect(source.match(/serve\(/g)).toHaveLength(1);
    expect(source).toMatch(/^export \{ handler as GET, handler as POST, handler as DELETE \};$/m);
    expect(source).not.toMatch(/^export (async )?function/m);
  });

  it("never reads a key from the URL, and never enters an organization itself", () => {
    for (const forbidden of ["searchParams", "nextUrl", "withOrg", "inOrg", "handleApiRequest", "withFoundingOrg", "AGENT_API_TOKEN", "hasValidAgentBearer"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("reaches tenant data only through the keyed /api/v1 route handlers", () => {
    const keyed = V1_ROUTES.map(rel).filter((file) => !PUBLIC_V1_ROUTES.includes(file)).map((file) => file.replace(/\.ts$/, ""));
    // The v1 routes and their guard are pinned above; the walk stops at them.
    const boundary = (name: string) => name === "src/lib/api/guard" || name.startsWith("src/app/api/v1/");
    const modules = [...reachableModules(path.join(ROOT, MCP_ROUTE), new Set(), boundary)];
    // Without this, a walk that found nothing would pass the checks below.
    expect(modules).toContain("src/lib/mcp/call");
    expect(modules.filter(boundary).sort()).toEqual([...keyed, "src/lib/api/guard"].sort());
    expect(modules.filter((name) => !boundary(name) && loadsTenantData(name))).toEqual([]);
  });
});

describe("the v1 API's guard", () => {
  const files = walk(path.join(ROOT, "src", "lib", "api")).filter((file) => file.endsWith(".ts"));

  it("exists — the list is not empty", () => {
    expect(files.map(rel)).toContain("src/lib/api/guard.ts");
  });

  it.each(files.map(rel))("%s neither enters the founding organization nor reads the platform token", (file) => {
    const source = read(path.join(ROOT, file));
    expect(source).not.toContain("withFoundingOrg");
    expect(source).not.toContain("AGENT_API_TOKEN");
    expect(source).not.toContain("hasValidAgentBearer");
  });
});
