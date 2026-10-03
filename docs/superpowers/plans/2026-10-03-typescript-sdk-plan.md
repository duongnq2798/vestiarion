# TypeScript SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@vestiarion/sdk` 0.1.0: a zero-dependency typed client for `/api/v1`, with pagination, retries that never
add a record twice, and webhook and ledger-entry verification. It is installable today from a tarball the site serves.

**Architecture:**
- **The package.** `sdk/` is a self-contained ESM package that the repository's own `tsc`, ESLint and Vitest also
  cover. It is built only on `fetch` and Web Crypto.
- **The types.** They are rendered from the OpenAPI document by an in-repo generator (`scripts/lib/sdk-types.ts`), and
  a drift test holds the committed file to it.
- **The release.** `npm run sdk:pack` compiles and packs the package into `public/sdk/vestiarion-sdk-<version>.tgz`,
  which is committed and immutable. A test holds the tarball to a fresh build.

**Tech Stack:** TypeScript 5.9 (NodeNext output), Web Crypto (HMAC-SHA256, SHA-256, Ed25519), Vitest, tsx, npm pack.

**Spec:** `docs/superpowers/specs/2026-10-03-typescript-sdk-design.md`

## Global Constraints

- **Package:** name `@vestiarion/sdk`, version `0.1.0`, license MIT, `"type": "module"`, `"engines": { "node": ">=20" }`.
  It has no `dependencies`.
- **Platform APIs:** `sdk/src` uses `fetch` and Web Crypto only. Nothing in it imports a `node:` module.
- **Install URL:** `https://www.vestiarion.xyz/sdk/vestiarion-sdk-0.1.0.tgz`.
- **Client defaults:**
  - base URL `https://www.vestiarion.xyz`;
  - `maxRetries` 2;
  - `timeoutMs` 30 000;
  - `Retry-After` honoured up to 60 s (a longer one is thrown);
  - backoff from 0.5 s up to 8 s, with jitter.
- **Headers:** every request sends `Authorization: Bearer <key>` and `User-Agent: vestiarion-sdk-js/<version>`. Every
  write sends an `Idempotency-Key`: the caller's, or a fresh UUID for that call.
- **Errors:** every request failure is a `VestiarionError` with `status`, `code`, `message` and `retryAfter`. Its codes
  are the API's codes plus `network_error`, `timeout` and `invalid_response`.
- **Key safety:** the API key never appears in a URL, a log or an error message.
- **Copy:** say "Arc testnet" plainly, with no disclaimers. Commit and PR wording stays neutral. Every change updates
  its docs in the same PR.
- **Line endings:** sources are LF (`.gitattributes`). Generated JS and `.d.ts` are emitted with `newLine: "lf"`.

## Review Focus

- A malformed page (`hasMore: true` with `nextCursor: null`, or the same cursor answered twice) ends `pages`/`listAll`
  or throws. It never loops forever. *(Task 4 test)*
- An empty or non-JSON `2xx` answer (a `204`, a proxy's HTML) is a `VestiarionError` `invalid_response`, not a
  `SyntaxError`. *(Task 3 test)*
- The API key never shows in an error message, a URL, or the `TypeError` for a malformed key. *(Tasks 3 and 4
  tests)*
- `verifyWebhook` handed a parsed object instead of the raw body says so (`malformed`). It never "verifies"
  `[object Object]`. *(Task 6 test)*
- A signature exactly 300 s old is accepted and one 301 s old is refused, as the server's own check does. *(Task 6
  test)*

---

### Task 1: The package scaffold

**Files:**
- Create: `sdk/package.json`, `sdk/tsconfig.json`, `sdk/LICENSE` (copy of the root `LICENSE`), `sdk/src/version.ts`
- Modify: `.gitignore` (add `sdk/dist/`), `tsconfig.json` (exclude `sdk/dist`), `eslint.config.mjs` (ignore `sdk/dist/**`)
- Test: `tests/sdk-package.test.ts`

**Interfaces:**
- Produces: `VERSION: string` from `sdk/src/version.ts`, and the build config `sdk/tsconfig.json` (`module`
  `NodeNext`, `outDir` `dist`, `rootDir` `src`, `newLine` `lf`, `types: []`).

- [ ] **Step 1: Write the failing test** (`tests/sdk-package.test.ts`)

```ts
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
```

- [ ] **Step 2: Run it:** `npx vitest run tests/sdk-package.test.ts`. Expected: FAIL, because
  `sdk/src/version` and `sdk/package.json` do not exist.

- [ ] **Step 3: Write the scaffold**

`sdk/package.json`:

```json
{
  "name": "@vestiarion/sdk",
  "version": "0.1.0",
  "description": "A typed client for the Vestiarion API and its signed webhooks.",
  "license": "MIT",
  "type": "module",
  "sideEffects": false,
  "engines": { "node": ">=20" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./webhooks": { "types": "./dist/webhooks.d.ts", "import": "./dist/webhooks.js" }
  },
  "types": "./dist/index.d.ts",
  "files": ["dist", "README.md", "LICENSE"],
  "homepage": "https://www.vestiarion.xyz/docs/get-started/sdk",
  "repository": { "type": "git", "url": "git+https://github.com/duongnq2798/vestiarion.git", "directory": "sdk" },
  "keywords": ["vestiarion", "stablecoin", "treasury", "arc", "usdc", "webhooks"]
}
```

`sdk/tsconfig.json` (the build; the repository's own `tsconfig.json` type-checks `sdk/src` too):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "newLine": "lf",
    "types": []
  },
  "include": ["src"]
}
```

`sdk/src/version.ts`:

```ts
/** This package's version, sent in every request's `User-Agent`. tests/sdk-package.test.ts holds it to package.json. */
export const VERSION = "0.1.0";
```

Also:
- `sdk/LICENSE` is a copy of the root `LICENSE`;
- `.gitignore` gains `sdk/dist/`;
- the root `tsconfig.json` `exclude` gains `"sdk/dist"`;
- `eslint.config.mjs` `globalIgnores` gains `"sdk/dist/**"`.

- [ ] **Step 4: Run it:** `npx vitest run tests/sdk-package.test.ts` and `npx tsc --noEmit -p .`. Expected: PASS
  (3 tests), and tsc clean.

- [ ] **Step 5: Commit:** "Start the TypeScript SDK package".

---

### Task 2: Types rendered from the OpenAPI document

**Files:**
- Create: `scripts/lib/sdk-types.ts`, `scripts/sdk-types.ts`, `sdk/src/types.ts` (generated)
- Modify: `package.json` (script `"sdk:types": "tsx scripts/sdk-types.ts"`)
- Test: `tests/sdk-types.test.ts`

**Interfaces:**
- Consumes: `buildOpenApiDocument(origin)` from `src/lib/api/openapi.ts`.
- Produces from `sdk/src/types.ts`:
  - `API_ERROR_CODES` (a readonly tuple) and `ApiErrorCode`;
  - the interfaces `Status`, `LedgerEntry`, `LedgerVerification`, `Invoice`, `Counterparty`, `CounterpartyDetail`,
    `Milestone`, `Treasury`, `Insights`, `Page`, `CreateInvoiceInput`, `CreateCounterpartyInput`,
    `ListLedgerEntriesParams`, `ListInvoicesParams`, `ListCounterpartiesParams` and `ListMilestonesParams`;
- also `renderSdkTypes(doc: OpenApiDoc): string`.

- [ ] **Step 1: Write the failing test** (`tests/sdk-types.test.ts`)

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { renderSdkTypes, type OpenApiDoc } from "../scripts/lib/sdk-types";

/** The SDK's types are the OpenAPI document's (TypeScript SDK design R3). */

const doc = () => structuredClone(buildOpenApiDocument("https://www.vestiarion.xyz")) as unknown as OpenApiDoc;
const schemas = (d: OpenApiDoc) => d.components.schemas as Record<string, any>;

describe("sdk/src/types.ts", () => {
  it("is what the generator renders from the current OpenAPI document: run npm run sdk:types after an API change", () => {
    expect(readFileSync("sdk/src/types.ts", "utf8")).toBe(renderSdkTypes(doc()));
  });

  it("names each payload, keeps each field's description, and renders nulls, enums, records and the error codes", () => {
    const out = renderSdkTypes(doc());
    for (const name of ["Status", "LedgerEntry", "LedgerVerification", "Invoice", "Counterparty", "CounterpartyDetail", "Milestone", "Treasury", "Insights", "Page", "CreateInvoiceInput", "CreateCounterpartyInput", "ListInvoicesParams", "ListLedgerEntriesParams", "ListCounterpartiesParams", "ListMilestonesParams"]) {
      expect(out, name).toContain(`export interface ${name} {`);
    }
    expect(out).toContain('direction: "payable" | "receivable";');
    expect(out).toContain("/** Why the agent ruled as it did, verbatim from the decision. */");
    expect(out).toContain("memo: string | null;");
    expect(out).toMatch(/earlyPayDiscount: \{\n\s+percent: number;\n\s+deadline: string;\n\s+\} \| null;/);
    expect(out).toContain("detail: Record<string, unknown>;");
    expect(out).toContain('export const API_ERROR_CODES = ["unauthorized", "forbidden", "not_found", "invalid_request", "conflict", "rate_limited", "unavailable", "internal"] as const;');
    expect(out).toMatch(/export interface ListInvoicesParams \{[\s\S]*?status\?: "pending" \| "matched"/);
    expect(out).toMatch(/export interface CreateInvoiceInput \{[\s\S]*?counterpartyId: string;[\s\S]*?direction\?: "payable" \| "receivable";/);
  });

  it("throws on a JSON Schema keyword it does not render, rather than guess a type", () => {
    const d = doc();
    schemas(d).GetStatusResponse.properties.data.properties.businessName.oneOf = [];
    expect(() => renderSdkTypes(d)).toThrow(/"oneOf" is not rendered/);
  });

  it("throws when a write's answer is not its list's item, so one name never hides two shapes", () => {
    const d = doc();
    schemas(d).CreateInvoiceResponse.properties.data.properties.extra = { type: "string" };
    expect(() => renderSdkTypes(d)).toThrow(/Invoice: CreateInvoiceResponse\.data differs/);
  });
});
```

- [ ] **Step 2: Run it:** `npx vitest run tests/sdk-types.test.ts`. Expected: FAIL, because the module
  `../scripts/lib/sdk-types` is not found.

- [ ] **Step 3: Write the generator** (`scripts/lib/sdk-types.ts`)

```ts
/**
 * Renders sdk/src/types.ts from the API's OpenAPI document (docs/superpowers/specs/2026-10-03-typescript-sdk-design.md
 * R3): each payload the API answers with, each write's body and each list's query parameters, as named TypeScript
 * types whose fields keep their descriptions.
 *
 * It reads only the part of JSON Schema the document uses, and throws on any other keyword rather than guess: a type
 * it cannot render is a type the SDK would get wrong.
 */

type Schema = Record<string, unknown>;

export interface OpenApiDoc {
  components: { schemas: Record<string, Schema> };
  paths: Record<string, Record<string, { operationId: string; parameters?: Array<{ name: string; in: string; required: boolean; description?: string; schema: Schema }> }>>;
}

const RENDERED = new Set(["type", "properties", "required", "items", "enum", "const", "anyOf", "additionalProperties", "propertyNames", "description", "minimum", "maximum", "pattern", "default"]);

/** Each named type, where in the document it is read, and the places that must hold the same schema. */
const NAMED: Array<{ name: string; at: string[]; same?: string[][] }> = [
  { name: "Status", at: ["GetStatusResponse", "data"] },
  { name: "LedgerEntry", at: ["ListLedgerEntriesResponse", "data", "[]"] },
  { name: "LedgerVerification", at: ["VerifyLedgerResponse", "data"] },
  { name: "Invoice", at: ["ListInvoicesResponse", "data", "[]"], same: [["CreateInvoiceResponse", "data"]] },
  { name: "Counterparty", at: ["ListCounterpartiesResponse", "data", "[]"], same: [["CreateCounterpartyResponse", "data"]] },
  { name: "CounterpartyDetail", at: ["GetCounterpartyResponse", "data"] },
  { name: "Milestone", at: ["ListMilestonesResponse", "data", "[]"] },
  { name: "Treasury", at: ["GetTreasuryResponse", "data"] },
  { name: "Insights", at: ["GetInsightsResponse", "data"] },
  {
    name: "Page",
    at: ["ListInvoicesResponse", "page"],
    same: [["ListLedgerEntriesResponse", "page"], ["ListCounterpartiesResponse", "page"], ["ListMilestonesResponse", "page"]],
  },
  { name: "CreateInvoiceInput", at: ["CreateInvoiceRequest"] },
  { name: "CreateCounterpartyInput", at: ["CreateCounterpartyRequest"] },
];

const HEADER = `// Generated from the API's OpenAPI document (/api/v1/openapi.json) by \`npm run sdk:types\`, with
// scripts/lib/sdk-types.ts. Do not edit it by hand: tests/sdk-types.test.ts fails when it differs from what the
// generator renders now.`;

function at(doc: OpenApiDoc, path: string[]): Schema {
  let schema: Schema | undefined = doc.components.schemas[path[0]];
  for (const step of path.slice(1)) {
    if (!schema) break;
    schema = step === "[]" ? (schema.items as Schema | undefined) : (schema.properties as Record<string, Schema> | undefined)?.[step];
  }
  if (!schema) throw new Error(`${path.join(".")} is not in the OpenAPI document.`);
  return schema;
}

function checkKeywords(schema: Schema, where: string): void {
  for (const key of Object.keys(schema)) {
    if (!RENDERED.has(key)) throw new Error(`${where}: JSON Schema keyword "${key}" is not rendered by the SDK type generator.`);
  }
}

function comment(description: unknown, indent: string): string {
  if (typeof description !== "string" || description.trim() === "") return "";
  const lines = description.replaceAll("*/", "*\\/").split("\n");
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((line) => `${indent} *${line ? ` ${line}` : ""}`).join("\n")}\n${indent} */\n`;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function objectType(schema: Schema, indent: string, where: string): string {
  const properties = schema.properties as Record<string, Schema> | undefined;
  if (!properties) {
    const values = schema.additionalProperties;
    const valueType = values && typeof values === "object" && Object.keys(values).length > 0 ? typeOf(values as Schema, indent, `${where}{}`) : "unknown";
    return `Record<string, ${valueType}>`;
  }
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const inner = `${indent}  `;
  const members = Object.entries(properties).map(([name, property]) => {
    const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
    return `${comment(property.description, inner)}${inner}${key}${required.has(name) ? "" : "?"}: ${typeOf(property, inner, `${where}.${name}`)};`;
  });
  return `{\n${members.join("\n")}\n${indent}}`;
}

function typeOf(schema: Schema, indent: string, where: string): string {
  checkKeywords(schema, where);
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (Array.isArray(schema.anyOf)) return (schema.anyOf as Schema[]).map((member, i) => typeOf(member, indent, `${where}.anyOf[${i}]`)).join(" | ");
  const types = Array.isArray(schema.type) ? (schema.type as unknown[]) : [schema.type];
  return types
    .map((type) => {
      switch (type) {
        case "string":
          return "string";
        case "number":
        case "integer":
          return "number";
        case "boolean":
          return "boolean";
        case "null":
          return "null";
        case "array":
          return `Array<${typeOf(schema.items as Schema, indent, `${where}[]`)}>`;
        case "object":
          return objectType(schema, indent, where);
        default:
          throw new Error(`${where}: type ${JSON.stringify(type)} is not rendered by the SDK type generator.`);
      }
    })
    .join(" | ");
}

function pascal(id: string): string {
  return id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

export function renderSdkTypes(doc: OpenApiDoc): string {
  const parts = [HEADER];

  const code = at(doc, ["ApiError", "error", "code"]);
  checkKeywords(code, "ApiError.error.code");
  if (!Array.isArray(code.enum)) throw new Error("ApiError.error.code has no enum.");
  parts.push(
    `${comment(code.description, "")}export const API_ERROR_CODES = [${code.enum.map((value) => JSON.stringify(value)).join(", ")}] as const;\n\nexport type ApiErrorCode = (typeof API_ERROR_CODES)[number];`
  );

  for (const { name, at: path, same } of NAMED) {
    const schema = at(doc, path);
    for (const other of same ?? []) {
      if (JSON.stringify(at(doc, other)) !== JSON.stringify(schema)) {
        throw new Error(`${name}: ${other.join(".")} differs from ${path.join(".")}; the two cannot share one type.`);
      }
    }
    parts.push(`${comment(schema.description, "")}export interface ${name} ${typeOf(schema, "", name)}`);
  }

  for (const methods of Object.values(doc.paths)) {
    for (const operation of Object.values(methods)) {
      const query = (operation.parameters ?? []).filter((parameter) => parameter.in === "query");
      if (query.length === 0) continue;
      const members = query.map(
        (parameter) =>
          `${comment(parameter.description, "  ")}  ${parameter.name}${parameter.required ? "" : "?"}: ${typeOf(parameter.schema, "  ", `${operation.operationId}.${parameter.name}`)};`
      );
      parts.push(`/** The query parameters of \`${operation.operationId}\`. */\nexport interface ${pascal(operation.operationId)}Params {\n${members.join("\n")}\n}`);
    }
  }

  return `${parts.join("\n\n")}\n`;
}
```

`scripts/sdk-types.ts`:

```ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildOpenApiDocument } from "../src/lib/api/openapi";
import { renderSdkTypes, type OpenApiDoc } from "./lib/sdk-types";

/**
 * Writes sdk/src/types.ts from the API's OpenAPI document. Run after changing an operation, a schema or a parameter:
 *
 *   npm run sdk:types
 *
 * tests/sdk-types.test.ts fails while the committed file is not what this renders.
 */
const out = path.resolve(import.meta.dirname, "../sdk/src/types.ts");
writeFileSync(out, renderSdkTypes(buildOpenApiDocument("https://www.vestiarion.xyz") as unknown as OpenApiDoc));
console.log(`wrote ${out}`);
```

`package.json` scripts gain `"sdk:types": "tsx scripts/sdk-types.ts"`.

- [ ] **Step 4: Generate:** `npm run sdk:types`. Expected: "wrote …/sdk/src/types.ts".
- [ ] **Step 5: Run the tests:** `npx vitest run tests/sdk-types.test.ts`, then `npx tsc --noEmit -p .` and
  `npx tsc --noEmit -p sdk`. Expected: 4 passed; both tsc runs clean.
- [ ] **Step 6: Commit:** "Render the SDK's types from the OpenAPI document".

---

### Task 3: Errors and the request engine

**Files:**
- Create: `sdk/src/errors.ts`, `sdk/src/http.ts`
- Test: `tests/sdk-transport.test.ts`

**Interfaces:**
- Consumes: `API_ERROR_CODES`, `ApiErrorCode` (Task 2) and `VERSION` (Task 1).
- Produces:
  - `class VestiarionError extends Error { status: number; code: VestiarionErrorCode; retryAfter: number | null }`;
  - `type VestiarionErrorCode`;
  - `type FetchLike`;
  - `createTransport(options: TransportOptions): Transport`, with `Transport.request<T>(spec: RequestSpec): Promise<T>`
    and `RequestSpec = { method: "GET" | "POST"; path: string; query?: object; body?: unknown; idempotencyKey?: string }`.

- [ ] **Step 1: Write the failing test** (`tests/sdk-transport.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { VestiarionError } from "../sdk/src/errors";
import { createTransport, type FetchLike, type TransportOptions } from "../sdk/src/http";
import { VERSION } from "../sdk/src/version";

/** One request, from the SDK to the API and back (TypeScript SDK design R4–R6). */

const KEY = `vxk_abcdefgh_${"A".repeat(43)}`;
type Answer = { status: number; body?: string; headers?: Record<string, string> } | Error;
type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function answering(...answers: Answer[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    const next = answers.shift() ?? { status: 500 };
    if (next instanceof Error) throw next;
    return { status: next.status, headers: { get: (name: string) => next.headers?.[name.toLowerCase()] ?? null }, text: async () => next.body ?? "" };
  };
  return { calls, fetch };
}

function transport(fetch: FetchLike, over: Partial<TransportOptions> = {}) {
  const waits: number[] = [];
  const t = createTransport({ apiKey: KEY, baseUrl: "https://api.test/", fetch, maxRetries: 2, timeoutMs: 1000, sleep: async (ms) => void waits.push(ms), random: () => 1, uuid: () => "generated-key", ...over });
  return { t, waits };
}

const ok = (data: unknown, status = 200) => ({ status, body: JSON.stringify({ data }) });
const failure = (status: number, code: string, message = "Said the API.", headers?: Record<string, string>) => ({ status, body: JSON.stringify({ error: { code, message } }), headers });
const caught = (promise: Promise<unknown>) => promise.then(() => { throw new Error("resolved"); }, (error: unknown) => error as VestiarionError);

describe("a request", () => {
  it("sends the key as a bearer token and its version as the User-Agent, and leaves out empty query values", async () => {
    const { calls, fetch } = answering(ok([]));
    await transport(fetch).t.request({ method: "GET", path: "/api/v1/invoices", query: { limit: 5, status: undefined, cursor: "a+b/c=" } });
    expect(calls[0].url).toBe("https://api.test/api/v1/invoices?limit=5&cursor=a%2Bb%2Fc%3D");
    expect(calls[0].headers).toMatchObject({ authorization: `Bearer ${KEY}`, "user-agent": `vestiarion-sdk-js/${VERSION}`, accept: "application/json" });
    expect(calls[0].headers).not.toHaveProperty("idempotency-key");
    expect(calls[0].body).toBeUndefined();
  });

  it("returns the answer's JSON", async () => {
    const { fetch } = answering(ok({ id: "i1" }));
    expect(await transport(fetch).t.request({ method: "GET", path: "/api/v1/status" })).toEqual({ data: { id: "i1" } });
  });

  it.each([
    [400, "invalid_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
  ])("throws the API's %i as a VestiarionError with its code and message, and does not retry it", async (status, code) => {
    const { calls, fetch } = answering(failure(status, code));
    const { t, waits } = transport(fetch);
    const error = await caught(t.request({ method: "GET", path: "/api/v1/status" }));
    expect(error).toBeInstanceOf(VestiarionError);
    expect(error).toMatchObject({ status, code, message: "Said the API.", retryAfter: null });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("never repeats the key in an error (Review focus 3)", async () => {
    const { fetch } = answering(failure(401, "unauthorized", "A valid API key is required."));
    const error = await caught(transport(fetch).t.request({ method: "GET", path: "/api/v1/status" }));
    expect(`${error.message} ${String(error)} ${JSON.stringify(error)}`).not.toContain(KEY);
  });

  it("retries a 503 and a network failure with backoff, then returns the answer", async () => {
    const { calls, fetch } = answering({ status: 503 }, new TypeError("fetch failed"), ok("done"));
    const { t, waits } = transport(fetch);
    expect(await t.request({ method: "GET", path: "/api/v1/status" })).toEqual({ data: "done" });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
  });

  it("waits as long as Retry-After says on a 429", async () => {
    const { fetch } = answering(failure(429, "rate_limited", "Too many.", { "retry-after": "2" }), ok("done"));
    const { t, waits } = transport(fetch);
    await t.request({ method: "GET", path: "/api/v1/status" });
    expect(waits).toEqual([2000]);
  });

  it("throws a 429 whose Retry-After is more than a minute, without waiting", async () => {
    const { calls, fetch } = answering(failure(429, "rate_limited", "Too many.", { "retry-after": "120" }));
    const { t, waits } = transport(fetch);
    const error = await caught(t.request({ method: "GET", path: "/api/v1/status" }));
    expect(error).toMatchObject({ status: 429, code: "rate_limited", retryAfter: 120 });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("gives up after maxRetries, with the last answer's error", async () => {
    const { calls, fetch } = answering({ status: 503 }, { status: 503 }, { status: 503 });
    const { t, waits } = transport(fetch);
    const error = await caught(t.request({ method: "GET", path: "/api/v1/status" }));
    expect(error).toMatchObject({ status: 503, code: "unavailable", message: "The API answered HTTP 503." });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
  });

  it("caps the backoff at 8 seconds", async () => {
    const { fetch } = answering({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, ok("done"));
    const { t, waits } = transport(fetch, { maxRetries: 6 });
    await t.request({ method: "GET", path: "/api/v1/status" });
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
  });

  it("times out an attempt that gets no answer", async () => {
    const fetch: FetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const error = await caught(transport(fetch, { timeoutMs: 5, maxRetries: 0 }).t.request({ method: "GET", path: "/api/v1/status" }));
    expect(error).toMatchObject({ status: 0, code: "timeout" });
  });

  it.each([
    ["a 2xx that is not JSON", { status: 200, body: "<html>" }],
    ["an empty 2xx", { status: 204, body: "" }],
  ])("answers %s with invalid_response, not a crash, and does not retry it (Review focus 2)", async (_label, answer) => {
    const { calls, fetch } = answering(answer);
    const error = await caught(transport(fetch).t.request({ method: "GET", path: "/api/v1/status" }));
    expect(error).toMatchObject({ code: "invalid_response" });
    expect(calls).toHaveLength(1);
  });

  it("names the status's code when the body is not the API's", async () => {
    const { fetch } = answering({ status: 502, body: "<html>Bad gateway</html>" });
    const error = await caught(transport(fetch, { maxRetries: 0 }).t.request({ method: "GET", path: "/api/v1/status" }));
    expect(error).toMatchObject({ status: 502, code: "internal", message: "The API answered HTTP 502." });
  });
});

describe("a write", () => {
  it("sends its body as JSON with a fresh Idempotency-Key, and repeats the same key and body on a retry", async () => {
    const { calls, fetch } = answering({ status: 503 }, ok({ id: "i1" }, 201));
    await transport(fetch).t.request({ method: "POST", path: "/api/v1/invoices", body: { amount: "0.10" } });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers).toMatchObject({ "idempotency-key": "generated-key", "content-type": "application/json" });
      expect(call.body).toBe('{"amount":"0.10"}');
    }
  });

  it("sends the caller's Idempotency-Key when given", async () => {
    const { calls, fetch } = answering(ok({}, 201));
    await transport(fetch).t.request({ method: "POST", path: "/api/v1/invoices", body: {}, idempotencyKey: "billing-inv-1" });
    expect(calls[0].headers["idempotency-key"]).toBe("billing-inv-1");
  });

  it("retries a 409 that answers its own retry: the first attempt is still being handled", async () => {
    const { calls, fetch } = answering({ status: 503 }, failure(409, "conflict"), ok({ id: "i1" }, 201));
    const { t, waits } = transport(fetch);
    expect(await t.request({ method: "POST", path: "/api/v1/invoices", body: {} })).toEqual({ data: { id: "i1" } });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
  });

  it("throws a 409 on the first attempt: the caller used a key twice", async () => {
    const { calls, fetch } = answering(failure(409, "conflict"));
    const error = await caught(transport(fetch).t.request({ method: "POST", path: "/api/v1/invoices", body: {} }));
    expect(error).toMatchObject({ status: 409, code: "conflict" });
    expect(calls).toHaveLength(1);
  });

  it("never retries a read's 409", async () => {
    const { calls, fetch } = answering({ status: 503 }, failure(409, "conflict"));
    const error = await caught(transport(fetch).t.request({ method: "GET", path: "/api/v1/status" }));
    expect(error).toMatchObject({ code: "conflict" });
    expect(calls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it:** `npx vitest run tests/sdk-transport.test.ts`. Expected: FAIL, because
  `../sdk/src/errors` is not found.

- [ ] **Step 3: Write `sdk/src/errors.ts`**

```ts
import type { ApiErrorCode } from "./types.js";

/** What went wrong: one of the API's own codes, or what happened before an answer arrived. */
export type VestiarionErrorCode = ApiErrorCode | "network_error" | "timeout" | "invalid_response";

/**
 * Every failed request (TypeScript SDK design R5): the HTTP status (0 when no answer arrived), a code to branch on,
 * the API's own message, and how long the API's `Retry-After` asked to wait, in seconds.
 */
export class VestiarionError extends Error {
  readonly name = "VestiarionError";

  constructor(
    readonly status: number,
    readonly code: VestiarionErrorCode,
    message: string,
    readonly retryAfter: number | null = null
  ) {
    super(message);
  }
}
```

- [ ] **Step 4: Write `sdk/src/http.ts`**

```ts
import { VestiarionError, type VestiarionErrorCode } from "./errors.js";
import { API_ERROR_CODES, type ApiErrorCode } from "./types.js";
import { VERSION } from "./version.js";

/** The part of `fetch` the SDK uses. Pass your own to route, record or proxy its requests. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface TransportOptions {
  apiKey: string;
  baseUrl: string;
  fetch: FetchLike;
  maxRetries: number;
  timeoutMs: number;
  /** Waits that many milliseconds. Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** A number in [0, 1), for the backoff's jitter. Replaced in tests. */
  random?: () => number;
  /** A fresh Idempotency-Key. Replaced in tests. */
  uuid?: () => string;
}

export interface RequestSpec {
  method: "GET" | "POST";
  path: string;
  query?: object;
  body?: unknown;
  idempotencyKey?: string;
}

export interface Transport {
  request<T>(spec: RequestSpec): Promise<T>;
}

/** The longest `Retry-After` the SDK waits out; a longer one is thrown, so a call never blocks for minutes (R6). */
const RETRY_AFTER_CAP_S = 60;
const BACKOFF_START_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const RETRIED_STATUSES = new Set([500, 502, 503, 504]);
const API_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

type Outcome<T> = { value: T } | { error: VestiarionError; retryInMs: number | null };

function queryString(query: object | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(name, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function retryAfterSeconds(header: string | null): number | null {
  return header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
}

/** The API's own `{ error: { code, message } }`, or null for any other body. */
function apiErrorOf(text: string): { code: ApiErrorCode; message: string } | null {
  try {
    const error = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }).error;
    if (typeof error?.code === "string" && API_CODES.has(error.code) && typeof error.message === "string") {
      return { code: error.code as ApiErrorCode, message: error.message };
    }
  } catch {
    // Not JSON: a proxy's page, or nothing.
  }
  return null;
}

/** What a status means when its body is not the API's own error. */
function codeForStatus(status: number): VestiarionErrorCode {
  const named: Record<number, VestiarionErrorCode> = { 400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "rate_limited", 503: "unavailable" };
  return named[status] ?? (status >= 500 ? "internal" : "invalid_response");
}

export function createTransport(options: TransportOptions): Transport {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
  const fetchImpl = options.fetch;
  const base = options.baseUrl.replace(/\/+$/, "");

  function backoff(attempt: number): number {
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** attempt);
    return Math.round(ceiling / 2 + (random() * ceiling) / 2);
  }

  function retryDelay(status: number, retryAfter: number | null, attempt: number, method: RequestSpec["method"]): number | null {
    const waitable = retryAfter !== null && retryAfter <= RETRY_AFTER_CAP_S;
    if (status === 429) return retryAfter === null ? backoff(attempt) : waitable ? retryAfter * 1000 : null;
    if (RETRIED_STATUSES.has(status)) return waitable ? (retryAfter as number) * 1000 : backoff(attempt);
    // The same key and body again: a conflict now means the first attempt is still being handled (R6).
    if (status === 409 && method === "POST" && attempt > 0) return backoff(attempt);
    return null;
  }

  async function attemptOnce<T>(url: string, init: { method: string; headers: Record<string, string>; body?: string }, attempt: number, method: RequestSpec["method"]): Promise<Outcome<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      let status: number;
      let headers: { get(name: string): string | null };
      let text: string;
      try {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        status = response.status;
        headers = response.headers;
        text = await response.text();
      } catch {
        const error = controller.signal.aborted
          ? new VestiarionError(0, "timeout", `No answer within ${options.timeoutMs} ms.`)
          : new VestiarionError(0, "network_error", "The request did not reach the API.");
        return { error, retryInMs: backoff(attempt) };
      }
      if (status >= 200 && status < 300) {
        try {
          return { value: JSON.parse(text) as T };
        } catch {
          return { error: new VestiarionError(status, "invalid_response", "The API's answer was not JSON."), retryInMs: null };
        }
      }
      const retryAfter = retryAfterSeconds(headers.get("retry-after"));
      const own = apiErrorOf(text);
      const error = new VestiarionError(status, own?.code ?? codeForStatus(status), own?.message ?? `The API answered HTTP ${status}.`, retryAfter);
      return { error, retryInMs: retryDelay(status, retryAfter, attempt, method) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function request<T>(spec: RequestSpec): Promise<T> {
    const url = `${base}${spec.path}${queryString(spec.query)}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.apiKey}`,
      accept: "application/json",
      "user-agent": `vestiarion-sdk-js/${VERSION}`,
    };
    let body: string | undefined;
    if (spec.method === "POST") {
      headers["content-type"] = "application/json";
      // Every write carries a key, so retrying it can never add the record twice (R6).
      headers["idempotency-key"] = spec.idempotencyKey ?? uuid();
      body = JSON.stringify(spec.body ?? {});
    }
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await attemptOnce<T>(url, { method: spec.method, headers, body }, attempt, spec.method);
      if ("value" in outcome) return outcome.value;
      if (outcome.retryInMs === null || attempt >= options.maxRetries) throw outcome.error;
      await sleep(outcome.retryInMs);
    }
  }

  return { request };
}
```

- [ ] **Step 5: Run it:** `npx vitest run tests/sdk-transport.test.ts`, then `npx tsc --noEmit -p sdk`. Expected: all
  pass, and tsc clean.
- [ ] **Step 6: Commit:** "Add the SDK's request engine: errors, retries, idempotent writes".

---

### Task 4: The client

**Files:**
- Create: `sdk/src/client.ts`, `sdk/src/index.ts`
- Test: `tests/sdk-client.test.ts`

**Interfaces:**
- Consumes: `createTransport`, `FetchLike` and `Transport` (Task 3), and the types (Task 2).
- Produces:
  - `class Vestiarion` with the resources `status`, `ledger`, `invoices`, `counterparties`, `milestones`, `treasury`
    and `insights`;
  - `interface VestiarionOptions`, `interface List<T> { data: T[]; page: Page }`,
    `interface WriteOptions { idempotencyKey?: string }`, `interface Collection<T, P>`, and `DEFAULT_BASE_URL`;
  - from `sdk/src/index.ts`: the client, the errors, `FetchLike`, `VERSION` and every type.

- [ ] **Step 1: Write the failing test** (`tests/sdk-client.test.ts`)

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATIONS } from "@/lib/api/openapi";
import { Vestiarion, VestiarionError, type FetchLike } from "../sdk/src/index";

/** The client's methods, one per API operation (TypeScript SDK design R4). */

const KEY = `vxk_abcdefgh_${"A".repeat(43)}`;
type Call = { url: URL; method: string; headers: Record<string, string>; body?: string };

function client(answer: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url: new URL(url), method: init.method, headers: { ...init.headers }, body: init.body };
    calls.push(call);
    const { status, body } = answer(call);
    return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return { calls, sdk: new Vestiarion({ apiKey: KEY, baseUrl: "https://api.test", fetch, maxRetries: 0 }) };
}

const page = (nextCursor: string | null, count: number) => ({ nextCursor, hasMore: nextCursor !== null, count });
const anything = (call: Call) => ({ status: call.method === "POST" ? 201 : 200, body: { data: call.url.pathname.endsWith("s") ? [] : {}, page: page(null, 0) } });

const INVOICE = { counterpartyId: "6b361405-cfda-4400-a286-364b561911ce", amount: "0.10", dueDate: "2026-10-03" };
const COUNTERPARTY = { name: "API Test Vendor", role: "vendor" as const };

/** How each operation is called through the SDK. */
const CALLS: Record<string, (sdk: Vestiarion) => Promise<unknown>> = {
  "get-status": (sdk) => sdk.status.get(),
  "list-ledger-entries": (sdk) => sdk.ledger.list(),
  "verify-ledger": (sdk) => sdk.ledger.verify(),
  "list-invoices": (sdk) => sdk.invoices.list(),
  "create-invoice": (sdk) => sdk.invoices.create(INVOICE),
  "list-counterparties": (sdk) => sdk.counterparties.list(),
  "get-counterparty": (sdk) => sdk.counterparties.get("cp_1"),
  "create-counterparty": (sdk) => sdk.counterparties.create(COUNTERPARTY),
  "list-milestones": (sdk) => sdk.milestones.list(),
  "get-treasury": (sdk) => sdk.treasury.get(),
  "get-insights": (sdk) => sdk.insights.get(),
};

afterEach(() => vi.unstubAllGlobals());

describe("new Vestiarion", () => {
  it("refuses a key that is not a workspace API key, without repeating it (Review focus 3)", () => {
    const attempt = () => new Vestiarion({ apiKey: "sk_live_not_ours_123" });
    expect(attempt).toThrow(TypeError);
    expect(attempt).toThrow(/vxk_<prefix>_<secret>/);
    expect(attempt).not.toThrow(/sk_live_not_ours_123/);
  });

  it("uses the runtime's fetch by default, called as a function, on www.vestiarion.xyz", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", function (this: unknown, url: string) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      seen.push(url);
      return Promise.resolve(new Response(JSON.stringify({ data: {} })));
    });
    await new Vestiarion({ apiKey: KEY }).status.get();
    expect(seen).toEqual(["https://www.vestiarion.xyz/api/v1/status"]);
  });
});

describe("the client's methods", () => {
  it("cover every API operation, each sending the operation's method and path", async () => {
    expect(Object.keys(CALLS).sort()).toEqual(OPERATIONS.map((op) => op.id).sort());
    for (const op of OPERATIONS) {
      const { calls, sdk } = client(anything);
      await CALLS[op.id](sdk);
      expect(calls, op.id).toHaveLength(1);
      expect(calls[0].method, op.id).toBe(op.method.toUpperCase());
      expect(calls[0].url.pathname, op.id).toBe(op.path.replace("{id}", "cp_1"));
    }
  });

  it("return a resource's data, and a list's data and page", async () => {
    const { sdk } = client(() => ({ status: 200, body: { data: { apiVersion: "v1" } } }));
    expect(await sdk.status.get()).toEqual({ apiVersion: "v1" });
    const lists = client(() => ({ status: 200, body: { data: [{ id: "i1" }], page: page(null, 1) } }));
    expect(await lists.sdk.invoices.list({ status: "held" })).toEqual({ data: [{ id: "i1" }], page: page(null, 1) });
    expect(lists.calls[0].url.search).toBe("?status=held");
  });

  it("encode a counterparty's id in its path", async () => {
    const { calls, sdk } = client(() => ({ status: 200, body: { data: {} } }));
    await sdk.counterparties.get("a/b?c");
    expect(calls[0].url.pathname).toBe("/api/v1/counterparties/a%2Fb%3Fc");
  });

  it("send a write's input as its body, with the caller's idempotencyKey", async () => {
    const { calls, sdk } = client(() => ({ status: 201, body: { data: { id: "i1" } } }));
    expect(await sdk.invoices.create(INVOICE, { idempotencyKey: "billing-inv-1" })).toEqual({ id: "i1" });
    expect(JSON.parse(calls[0].body!)).toEqual(INVOICE);
    expect(calls[0].headers["idempotency-key"]).toBe("billing-inv-1");
  });
});

describe("pagination", () => {
  const twoPages = (call: Call) =>
    call.url.searchParams.get("cursor") === "c1"
      ? { status: 200, body: { data: [{ id: "c" }], page: page(null, 1) } }
      : { status: 200, body: { data: [{ id: "a" }, { id: "b" }], page: page("c1", 2) } };

  it("listAll yields every item, passing each nextCursor back with the same filters", async () => {
    const { calls, sdk } = client(twoPages);
    const ids: string[] = [];
    for await (const invoice of sdk.invoices.listAll({ status: "held" })) ids.push(invoice.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(calls.map((call) => call.url.search)).toEqual(["?status=held", "?status=held&cursor=c1"]);
  });

  it("pages starts at the cursor given, so a ledger mirror resumes from what it stored", async () => {
    const { calls, sdk } = client(twoPages);
    const cursors: Array<string | null> = [];
    for await (const answer of sdk.ledger.pages({ cursor: "c1" })) cursors.push(answer.page.nextCursor);
    expect(cursors).toEqual([null]);
    expect(calls.map((call) => call.url.searchParams.get("cursor"))).toEqual(["c1"]);
  });

  it("ends at a page that says there is more but gives no cursor, and refuses the same cursor twice (Review focus 1)", async () => {
    const noCursor = client(() => ({ status: 200, body: { data: [{ id: "a" }], page: { nextCursor: null, hasMore: true, count: 1 } } }));
    const ids: string[] = [];
    for await (const invoice of noCursor.sdk.invoices.listAll()) ids.push(invoice.id);
    expect(ids).toEqual(["a"]);

    const stuck = client(() => ({ status: 200, body: { data: [], page: page("same", 0) } }));
    const pages = stuck.sdk.invoices.pages({ cursor: "same" });
    await expect((async () => { for await (const _ of pages) void _; })()).rejects.toMatchObject({ code: "invalid_response" });
    expect(stuck.calls).toHaveLength(1);
  });

  it("throws a failed page as a VestiarionError", async () => {
    const { sdk } = client(() => ({ status: 400, body: { error: { code: "invalid_request", message: "cursor is not valid for this endpoint." } } }));
    await expect(sdk.invoices.list({ cursor: "x" })).rejects.toBeInstanceOf(VestiarionError);
  });
});
```

- [ ] **Step 2: Run it:** `npx vitest run tests/sdk-client.test.ts`. Expected: FAIL, because `../sdk/src/index`
  is not found.

- [ ] **Step 3: Write `sdk/src/client.ts`**

```ts
import { VestiarionError } from "./errors.js";
import { createTransport, type FetchLike, type Transport } from "./http.js";
import type {
  Counterparty,
  CounterpartyDetail,
  CreateCounterpartyInput,
  CreateInvoiceInput,
  Insights,
  Invoice,
  LedgerEntry,
  LedgerVerification,
  ListCounterpartiesParams,
  ListInvoicesParams,
  ListLedgerEntriesParams,
  ListMilestonesParams,
  Milestone,
  Page,
  Status,
  Treasury,
} from "./types.js";

/** Where the API is, unless `baseUrl` says otherwise. */
export const DEFAULT_BASE_URL = "https://www.vestiarion.xyz";

export interface VestiarionOptions {
  /** A workspace API key, `vxk_<prefix>_<secret>`. Keep it on a server: it reads the whole workspace. */
  apiKey: string;
  /** Where the API is. Defaults to `https://www.vestiarion.xyz`. */
  baseUrl?: string;
  /** Defaults to the runtime's `fetch`. */
  fetch?: FetchLike;
  /** How many times a request is retried after a 429, a 5xx, a timeout or a network failure. Defaults to 2. */
  maxRetries?: number;
  /** How long one attempt may take, in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
}

/** One page of a collection, as the API answers it. */
export interface List<T> {
  data: T[];
  page: Page;
}

/** A write's options: the `Idempotency-Key` that makes retrying it safe. Best: the record's id in your own system. */
export interface WriteOptions {
  idempotencyKey?: string;
}

export interface Collection<T, P> {
  /** One page, `{ data, page }`. Pass `page.nextCursor` back as `cursor` for the next. */
  list(params?: P): Promise<List<T>>;
  /** Every page in turn, from `params.cursor` on. Store each `page.nextCursor` once its page is processed, to resume from it. */
  pages(params?: P): AsyncIterable<List<T>>;
  /** Every item, page after page, until the collection ends. */
  listAll(params?: P): AsyncIterable<T>;
}

const KEY_FORMAT = /^vxk_[a-z2-7]{8}_[A-Za-z0-9_-]{43}$/;

function collection<T, P extends { cursor?: string }>(transport: Transport, path: string): Collection<T, P> {
  const list = (params?: P) => transport.request<List<T>>({ method: "GET", path, query: params });
  async function* pages(params?: P): AsyncGenerator<List<T>> {
    let cursor = params?.cursor;
    for (;;) {
      const answer = await list({ ...params, cursor } as P);
      yield answer;
      const next = answer.page.nextCursor;
      if (!answer.page.hasMore || next === null) return;
      if (next === cursor) throw new VestiarionError(200, "invalid_response", "The API answered the same cursor twice.");
      cursor = next;
    }
  }
  async function* listAll(params?: P): AsyncGenerator<T> {
    for await (const answer of pages(params)) yield* answer.data;
  }
  return { list, pages, listAll };
}

/**
 * A client for one workspace's `/api/v1` (docs/superpowers/specs/2026-10-03-typescript-sdk-design.md R4): one method
 * per operation, a resource's `data` returned as it is, and a collection paged by `list`, `pages` or `listAll`.
 */
export class Vestiarion {
  readonly status: { get(): Promise<Status> };
  readonly ledger: Collection<LedgerEntry, ListLedgerEntriesParams> & { verify(): Promise<LedgerVerification> };
  readonly invoices: Collection<Invoice, ListInvoicesParams> & { create(input: CreateInvoiceInput, options?: WriteOptions): Promise<Invoice> };
  readonly counterparties: Collection<Counterparty, ListCounterpartiesParams> & {
    get(id: string): Promise<CounterpartyDetail>;
    create(input: CreateCounterpartyInput, options?: WriteOptions): Promise<Counterparty>;
  };
  readonly milestones: Collection<Milestone, ListMilestonesParams>;
  readonly treasury: { get(): Promise<Treasury> };
  readonly insights: { get(): Promise<Insights> };

  constructor(options: VestiarionOptions) {
    if (typeof options?.apiKey !== "string" || !KEY_FORMAT.test(options.apiKey)) {
      throw new TypeError("apiKey must be a workspace API key, shaped vxk_<prefix>_<secret>.");
    }
    const fetchImpl = options.fetch ?? (typeof globalThis.fetch === "function" ? (globalThis.fetch.bind(globalThis) as FetchLike) : undefined);
    if (!fetchImpl) throw new TypeError("This runtime has no fetch: pass one as options.fetch.");
    const transport = createTransport({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      fetch: fetchImpl,
      maxRetries: options.maxRetries ?? 2,
      timeoutMs: options.timeoutMs ?? 30_000,
    });
    const one = <T>(path: string) => transport.request<{ data: T }>({ method: "GET", path }).then((answer) => answer.data);
    const add = <T>(path: string, body: unknown, write?: WriteOptions) =>
      transport.request<{ data: T }>({ method: "POST", path, body, idempotencyKey: write?.idempotencyKey }).then((answer) => answer.data);

    this.status = { get: () => one<Status>("/api/v1/status") };
    this.ledger = {
      ...collection<LedgerEntry, ListLedgerEntriesParams>(transport, "/api/v1/ledger"),
      verify: () => one<LedgerVerification>("/api/v1/ledger/verify"),
    };
    this.invoices = {
      ...collection<Invoice, ListInvoicesParams>(transport, "/api/v1/invoices"),
      create: (input, write) => add<Invoice>("/api/v1/invoices", input, write),
    };
    this.counterparties = {
      ...collection<Counterparty, ListCounterpartiesParams>(transport, "/api/v1/counterparties"),
      get: (id) => one<CounterpartyDetail>(`/api/v1/counterparties/${encodeURIComponent(id)}`),
      create: (input, write) => add<Counterparty>("/api/v1/counterparties", input, write),
    };
    this.milestones = collection<Milestone, ListMilestonesParams>(transport, "/api/v1/milestones");
    this.treasury = { get: () => one<Treasury>("/api/v1/treasury") };
    this.insights = { get: () => one<Insights>("/api/v1/insights") };
  }
}
```

- [ ] **Step 4: Write `sdk/src/index.ts`**

```ts
export { Vestiarion, DEFAULT_BASE_URL, type Collection, type List, type VestiarionOptions, type WriteOptions } from "./client.js";
export { VestiarionError, type VestiarionErrorCode } from "./errors.js";
export type { FetchLike } from "./http.js";
export * from "./types.js";
export { VERSION } from "./version.js";
```

- [ ] **Step 5: Run it:** `npx vitest run tests/sdk-client.test.ts tests/sdk-transport.test.ts`, then
  `npx tsc --noEmit -p sdk` and `npx tsc --noEmit -p .`. Expected: all pass, and both tsc runs clean.
- [ ] **Step 6: Commit:** "Add the SDK client: a method per operation, and pagination".

---

### Task 5: The SDK against the API's own routes

**Files:**
- Test: `tests/sdk-contract.test.ts`

**Interfaces:**
- Consumes: `Vestiarion`, `VestiarionError`, `FetchLike` and `Invoice` (Task 4), the v1 route handlers, `fakeSupabase`
  and `signedOrgs`.

- [ ] **Step 1: Write the test** (`tests/sdk-contract.test.ts`)

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getCounterparty } from "@/app/api/v1/counterparties/[id]/route";
import { GET as listCounterparties, POST as createCounterparty } from "@/app/api/v1/counterparties/route";
import { GET as getInsights } from "@/app/api/v1/insights/route";
import { GET as listInvoices, POST as createInvoice } from "@/app/api/v1/invoices/route";
import { GET as listLedger } from "@/app/api/v1/ledger/route";
import { GET as verifyLedger } from "@/app/api/v1/ledger/verify/route";
import { GET as listMilestones } from "@/app/api/v1/milestones/route";
import { GET as getStatus } from "@/app/api/v1/status/route";
import { GET as getTreasury } from "@/app/api/v1/treasury/route";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { authenticateApiKey, type AuthenticatedKey } from "@/lib/platform/api-keys";
import { Vestiarion, VestiarionError, type FetchLike, type Invoice } from "../sdk/src/index";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * The SDK against the API's own route handlers, run in this process: whatever the SDK sends, the routes read, and
 * whatever they answer, the SDK returns (TypeScript SDK design §4, "Contract").
 */

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: vi.fn(), raiseCycleEvent: vi.fn() }));
vi.mock("@/lib/platform/api-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/api-keys")>();
  return { ...actual, authenticateApiKey: vi.fn(), touchApiKeyUsed: vi.fn(async () => {}) };
});

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const ISSUER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a1";
const API_KEY = `vxk_abcdefgh_${"A".repeat(43)}`;
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
let keys = 0;
const key = (scopes: AuthenticatedKey["scopes"]): AuthenticatedKey => {
  keys += 1;
  return { keyId: `3c3c3c3c-0000-4000-8000-${String(keys).padStart(12, "0")}`, orgId: ORG, scopes, createdBy: ISSUER };
};

const ROUTES: Record<string, (request: Request) => Promise<Response>> = {
  "GET /api/v1/status": getStatus,
  "GET /api/v1/ledger": listLedger,
  "GET /api/v1/ledger/verify": verifyLedger,
  "GET /api/v1/invoices": listInvoices,
  "POST /api/v1/invoices": createInvoice,
  "GET /api/v1/counterparties": listCounterparties,
  "POST /api/v1/counterparties": createCounterparty,
  "GET /api/v1/milestones": listMilestones,
  "GET /api/v1/treasury": getTreasury,
  "GET /api/v1/insights": getInsights,
};

/** A fetch served by the app's own route handlers, in this process. */
const routeFetch: FetchLike = async (url, init) => {
  const { pathname } = new URL(url);
  const request = new Request(url, { method: init.method, headers: init.headers, body: init.body });
  const detail = /^\/api\/v1\/counterparties\/([^/]+)$/.exec(pathname);
  if (init.method === "GET" && detail) return getCounterparty(request, { params: Promise.resolve({ id: decodeURIComponent(detail[1]) }) });
  const route = ROUTES[`${init.method} ${pathname}`];
  return route ? route(request) : new Response(JSON.stringify({ error: { code: "not_found", message: "No such route." } }), { status: 404 });
};

const STORED = {
  id: INVOICE, direction: "payable", status: "pending", amount: "0.1", currency: "USDC", memo: null, po_reference: "PO-API-1", goods_received: true,
  due_date: "2026-10-03T12:00:00+00:00", scheduled_for: null, early_pay_discount_pct: null, discount_due_date: null, decided_at: null, settled_at: null,
  escalated_at: null, agent_reasoning: null, tx_ref: null, paid_amount: null, created_at: "2026-10-03T10:16:16Z",
  counterparties: { id: COUNTERPARTY, name: "API Test Vendor", risk_level: "clear" },
};

function workspace() {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/counterparties" && sent.params.get("id") === `eq.${COUNTERPARTY}`) return { body: [{ id: COUNTERPARTY, name: "API Test Vendor" }] };
    if (sent.path === "/rest/v1/invoices" && sent.method === "POST") return { body: { id: INVOICE } };
    if (sent.path === "/rest/v1/invoices" && sent.params.get("id") === `eq.${INVOICE}`) return { body: STORED };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    if (sent.path === "/rest/v1/api_idempotency" && sent.method === "POST") return { status: 201, body: [{ org_id: ORG }] };
    return { body: [] };
  });
  const sdk = new Vestiarion({ apiKey: API_KEY, baseUrl: "https://vestiarion.invalid", fetch: routeFetch, maxRetries: 0 });
  const run = <T>(call: (client: Vestiarion) => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => call(sdk));
  return { fake, run };
}

beforeEach(() => {
  vi.mocked(authenticateApiKey).mockReset();
  vi.mocked(authenticateApiKey).mockResolvedValue(key(["read"]));
});

describe("the SDK against the API's routes", () => {
  it("reads every collection and resource of an empty workspace", async () => {
    const { run } = workspace();
    const empty = { data: [], page: { nextCursor: null, hasMore: false, count: 0 } };
    expect(await run((sdk) => sdk.invoices.list())).toEqual(empty);
    expect(await run((sdk) => sdk.counterparties.list())).toEqual(empty);
    expect(await run((sdk) => sdk.milestones.list())).toEqual(empty);
    expect(await run((sdk) => sdk.ledger.list())).toEqual(empty);
    expect(await run((sdk) => sdk.status.get())).toMatchObject({ apiVersion: "v1" });
    for (const read of [(sdk: Vestiarion) => sdk.ledger.verify(), (sdk: Vestiarion) => sdk.treasury.get(), (sdk: Vestiarion) => sdk.insights.get()]) {
      await expect(run(read)).resolves.toBeTypeOf("object");
    }
  });

  it("sends a list's filters as the route reads them", async () => {
    const { fake, run } = workspace();
    await run((sdk) => sdk.invoices.list({ status: "held", limit: 5 }));
    const read = fake.requests.find((sent) => sent.path === "/rest/v1/invoices");
    expect(read?.params.get("status")).toBe("eq.held");
    expect(read?.params.get("limit")).toBe("6");
  });

  it("throws the route's 404 as a VestiarionError", async () => {
    const { run } = workspace();
    const error = await run((sdk) => sdk.counterparties.get("0b6c1c9e-4a4f-4a7e-9b1e-00000000ffff")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VestiarionError);
    expect(error).toMatchObject({ status: 404, code: "not_found" });
  });

  it("adds an invoice with a read-and-write key, sending the caller's Idempotency-Key, and returns it typed", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(key(["read", "write"]));
    const { fake, run } = workspace();
    const invoice: Invoice = await run((sdk) =>
      sdk.invoices.create({ counterpartyId: COUNTERPARTY, amount: "0.10", dueDate: "2026-10-03", poReference: "PO-API-1", goodsReceived: true }, { idempotencyKey: "billing-inv-1" })
    );
    expect(invoice).toMatchObject({ id: INVOICE, status: "pending", amount: 0.1, counterparty: { name: "API Test Vendor" } });
    const claim = fake.requests.find((sent) => sent.path === "/rest/v1/api_idempotency" && sent.method === "POST");
    expect(claim?.body).toMatchObject({ idempotency_key: "billing-inv-1" });
  });

  it("claims a fresh Idempotency-Key for a write the caller sent without one", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(key(["read", "write"]));
    const { fake, run } = workspace();
    await run((sdk) => sdk.invoices.create({ counterpartyId: COUNTERPARTY, amount: "0.10", dueDate: "2026-10-03" }));
    const claim = fake.requests.find((sent) => sent.path === "/rest/v1/api_idempotency" && sent.method === "POST");
    expect((claim?.body as { idempotency_key: string }).idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("throws a read-only key's write as forbidden, and writes nothing", async () => {
    const { fake, run } = workspace();
    const error = await run((sdk) => sdk.counterparties.create({ name: "API Test Vendor", role: "client" })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 403, code: "forbidden" });
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/counterparties")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it:** `npx vitest run tests/sdk-contract.test.ts`. Expected: PASS. This task adds no production
  code, so a failure here means Tasks 3–4 do not match the routes: fix the SDK, never the test's expectations.
- [ ] **Step 3: Commit:** "Hold the SDK to the API's own routes".

---

### Task 6: Webhooks and ledger entries

**Files:**
- Create: `sdk/src/canonical-json.ts`, `sdk/src/webhooks.ts`
- Modify: `sdk/src/index.ts` (export the webhook API)
- Test: `tests/sdk-webhooks.test.ts`

**Interfaces:**
- Consumes: `LedgerEntry` (Task 2).
- Produces:
  - `verifyWebhook(input: { secret: string; payload: string; signature: string | null | undefined; toleranceSeconds?: number; now?: Date }): Promise<WebhookEvent>`;
  - `verifyLedgerEntry(entry: WebhookLedgerEntry, keys: string | Record<string, string>): Promise<EntryCheck>`;
  - `class WebhookVerificationError extends Error { reason: "missing" | "malformed" | "expired" | "mismatch" }`;
  - the types `WebhookEvent`, `WebhookLedgerEntry = Omit<LedgerEntry, "id">` and
    `EntryCheck = { ok: true } | { ok: false; reason: string } | { ok: null; reason: string }`;
  - `WEBHOOK_TOLERANCE_SECONDS = 300`.

- [ ] **Step 1: Write the failing test** (`tests/sdk-webhooks.test.ts`)

```ts
import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@/lib/canonical-json";
import { bodyHashOf } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { verifyEntry, type PublicLedgerRow } from "@/lib/receipts/verify";
import { signWebhook, verifyWebhookSignature } from "@/lib/webhooks/sign";
import { canonicalJson as sdkCanonicalJson } from "../sdk/src/canonical-json";
import { verifyLedgerEntry, verifyWebhook, WebhookVerificationError, type WebhookLedgerEntry } from "../sdk/src/webhooks";

/**
 * Webhook signatures and ledger entries, checked by the SDK exactly as the server signs them (TypeScript SDK design
 * R7): HMAC deliveries against src/lib/webhooks/sign.ts, entries against src/lib/ledger.ts, agreeing with the receipt
 * page's own verifier.
 */

vi.mock("server-only", () => ({}));

const SECRET = `whsec_${"s".repeat(43)}`;
const T = 1_790_000_000;
const at = (seconds: number) => new Date(seconds * 1000);
const BODY = JSON.stringify({ id: "3fa1e2b0", type: "ledger.appended", createdAt: "2026-10-03T11:09:31Z", workspace: { slug: "testnet-2" }, entry: { seq: 1137 } });
const reasonOf = (promise: Promise<unknown>) => promise.then(() => "verified", (error: unknown) => (error instanceof WebhookVerificationError ? error.reason : `threw ${String(error)}`));

describe("verifyWebhook", () => {
  it("returns the event a genuine delivery carries", async () => {
    const event = await verifyWebhook({ secret: SECRET, payload: BODY, signature: signWebhook(SECRET, BODY, T), now: at(T) });
    expect(event).toEqual(JSON.parse(BODY));
  });

  it.each([
    ["a tampered body", () => ({ payload: BODY.replace("1137", "1138"), signature: signWebhook(SECRET, BODY, T) }), "mismatch"],
    ["another secret", () => ({ payload: BODY, signature: signWebhook(`whsec_${"x".repeat(43)}`, BODY, T) }), "mismatch"],
    ["no header", () => ({ payload: BODY, signature: null }), "missing"],
    ["no v1", () => ({ payload: BODY, signature: `t=${T}` }), "malformed"],
    ["a v1 that is not hex", () => ({ payload: BODY, signature: `t=${T},v1=zz` }), "malformed"],
    ["two timestamps", () => ({ payload: BODY, signature: `${signWebhook(SECRET, BODY, T)},t=${T}` }), "malformed"],
    ["garbage", () => ({ payload: BODY, signature: "garbage" }), "malformed"],
  ])("refuses %s", async (_label, make, reason) => {
    expect(await reasonOf(verifyWebhook({ secret: SECRET, now: at(T), ...make() }))).toBe(reason);
  });

  it("accepts a signature exactly 300 s away and refuses one 301 s away, as the server does (Review focus 5)", async () => {
    const signature = signWebhook(SECRET, BODY, T);
    expect(await reasonOf(verifyWebhook({ secret: SECRET, payload: BODY, signature, now: at(T + 300) }))).toBe("verified");
    expect(await reasonOf(verifyWebhook({ secret: SECRET, payload: BODY, signature, now: at(T + 301) }))).toBe("expired");
    expect(await reasonOf(verifyWebhook({ secret: SECRET, payload: BODY, signature, now: at(T - 301) }))).toBe("expired");
  });

  it("accepts any one of several v1 values, and ignores other schemes", async () => {
    const genuine = signWebhook(SECRET, BODY, T).split(",")[1];
    const signature = `t=${T},v0=abc,v1=${"0".repeat(64)},${genuine}`;
    expect(await reasonOf(verifyWebhook({ secret: SECRET, payload: BODY, signature, now: at(T) }))).toBe("verified");
  });

  it("refuses a parsed object handed in as the payload, asking for the raw body (Review focus 4)", async () => {
    const parsed = JSON.parse(BODY) as unknown as string;
    const error = await verifyWebhook({ secret: SECRET, payload: parsed, signature: signWebhook(SECRET, BODY, T), now: at(T) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WebhookVerificationError);
    expect(error).toMatchObject({ reason: "malformed", message: expect.stringMatching(/raw request body/) });
  });

  it("refuses a genuinely signed body that is not JSON", async () => {
    expect(await reasonOf(verifyWebhook({ secret: SECRET, payload: "not json", signature: signWebhook(SECRET, "not json", T), now: at(T) }))).toBe("malformed");
  });

  it.each([
    signWebhook(SECRET, BODY, T),
    signWebhook(SECRET, BODY, T - 400),
    `t=${T},v1=${"0".repeat(64)}`,
    `t=${T}`,
    "t=,v1=",
    `v1=${"0".repeat(64)},t=${T}`,
  ])("agrees with the server's own check on %s", async (signature) => {
    const server = verifyWebhookSignature(SECRET, BODY, signature, T);
    expect((await reasonOf(verifyWebhook({ secret: SECRET, payload: BODY, signature, now: at(T) }))) === "verified").toBe(server);
  });
});

/** An entry signed exactly as src/lib/ledger.ts signs one, and the chain hash the database links it with. */
function signedEntry(detail: Record<string, unknown> = { invoiceId: "1f96fd0b", amount: 0.1, nested: { b: 1, a: [true, null, "x"] } }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const body = { actor: "agent" as const, domain: "ap" as const, action: "ap_pay", summary: "PAY invoice from API Test Vendor for 0.1 USDC", detail };
  const bodyHash = bodyHashOf(body);
  const signature = crypto.sign(null, Buffer.from(bodyHash, "hex"), privateKey).toString("hex");
  const prevHash = "0".repeat(64);
  const hash = crypto.createHash("sha256").update(prevHash + bodyHash + signature).digest("hex");
  const entry: WebhookLedgerEntry = { seq: 1137, ts: "2026-10-03T11:09:31Z", ...body, bodyHash, prevHash, hash, signature, signingKeyId: ledgerKeyId(privateKey) };
  return { entry, pem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

const asRow = (entry: WebhookLedgerEntry): PublicLedgerRow => ({
  seq: entry.seq, actor: entry.actor, domain: entry.domain, action: entry.action, summary: entry.summary, detail: entry.detail as Record<string, unknown>,
  body_hash: entry.bodyHash, signature: entry.signature, prev_hash: entry.prevHash, hash: entry.hash, signing_key_id: entry.signingKeyId,
});

describe("verifyLedgerEntry", () => {
  it("writes canonical JSON exactly as the ledger does", () => {
    for (const value of [{ b: 1, a: [true, null, { d: "é", c: 0.1 }] }, [], "x", null, 12.5, { u: undefined, k: 1 }]) {
      expect(sdkCanonicalJson(value)).toBe(canonicalJson(value));
    }
  });

  it("verifies an entry signed as the ledger signs, with its PEM or with a map of key id to PEM", async () => {
    const { entry, pem } = signedEntry();
    expect(await verifyLedgerEntry(entry, pem)).toEqual({ ok: true });
    expect(await verifyLedgerEntry(entry, { [entry.signingKeyId as string]: pem })).toEqual({ ok: true });
  });

  it("checks an entry with no key id against every genuine key given", async () => {
    const { entry, pem } = signedEntry();
    expect(await verifyLedgerEntry({ ...entry, signingKeyId: null }, pem)).toEqual({ ok: true });
  });

  it("refuses a tampered detail and a broken chain hash, and has no verdict without the signing key", async () => {
    const { entry, pem } = signedEntry();
    const other = signedEntry();
    expect(await verifyLedgerEntry({ ...entry, detail: { ...entry.detail, amount: 1000 } }, pem)).toMatchObject({ ok: false, reason: expect.stringMatching(/body hash/) });
    expect(await verifyLedgerEntry({ ...entry, hash: "f".repeat(64) }, pem)).toMatchObject({ ok: false, reason: expect.stringMatching(/chain hash/) });
    expect(await verifyLedgerEntry(entry, other.pem)).toMatchObject({ ok: null });
    // A key filed under an id that is not its own is not used.
    expect(await verifyLedgerEntry(entry, { [entry.signingKeyId as string]: other.pem })).toMatchObject({ ok: null });
  });

  it("refuses a signature by another key when the entry names no key", async () => {
    const { entry } = signedEntry();
    const other = signedEntry();
    expect(await verifyLedgerEntry({ ...entry, signingKeyId: null }, other.pem)).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
  });

  it("agrees with the receipt page's verifier on every case", async () => {
    const { entry, pem } = signedEntry();
    const other = signedEntry();
    const cases: Array<[WebhookLedgerEntry, Record<string, string>]> = [
      [entry, { [entry.signingKeyId as string]: pem }],
      [{ ...entry, detail: { tampered: true } }, { [entry.signingKeyId as string]: pem }],
      [{ ...entry, hash: "f".repeat(64) }, { [entry.signingKeyId as string]: pem }],
      [entry, { [other.entry.signingKeyId as string]: other.pem }],
      [{ ...entry, signingKeyId: null }, { [other.entry.signingKeyId as string]: other.pem }],
    ];
    for (const [checked, keys] of cases) {
      expect(await verifyLedgerEntry(checked, keys)).toEqual(await verifyEntry(asRow(checked), keys));
    }
  });
});
```

- [ ] **Step 2: Run it:** `npx vitest run tests/sdk-webhooks.test.ts`. Expected: FAIL, because
  `../sdk/src/canonical-json` is not found.

- [ ] **Step 3: Write `sdk/src/canonical-json.ts`**

```ts
/**
 * The ledger's canonical JSON: keys sorted at every level, `undefined` left out, nothing else changed. An entry's
 * `bodyHash` is SHA-256 of this over `{ actor, domain, action, summary, detail }`. tests/sdk-webhooks.test.ts holds it
 * to the server's own (src/lib/canonical-json.ts).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}
```

- [ ] **Step 4: Write `sdk/src/webhooks.ts`**

```ts
import { canonicalJson } from "./canonical-json.js";
import type { LedgerEntry } from "./types.js";

/**
 * Checking what Vestiarion sends (docs/superpowers/specs/2026-10-03-typescript-sdk-design.md R7), with Web Crypto
 * alone:
 * - a webhook delivery's `Vestiarion-Signature`, as src/lib/webhooks/sign.ts signs it;
 * - a ledger entry's own Ed25519 signature and chain hash, as the receipt page checks them
 *   (src/lib/receipts/verify.ts).
 */

/** How far a delivery's timestamp may be from now, in seconds, as the server's own check allows. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** A ledger entry as a delivery carries it: `GET /api/v1/ledger`'s fields, without the row `id`. */
export type WebhookLedgerEntry = Omit<LedgerEntry, "id">;

export interface WebhookEvent {
  /** The delivery's id, the same on every retry of it: de-duplicate on it. */
  id: string;
  type: "ledger.appended" | "webhook.test";
  createdAt: string;
  workspace: { slug: string };
  /** The entry appended. `ledger.appended` only. */
  entry?: WebhookLedgerEntry;
}

export type WebhookVerificationReason = "missing" | "malformed" | "expired" | "mismatch";

export class WebhookVerificationError extends Error {
  readonly name = "WebhookVerificationError";

  constructor(
    readonly reason: WebhookVerificationReason,
    message: string
  ) {
    super(message);
  }
}

/** `ok: null` is not a failure: no key known here could check the entry. */
export type EntryCheck = { ok: true } | { ok: false; reason: string } | { ok: null; reason: string };

const TIMESTAMP = /^\d{1,15}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(hex) ? hex : "";
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await subtle().digest("SHA-256", data)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const binary = atob(pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The event a delivery carries, once its `Vestiarion-Signature` proves Vestiarion sent this exact body, within
 * `toleranceSeconds` of `now`. Pass the raw request body as it arrived: a re-serialized copy differs byte for byte.
 * Throws a `WebhookVerificationError` otherwise; nothing is parsed before the signature checks out.
 */
export async function verifyWebhook(input: {
  secret: string;
  payload: string;
  signature: string | null | undefined;
  toleranceSeconds?: number;
  now?: Date;
}): Promise<WebhookEvent> {
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (typeof input.payload !== "string") {
    throw new WebhookVerificationError("malformed", "payload must be the raw request body as a string, not a parsed object.");
  }
  if (!input.signature) throw new WebhookVerificationError("missing", "The delivery has no Vestiarion-Signature header.");

  let t: number | null = null;
  const candidates: string[] = [];
  for (const part of input.signature.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) throw new WebhookVerificationError("malformed", "Vestiarion-Signature is not t=<seconds>,v1=<hex>.");
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (name === "t") {
      if (t !== null || !TIMESTAMP.test(value)) throw new WebhookVerificationError("malformed", "Vestiarion-Signature's timestamp is not valid.");
      t = Number(value);
    } else if (name === "v1") {
      if (!HEX_SHA256.test(value)) throw new WebhookVerificationError("malformed", "Vestiarion-Signature's v1 is not a hex HMAC-SHA256.");
      candidates.push(value);
    }
  }
  if (t === null || candidates.length === 0) throw new WebhookVerificationError("malformed", "Vestiarion-Signature needs a t and a v1.");
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - t) > tolerance) throw new WebhookVerificationError("expired", `The delivery was signed more than ${tolerance} s from now.`);

  const key = await subtle().importKey("raw", utf8(input.secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signed = utf8(`${t}.${input.payload}`);
  let match = false;
  for (const candidate of candidates) {
    // Every candidate is checked, so the time taken does not tell which one matched.
    if (await subtle().verify("HMAC", key, hexToBytes(candidate), signed)) match = true;
  }
  if (!match) throw new WebhookVerificationError("mismatch", "The signature does not match this body and secret.");

  let event: unknown;
  try {
    event = JSON.parse(input.payload);
  } catch {
    throw new WebhookVerificationError("malformed", "The delivery's body is not JSON.");
  }
  if (typeof event !== "object" || event === null || typeof (event as { type?: unknown }).type !== "string") {
    throw new WebhookVerificationError("malformed", "The delivery's body is not a Vestiarion event.");
  }
  return event as WebhookEvent;
}

/** The keys an entry may be checked against: each filed under its true id, and only the one the entry names, if it names one. */
async function candidateKeys(entry: WebhookLedgerEntry, keys: string | Record<string, string>): Promise<Uint8Array<ArrayBuffer>[]> {
  const pems = typeof keys === "string" ? [[null, keys] as const] : Object.entries(keys);
  const filed = await Promise.all(
    pems.map(async ([id, pem]) => {
      const der = pemToDer(pem);
      const trueId = (await sha256Hex(der)).slice(0, 16);
      return { der, trueId, genuine: id === null || id === trueId };
    })
  );
  const genuine = filed.filter((key) => key.genuine);
  return (entry.signingKeyId ? genuine.filter((key) => key.trueId === entry.signingKeyId) : genuine).map((key) => key.der);
}

/**
 * Whether a ledger entry is authentic, as the receipt page checks one:
 * - its content matches `bodyHash`, SHA-256 of the canonical JSON of `{ actor, domain, action, summary, detail }`;
 * - `signature` is the workspace key's Ed25519 signature over the 32 bytes of `bodyHash`;
 * - `hash` is SHA-256 of `prevHash + bodyHash + signature`.
 *
 * `keys` is the PEM from the workspace's Audit page, or a map of key id to PEM. A key counts only under its true id, the
 * first 16 hex characters of SHA-256 of its SPKI encoding.
 */
export async function verifyLedgerEntry(entry: WebhookLedgerEntry, keys: string | Record<string, string>): Promise<EntryCheck> {
  const body = canonicalJson({ actor: entry.actor, domain: entry.domain, action: entry.action, summary: entry.summary, detail: entry.detail });
  if ((await sha256Hex(utf8(body))) !== entry.bodyHash) return { ok: false, reason: "The entry's content does not match its body hash." };

  const candidates = await candidateKeys(entry, keys);
  if (candidates.length === 0) return { ok: null, reason: "The key that signed this entry is not known here." };
  let signed = false;
  try {
    for (const der of candidates) {
      const key = await subtle().importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
      if (await subtle().verify({ name: "Ed25519" }, key, hexToBytes(entry.signature), hexToBytes(entry.bodyHash))) {
        signed = true;
        break;
      }
    }
  } catch {
    return { ok: null, reason: "The Ed25519 signature could not be checked here." };
  }
  if (!signed) return { ok: false, reason: "The signature does not verify with the workspace's key." };

  if ((await sha256Hex(utf8(entry.prevHash + entry.bodyHash + entry.signature))) !== entry.hash) {
    return { ok: false, reason: "The entry's chain hash does not match." };
  }
  return { ok: true };
}
```

- [ ] **Step 5: Export them**: `sdk/src/index.ts` gains:

```ts
export {
  verifyLedgerEntry,
  verifyWebhook,
  WEBHOOK_TOLERANCE_SECONDS,
  WebhookVerificationError,
  type EntryCheck,
  type WebhookEvent,
  type WebhookLedgerEntry,
  type WebhookVerificationReason,
} from "./webhooks.js";
```

- [ ] **Step 6: Run it:** `npx vitest run tests/sdk-webhooks.test.ts`, then `npx tsc --noEmit -p sdk` and
  `npx tsc --noEmit -p .`. Expected: all pass, and clean.

  If `receipts/verify.ts`'s `verifyEntry` answers `ok:null` where the SDK answers `ok:false` for "another key, no
  `signingKeyId`", that is a real difference: rule on it in the ledger, keeping the receipt verifier's behavior.

- [ ] **Step 7: Commit:** "Verify webhook deliveries and ledger entries in the SDK".

---

### Task 7: The package, its README, and the tarball the site serves

**Files:**
- Create: `scripts/sdk-pack.ts`, `sdk/README.md`, `public/sdk/vestiarion-sdk-0.1.0.tgz` (generated, committed)
- Modify: `package.json` (script `"sdk:pack": "tsx scripts/sdk-pack.ts"`), `next.config.ts` (`/sdk/:path*` headers),
  `.gitattributes` (`*.tgz binary`)
- Test: `tests/sdk-package.test.ts` (extend)

**Interfaces:**
- Consumes: `sdk/tsconfig.json` (Task 1) and every `sdk/src` file.

- [ ] **Step 1: Write the failing test.** Append to `tests/sdk-package.test.ts`, extending its imports with
  `import path from "node:path"`, `import { gunzipSync } from "node:zlib"`, `import ts from "typescript"` and
  `import nextConfig from "../next.config"`:

```ts
/** The files in a .tgz, by path. A tar file is 512-byte headers, each followed by its file padded to 512 bytes. */
function untar(tgz: Buffer): Map<string, string> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, string>();
  const field = (from: number, to: number, header: Buffer) => header.subarray(from, to).toString("utf8").replace(/\0[\s\S]*$/, "");
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = field(0, 100, header);
    if (!name) break;
    const prefix = field(345, 500, header);
    const size = parseInt(field(124, 136, header).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    if (type === "0") files.set(prefix ? `${prefix}/${name}` : name, tar.subarray(offset + 512, offset + 512 + size).toString("utf8"));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** What `tsc -p sdk` emits, by path under sdk/, built in memory. */
function buildSdk(): Map<string, string> {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.resolve("sdk/tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (!parsed) throw new Error("sdk/tsconfig.json could not be read");
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const out = new Map<string, string>();
  const emitted = program.emit(undefined, (fileName, text) => out.set(path.relative(path.resolve("sdk"), fileName).replaceAll("\\", "/"), text));
  const problems = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
  if (problems.length > 0) throw new Error(ts.formatDiagnostics(problems, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }));
  return out;
}

const lf = (text: string | undefined) => text?.replace(/\r\n/g, "\n");

describe("the tarball the site serves", () => {
  it("holds, for this version, exactly what sdk/ builds, its package.json, README and licence: run npm run sdk:pack", () => {
    const files = untar(readFileSync(`public/sdk/vestiarion-sdk-${pkg.version}.tgz`));
    const expected = new Map([...buildSdk()].map(([file, text]) => [`package/${file}`, text]));
    expected.set("package/README.md", readFileSync("sdk/README.md", "utf8"));
    expected.set("package/LICENSE", readFileSync("sdk/LICENSE", "utf8"));
    expect([...files.keys()].sort()).toEqual([...expected.keys(), "package/package.json"].sort());
    for (const [file, text] of expected) expect(lf(files.get(file)), file).toBe(lf(text));
    expect(JSON.parse(files.get("package/package.json") as string)).toEqual(pkg);
  });

  it("exports the root and ./webhooks, both built", () => {
    const built = buildSdk();
    for (const file of ["dist/index.js", "dist/index.d.ts", "dist/webhooks.js", "dist/webhooks.d.ts"]) expect(built.has(file), file).toBe(true);
  });

  it("is served as a download, not sniffed by the browser", async () => {
    expect(await nextConfig.headers!()).toContainEqual({
      source: "/sdk/:path*",
      headers: [
        { key: "Content-Disposition", value: "attachment" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    });
  });
});
```

- [ ] **Step 2: Run it:** `npx vitest run tests/sdk-package.test.ts`. Expected: FAIL. There is no
  `public/sdk/vestiarion-sdk-0.1.0.tgz`, and there are no `/sdk/:path*` headers.

- [ ] **Step 3: Write `scripts/sdk-pack.ts`**

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Builds the TypeScript SDK and packs it into public/sdk/vestiarion-sdk-<version>.tgz, the tarball
 * https://www.vestiarion.xyz/sdk/ serves (TypeScript SDK design R2). Run after changing sdk/ and its version:
 *
 *   npm run sdk:pack
 *
 * A version already packed is never packed again: its URL may sit in someone's lockfile, with the hash of its bytes.
 * tests/sdk-package.test.ts fails while the committed tarball is not what sdk/ builds.
 */
const root = path.resolve(import.meta.dirname, "..");
const sdk = path.join(root, "sdk");
const { version } = JSON.parse(readFileSync(path.join(sdk, "package.json"), "utf8")) as { version: string };
const destination = path.join(root, "public", "sdk");
const tarball = path.join(destination, `vestiarion-sdk-${version}.tgz`);
if (existsSync(tarball)) {
  console.error(`${path.relative(root, tarball)} exists. Bump sdk/package.json's version (and VERSION) to pack another.`);
  process.exit(1);
}
rmSync(path.join(sdk, "dist"), { recursive: true, force: true });
execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(sdk, "tsconfig.json")], { stdio: "inherit" });
mkdirSync(destination, { recursive: true });
execFileSync("npm", ["pack", sdk, "--pack-destination", destination], { stdio: "inherit", shell: process.platform === "win32" });
console.log(`wrote ${path.relative(root, tarball)}`);
```

`package.json` scripts gain `"sdk:pack": "tsx scripts/sdk-pack.ts"`. `.gitattributes` gains `*.tgz binary`.
`next.config.ts` `headers()` gains, after `/tools/:path*`:

```ts
      {
        // The SDK's tarballs (TypeScript SDK design R2): fetched by npm, downloaded by a person, never run in a tab.
        source: "/sdk/:path*",
        headers: [
          { key: "Content-Disposition", value: "attachment" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
```

- [ ] **Step 4: Write `sdk/README.md`.** It covers:
  - the install command with the tarball URL;
  - a client;
  - reads, `listAll` and `pages`;
  - a write with `idempotencyKey`;
  - errors and retries;
  - `verifyWebhook` in a route handler;
  - `verifyLedgerEntry`;
  - runtimes and the MIT licence.

  Every method it names exists on `Vestiarion`; Task 8's docs test checks the same for the docs page. Its text is
  the docs page's, shortened, with the docs link for the rest.

- [ ] **Step 5: Pack:** `npm run sdk:pack`. Expected: "wrote public/sdk/vestiarion-sdk-0.1.0.tgz".
- [ ] **Step 6: Run it:** `npx vitest run tests/sdk-package.test.ts tests/docs-markdown.test.ts`. Expected: all pass.
- [ ] **Step 7: Commit:** "Pack the SDK into a tarball the site serves". The commit includes the `.tgz`.

---

### Task 8: Docs

**Files:**
- Create: `content/docs/get-started/sdk.mdx`
- Modify:
  - `src/lib/docs/nav.ts` (page after Quickstart) and `src/lib/docs/content.ts` (loader);
  - `content/docs/get-started/quickstart.mdx` (a pointer), `content/docs/api.mdx` (a pointer);
  - `content/docs/changelog.mdx` (an entry), `README.md`, `ARCHITECTURE.md`;
  - nav tests that pin the Get started list, if any (`tests/docs-content.test.ts`).
- Test: `tests/sdk-docs.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/sdk-docs.test.ts`)

```ts
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
```

- [ ] **Step 2: Run it:** `npx vitest run tests/sdk-docs.test.ts`. Expected: FAIL for the docs page. There is no
  `get-started/sdk` source yet. The README cases pass.

- [ ] **Step 3: Write `content/docs/get-started/sdk.mdx`**, a "TypeScript SDK" page with these sections:
  - **Install:** npm, pnpm, Yarn and Bun, each with the URL;
  - **Create a client:** with the key from an environment variable;
  - **Read:** `vestiarion.status.get()`, `vestiarion.invoices.list({ status: "held" })` and
    `vestiarion.counterparties.get(id)`;
  - **Every page:** `vestiarion.invoices.listAll(...)`, and `vestiarion.ledger.pages({ cursor })` storing the cursor;
  - **Add records:**
    - `vestiarion.counterparties.create(...)` and `vestiarion.invoices.create(..., { idempotencyKey })`;
    - the key needs write access;
    - an address waits for a person to confirm it;
  - **Errors and retries:**
    - the `VestiarionError` fields;
    - what is retried, and the 60 s `Retry-After` cap;
    - why a write is never added twice;
  - **Webhooks:**
    - `verifyWebhook` in a Next.js route handler with `await request.text()`;
    - `verifyLedgerEntry` with the PEM from the Audit page;
  - **Runtimes:** Node 20 or later, Deno, Bun, Workers, ESM only.

  Every code block uses `vestiarion` as the client's name, so the test checks it. Link the reference pages, Pagination,
  Errors, Authentication#scopes and Verifying signatures.

  Register the page:
  - `src/lib/docs/nav.ts`, after `get-started/quickstart`: `{ slug: "get-started/sdk", title: "TypeScript SDK",
    description: "A typed client for the API and its webhooks: every page, safe retries and signature checks." }`;
  - `src/lib/docs/content.ts` gains a loader, `"get-started/sdk": () => import("../../../content/docs/get-started/sdk.mdx")`;
  - update any nav-order test that pins Get started.

- [ ] **Step 4: Point to it, and record it**
  - `quickstart.mdx`: one sentence near the top, "Writing TypeScript? The [TypeScript SDK](/docs/get-started/sdk)
    wraps these requests.".
  - `api.mdx`: one sentence after the first paragraph.
  - `changelog.mdx`: a dated entry at the top, "2026-10-03: A TypeScript SDK", listing the install URL, what it
    covers, retries and idempotency, and webhook verification.
  - `README.md` (API section): one paragraph.
  - `ARCHITECTURE.md` "Developer docs": one paragraph. It covers `sdk/`, `npm run sdk:types` with its drift test, and
    `npm run sdk:pack` with the committed, immutable tarball and its test.

- [ ] **Step 5: Run the docs tests:**
  `npx vitest run tests/sdk-docs.test.ts tests/docs-content.test.ts tests/docs-markdown.test.ts tests/docs-search.test.ts tests/docs-headings.test.ts tests/docs-rendering.test.tsx`.
  Expected: all pass.
- [ ] **Step 6: Commit:** "Document the TypeScript SDK".

---

### Task 9: Verify, review, PR

- [ ] **Step 1:** `npm run verify` (lockfile, types, lint, the full suite). Expected: green.
- [ ] **Step 2:** `npx next build`. Expected: compiles. Then check in a browser on `next start` that:
  - `/sdk/vestiarion-sdk-0.1.0.tgz` downloads;
  - `/docs/get-started/sdk` renders.
- [ ] **Step 3:** Install the tarball into a scratch folder outside the repo:
  `npm install <path>/public/sdk/vestiarion-sdk-0.1.0.tgz`. Then run a Node ESM script that imports `Vestiarion`,
  `verifyWebhook` and `@vestiarion/sdk/webhooks`, constructs a client with a fake `fetch`, and calls
  `status.get()`.
- [ ] **Step 4:** Do the final review against the Review Focus. Fix Critical and Important findings with failing
  tests first. If `sdk/src` changes, delete the 0.1.0 tarball and re-pack it, since nothing is released before merge.
- [ ] **Step 5:** Push `feat/ts-sdk` and open a PR with the summary, the rulings and the test results.
