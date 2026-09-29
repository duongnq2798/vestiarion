# Developer Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public documentation site at `/docs`, at the level of docs.coingecko.com. It covers the overview, get started, a generated API reference with "Try it", webhooks, AI integration and a changelog, and it rests on an OpenAPI 3.1 document that tests keep in step with the routes.

**Architecture:**
- Zod schemas mirror the v1 payload interfaces, and a type test locks the two together. They build `/api/v1/openapi.json`.
- The reference pages, code samples, the Markdown views and `llms.txt` are all generated from that document or from the MDX content under `content/docs/`.
- MDX runs through `@next/mdx`, with a server-side shiki highlighter in the `pre` component. There are no remark or rehype plugins, so Turbopack's serialisation limit does not apply.

**Tech Stack:**
- Next.js 16.3.6 (App Router), React 19.2 and Tailwind 4;
- Zod 4 (`z.toJSONSchema`);
- `@next/mdx`, `@mdx-js/loader`, `@mdx-js/react`, `@types/mdx` and `shiki`;
- Vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-developer-docs-design.md` (D1–D12)

## Global Constraints

- **Next.js.** Read `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`). For MDX, read `01-app/02-guides/mdx.md` and `01-app/03-api-reference/03-file-conventions/mdx-components.md` first.
- **Dependencies.** The only new ones are `@next/mdx`, `@mdx-js/loader`, `@mdx-js/react`, `@types/mdx` and `shiki` (D1).
  - Install them with `npm install` so that `package-lock.json` updates.
  - `npm run verify` includes `check:lock` and must stay green.
- **UI.** Use the primitives in `src/components/ui/` (`Command*`, `Sheet*`, `Tabs*`, `CopyButton`, `Callout`, `Table*`, `Badge`, `Button`, `Input`).
  - No raw controls or colour literals outside that folder. Use the tokens (`text-ink`, `text-ink-2`, `bg-raised` and so on).
  - There is one light theme and no dark mode (D10). Code blocks are dark panels.
- **Layout.** No horizontal page scroll at 360 px. Code blocks and tables scroll inside their own box.
  - Three columns at ≥ 1280 px. Below that, the sidebar opens in a `Sheet`.
- **Public.** `/docs/**`, `/api/v1/openapi.json`, `/llms.txt` and `/llms-full.txt` need no login and no key.
- **The key in "Try it"** lives only in React state. It never goes to `localStorage`, `sessionStorage`, a cookie, a URL or a log. It is sent only as `Authorization: Bearer …` to a same-origin `/api/v1/…` path.
- **Examples** are real responses, taken from the JSON blocks in `docs/api.md`, which were captured from the running application. Never invent values.
- **Copy.** Describe only what is built: no plan numbers, no "hackathon", "judges" or "competition", and never the word "powerful". There is no WebSocket, and the site says so (D7). There is no rate limit per key, and the site says so (D11).
- **Commits.** A neutral subject, then a blank line, then the Co-Authored-By trailer your harness mandates.
  - Check `git branch --show-current` is `feat/developer-docs` before every commit.
  - `npm run verify` must be green at every commit.

## Review Focus

1. **Narrow viewports (360 px and ~520 px) with long content.** A long curl line, a wide parameter table or a long cursor string must scroll inside its own box, never widen the page. Task 2 adds the `overflow-x-auto` wrapper test, and the browser check covers it.
2. **A pasted key with whitespace.** A key pasted with a trailing newline or spaces is trimmed before sending. An empty or whitespace-only key sends no `Authorization` header at all. Task 4 tests both.
3. **Repeated headings on one page.** Two "Example" headings on one page get unique anchors (`example` and `example-2`), and the table of contents links both. Task 2 tests `slugifyHeadings`.
4. **Null-valued fields.** A route response where every nullable field is `null` still parses against its schema. Task 1 drives the routes with rows whose nullable columns are null.
5. **Search shortcut while typing.** Ctrl/⌘ K opens search, but typing a plain "k" in an input (the "Try it" parameter fields) never opens it. Task 5 tests the key handler.

---

### Task 1: Zod schemas, the OpenAPI document and `/api/v1/openapi.json`

**Files:**
- Create: `src/lib/api/schemas.ts`, `src/lib/api/openapi.ts`, `src/app/api/v1/openapi.json/route.ts`, `content/docs/examples/*.json` (one per operation)
- Test: `tests/api-schemas.test.ts`, `tests/openapi.test.ts`

**Interfaces:**
- **Produces**, from `src/lib/api/openapi.ts`:
  - `export interface DocOperation { id: string; method: "get"; path: string; summary: string; description: string; tag: "Workspace" | "Ledger" | "Payables and receivables" | "Counterparties" | "Milestones" | "Treasury" | "Insights"; params: DocParam[]; response: z.ZodType; collection: boolean; errors: ApiErrorCode[]; example: unknown }`
  - `export interface DocParam { name: string; in: "query" | "path"; required: boolean; type: "string" | "integer"; description: string; enum?: readonly string[]; default?: string | number; minimum?: number; maximum?: number; example?: string | number }`
  - `export const OPERATIONS: readonly DocOperation[]`
  - `export function buildOpenApiDocument(origin: string): Record<string, unknown>`
  - `export function operationById(id: string): DocOperation | undefined`
- **Produces**, from `src/lib/api/schemas.ts`: one Zod schema per payload, named `<Name>Schema`, plus `ApiErrorSchema`, `ApiPageSchema`, `collectionOf(item)` and `resourceOf(item)`.

**Operation ids** (exact, used for the URLs `/docs/api/<id>`):

| id | path | response schema |
|---|---|---|
| `get-status` | `/api/v1/status` | `resourceOf(StatusSchema)` |
| `list-ledger-entries` | `/api/v1/ledger` | `collectionOf(LedgerEntrySchema)` |
| `verify-ledger` | `/api/v1/ledger/verify` | `resourceOf(VerificationResultSchema)` |
| `list-invoices` | `/api/v1/invoices` | `collectionOf(InvoiceSchema)` |
| `list-counterparties` | `/api/v1/counterparties` | `collectionOf(CounterpartySchema)` |
| `get-counterparty` | `/api/v1/counterparties/{id}` | `resourceOf(CounterpartyDetailSchema)` |
| `list-milestones` | `/api/v1/milestones` | `collectionOf(MilestoneSchema)` |
| `get-treasury` | `/api/v1/treasury` | `resourceOf(TreasurySchema)` |
| `get-insights` | `/api/v1/insights` | `resourceOf(InsightsSchema)` |

**Parameters.** Read each route file for the exact parameters, enums, messages and defaults; the route code is the authority. For example:
- the collections take `limit` (integer, 1–200, default 50) and `cursor`;
- `invoices` also takes `direction`, `status` and `counterpartyId`;
- `ledger` takes `domain` and `actor`;
- `counterparties` takes `role` and `riskLevel`, whose enums come from `COUNTERPARTY_ROLES` and `COUNTERPARTY_RISK_LEVELS`;
- `milestones` takes `status` (`MILESTONE_STATUSES`) and `contractorId`.

Import the enum constants; never copy them.

- [ ] **Step 1: Write the failing type-equality and example tests** in `tests/api-schemas.test.ts`:

```ts
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { InvoicePayload } from "@/app/api/v1/invoices/route";
import type { LedgerEntryPayload } from "@/app/api/v1/ledger/route";
import type { StatusPayload } from "@/app/api/v1/status/route";
import type { CounterpartyPayload, ScreeningHistoryPayload } from "@/lib/api/counterparties";
import type { MilestonePayload } from "@/lib/api/milestones";
import type { TreasuryPayload } from "@/lib/api/treasury";
import type { InsightsData } from "@/lib/insights";
import type { VerificationResult } from "@/lib/ledger";
import * as S from "@/lib/api/schemas";
import { OPERATIONS } from "@/lib/api/openapi";

describe("schemas mirror the payload interfaces exactly", () => {
  it("cannot drift from the TypeScript the routes return", () => {
    expectTypeOf<z.output<typeof S.InvoiceSchema>>().toEqualTypeOf<InvoicePayload>();
    expectTypeOf<z.output<typeof S.LedgerEntrySchema>>().toEqualTypeOf<LedgerEntryPayload>();
    expectTypeOf<z.output<typeof S.StatusSchema>>().toEqualTypeOf<StatusPayload>();
    expectTypeOf<z.output<typeof S.CounterpartySchema>>().toEqualTypeOf<CounterpartyPayload>();
    expectTypeOf<z.output<typeof S.ScreeningHistorySchema>>().toEqualTypeOf<ScreeningHistoryPayload>();
    expectTypeOf<z.output<typeof S.MilestoneSchema>>().toEqualTypeOf<MilestonePayload>();
    expectTypeOf<z.output<typeof S.TreasurySchema>>().toEqualTypeOf<TreasuryPayload>();
    expectTypeOf<z.output<typeof S.InsightsSchema>>().toEqualTypeOf<InsightsData>();
    expectTypeOf<z.output<typeof S.VerificationResultSchema>>().toEqualTypeOf<VerificationResult>();
  });
});

describe("every documented example is a real response of the current shape", () => {
  it.each(OPERATIONS.map((op) => [op.id, op] as const))("%s", (_id, op) => {
    expect(() => op.response.parse(op.example)).not.toThrow();
  });
});
```

The detail payload (`CounterpartyDetailPayload`) is declared in the `[id]` route. Export it from there if it is not exported, and add the same `toEqualTypeOf` line for `CounterpartyDetailSchema`.

- [ ] **Step 2: Run the tests and see them fail.** Run `npx vitest run tests/api-schemas.test.ts`. Expected: FAIL, because `@/lib/api/schemas` does not exist.

- [ ] **Step 3: Write `src/lib/api/schemas.ts`.**
  - Mirror each interface field by field, in the style below.
  - Use `.nullable()` for `T | null` and `.optional()` for `?:`.
  - Where an interface uses a union of literals, use `z.enum([...])` built from the same exported constant when one exists.
  - For the insights telemetry types in `src/lib/insights.ts`, declare one schema per telemetry interface.

```ts
import { z } from "zod";
import type { ApiErrorCode } from "@/lib/api/contract";

export const ApiPageSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  count: z.number().int(),
});
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(["unauthorized", "forbidden", "not_found", "invalid_request", "rate_limited", "unavailable", "internal"] satisfies ApiErrorCode[]),
    message: z.string(),
  }),
});
export const collectionOf = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), page: ApiPageSchema });
export const resourceOf = <T extends z.ZodType>(item: T) => z.object({ data: item });

export const InvoiceSchema = z.object({
  id: z.string(),
  direction: z.enum(["payable", "receivable"]),
  status: z.string(),
  amount: z.number(),
  currency: z.string(),
  memo: z.string().nullable(),
  poReference: z.string().nullable(),
  goodsReceived: z.boolean(),
  dueDate: z.string(),
  decidedAt: z.string().nullable(),
  settledAt: z.string().nullable(),
  escalatedAt: z.string().nullable(),
  agentReasoning: z.string().nullable(),
  txHash: z.string().nullable(),
  counterparty: z.object({ id: z.string(), name: z.string(), riskLevel: z.string() }).nullable(),
  createdAt: z.string(),
}).describe("An invoice in the payable or receivable book, with the agent's reasoning.");
// …one schema per payload, each with .describe() and field-level .describe() taken from the interface's doc comments.
```

  Put each field's doc comment from the interface into `.describe("…")`. These become the reference pages' field descriptions.

- [ ] **Step 4: Write the example fixtures.**
  - Copy each endpoint's JSON block from `docs/api.md` into `content/docs/examples/<operation-id>.json`, exactly as captured.
  - If a captured example no longer parses because a field was added or removed since 25 September, change only that field. Take the new value from a real source (the route's mapping of a real column), and list each such change in your report. `status` no longer has a `database` block, for example.
  - Never invent a row.

- [ ] **Step 5: Write `src/lib/api/openapi.ts`.**
  - `OPERATIONS`: each entry imports its example JSON (`import example from "../../../content/docs/examples/list-invoices.json"`).
  - `buildOpenApiDocument(origin)` returns the document below.
  - Each response schema is `z.toJSONSchema(schema, { target: "draft-2020-12" })` with `$schema` deleted, placed under `components.schemas` by name. Each operation's 200 refers to it.
  - Error responses refer to `ApiError`, and each code maps to its HTTP status through `STATUS_FOR`.
  - Every operation has `security: [{ bearerAuth: [] }]` and includes `401` and `500` among its errors.

```ts
export function buildOpenApiDocument(origin: string): Record<string, unknown> {
  const components: Record<string, unknown> = { ApiError: jsonSchema(ApiErrorSchema) };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const name = schemaName(op.id); // "get-status" → "GetStatusResponse"
    components[name] = jsonSchema(op.response);
    const responses: Record<string, unknown> = {
      "200": { description: "OK", content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` }, example: op.example } } },
    };
    for (const code of op.errors) {
      responses[String(STATUS_FOR[code])] = { description: code, content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } };
    }
    (paths[op.path] ??= {})[op.method] = {
      operationId: op.id, summary: op.summary, description: op.description, tags: [op.tag],
      security: [{ bearerAuth: [] }],
      parameters: op.params.map((p) => ({
        name: p.name, in: p.in, required: p.required, description: p.description,
        schema: { type: p.type, ...(p.enum && { enum: p.enum }), ...(p.default !== undefined && { default: p.default }), ...(p.minimum !== undefined && { minimum: p.minimum }), ...(p.maximum !== undefined && { maximum: p.maximum }) },
        ...(p.example !== undefined && { example: p.example }),
      })),
      responses,
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Vestiarion API", version: "v1", description: "Read a workspace's ledger, books, counterparties, milestones, treasury and insights with a workspace API key." },
    servers: [{ url: origin }],
    components: { schemas: components, securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "A workspace API key: vxk_<prefix>_<secret>." } } },
    paths,
  };
}
```

- [ ] **Step 6: Write the route** `src/app/api/v1/openapi.json/route.ts`. It is public and static.
  - `export const dynamic = "force-static";`
  - `GET` returns `Response.json(buildOpenApiDocument(process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.vestiarion.xyz"))` with `cache-control: public, max-age=300`.
  - Check how the app already names its public origin (grep for `NEXT_PUBLIC_SITE_URL` or similar in `src/lib/config.ts`) and use that.

- [ ] **Step 7: Write `tests/openapi.test.ts`.** It covers coverage, structure and real responses.

```ts
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, OPERATIONS } from "@/lib/api/openapi";

function v1Routes(dir = path.join(process.cwd(), "src/app/api/v1"), prefix = "/api/v1"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...v1Routes(full, `${prefix}/${name.replace(/^\[(.+)\]$/, "{$1}")}`));
    else if (name === "route.ts") out.push(prefix);
  }
  return out;
}

describe("the OpenAPI document", () => {
  it("documents every v1 route exactly once, and nothing else", () => {
    const documented = OPERATIONS.map((op) => op.path).sort();
    expect(documented).toEqual(v1Routes().filter((p) => p !== "/api/v1/openapi.json").sort());
  });
  it("is a structurally valid 3.1 document whose refs all resolve", () => {
    const doc = buildOpenApiDocument("https://example.test") as { openapi: string; paths: object; components: { schemas: Record<string, unknown> } };
    expect(doc.openapi).toBe("3.1.0");
    const refs = JSON.stringify(doc).match(/"#\/components\/schemas\/[^"]+"/g) ?? [];
    for (const ref of refs) expect(doc.components.schemas).toHaveProperty(ref.slice(23, -1));
  });
  it("keeps stable operation ids, which are the reference page URLs", () => {
    expect(OPERATIONS.map((op) => op.id)).toMatchInlineSnapshot();
  });
});
```

  - Then add a `describe("each route's real 200 parses")` that drives every route through `fakeSupabase`, following `tests/api-key-scope.test.ts`: the same `next/server` and `api-keys` mocks, and a key resolved to one org.
  - Serve rows in which every nullable column is `null` (Review Focus 4). Parse `await response.json()` with `operationById(id)!.response`.
  - Also drive the counterparty detail route with an unknown id, and assert a 404 whose body parses with `ApiErrorSchema`.

- [ ] **Step 8: Check GREEN.** Run `npx vitest run tests/api-schemas.test.ts tests/openapi.test.ts`, then `npm run verify`. Expected: all pass. The inline snapshot fills on the first run; check it against the id table above.

- [ ] **Step 9: Commit** with the subject `feat(api): OpenAPI 3.1 document built from schemas that mirror every v1 payload`.

---

### Task 2: The docs shell and the MDX pipeline

**Files:**
- Modify: `next.config.ts` (wrap with `createMDX`; `pageExtensions` stays the default, because the content is imported, not routed), `package.json` and `package-lock.json` (the new dependencies)
- Create:
  - `mdx-components.tsx` at the project root, as the MDX guide requires for the App Router;
  - `src/lib/docs/nav.ts`, `src/lib/docs/content.ts`, `src/lib/docs/headings.ts`;
  - `src/app/docs/layout.tsx`, `src/app/docs/[[...slug]]/page.tsx`, `src/app/docs/not-found.tsx`;
  - `src/components/docs/DocsShell.tsx`, `DocsSidebar.tsx`, `DocsToc.tsx`, `CodeBlock.tsx`, `DocsPager.tsx`;
  - `content/docs/index.mdx`, a one-paragraph placeholder that Task 6 replaces. Its text must be true: "Vestiarion's developer documentation."
- Test: `tests/docs-content.test.ts`, `tests/docs-headings.test.ts`

**Interfaces:**
- **Produces**, from `src/lib/docs/nav.ts`:
  - `export interface NavPage { slug: string; title: string; description: string }` (`slug` `""` is `/docs`; `"get-started/quickstart"` is `/docs/get-started/quickstart`)
  - `export interface NavSection { title: string; pages: NavPage[] }`
  - `export const DOCS_NAV: NavSection[]`
  - `export function flatPages(): NavPage[]`, in nav order
  - `export function neighbours(slug: string): { prev?: NavPage; next?: NavPage }`
- **Produces**, from `src/lib/docs/content.ts`:
  - `export function readSource(slug: string): string` (the raw MDX, read with `fs` from `content/docs/<slug or index>.mdx`)
  - `export async function loadPage(slug: string): Promise<{ Content: React.ComponentType } | null>` (a dynamic `import()` of the MDX module through a static map `slug → () => import("…")`, which the bundler can see)
- **Produces**, from `src/lib/docs/headings.ts`:
  - `export interface Heading { depth: 2 | 3; text: string; id: string }`
  - `export function slugifyHeadings(markdown: string): Heading[]`, which skips fenced code, and gives repeated ids `-2`, `-3` and so on
  - `export function slugify(text: string): string`
- **Nav reference.** Task 3 registers the reference pages in `DOCS_NAV` itself. They are generated from `OPERATIONS`, with slug `api/<id>`, under the section "API reference", after the "Endpoint overview" page (slug `api`).

**The nav** (Task 6 writes the page files; Task 2 creates only `index.mdx`, and the nav test in this task checks only the pages that exist through `content/docs`):

| Section | Pages (slug · title) |
|---|---|
| Overview | `""` · Overview; `data-delivery` · Data delivery methods |
| Get started | `get-started/quickstart` · Quickstart; `get-started/authentication` · Authentication; `get-started/errors` · Errors; `get-started/pagination` · Pagination; `get-started/limits` · Limits |
| API reference | `api` · Endpoint overview; then the generated `api/<id>` pages (Task 3) |
| Webhooks | `webhooks` · Webhooks overview; `webhooks/payload` · Payload and headers; `webhooks/verify` · Verifying signatures; `webhooks/retries` · Retries and disabling; `webhooks/security` · Security; `webhooks/guarantees` · Delivery guarantees |
| AI integration | `ai-integration` · AI integration |
| Changelog | `changelog` · Changelog |

Put all of these in `DOCS_NAV` now, with their descriptions. In this task, the content test marks pages whose file does not exist yet as `todo`, using `it.todo` per missing file, and Task 6 turns those into real checks. Any other missing page fails the build test.

- [ ] **Step 1: Install the dependencies.** Run `npm install @next/mdx @mdx-js/loader @mdx-js/react @types/mdx shiki`, then configure `next.config.ts` per the MDX guide, keeping `redirects()`:

```ts
import createMDX from "@next/mdx";
import type { NextConfig } from "next";
import { legacyRedirects } from "./src/lib/auth/org-paths";

const nextConfig: NextConfig = {
  async redirects() {
    return legacyRedirects();
  },
};

export default createMDX({})(nextConfig);
```

- [ ] **Step 2: Write the failing heading tests** (Review Focus 3):

```ts
import { describe, expect, it } from "vitest";
import { slugifyHeadings } from "@/lib/docs/headings";

describe("slugifyHeadings", () => {
  it("gives repeated headings unique ids, and ignores headings inside code", () => {
    const md = "## Example\n\ntext\n\n```md\n## Not a heading\n```\n\n### Query `limit`\n\n## Example\n";
    expect(slugifyHeadings(md)).toEqual([
      { depth: 2, text: "Example", id: "example" },
      { depth: 3, text: "Query limit", id: "query-limit" },
      { depth: 2, text: "Example", id: "example-2" },
    ]);
  });
});
```

  Run it and see it fail, then implement `headings.ts`: strip inline code backticks and links from the text, lowercase, turn non-alphanumerics into `-`, trim `-`. Run it and see it pass.

- [ ] **Step 3: Write `mdx-components.tsx`.**
  - `h2`/`h3` render with the `id` from `slugify` of their text, repeated within a page the same way as `slugifyHeadings`: keep a per-render counter through a `HeadingIds` context provided by the page. Each also gets a hover `#` link.
  - `pre` → `CodeBlock`: an async server component that calls `codeToHtml(code, { lang, theme: "github-dark" })` from `shiki`. It sits in a wrapper with `overflow-x-auto`, a language label and `CopyButton value={code}`.
  - `table` → the `Table` primitive inside an `overflow-x-auto` container.
  - `a`: internal links (starting with `/`) use `next/link`.
  - `Callout` is exported to MDX.

- [ ] **Step 4: Write the shell.**
  - `src/app/docs/layout.tsx` renders `DocsShell`:
    - the `SiteHeader` with a "Docs" label;
    - a left `DocsSidebar` (sections from `DOCS_NAV`, active page highlighted, `aria-current="page"`), shown from `lg`; below `lg` it opens from a header button in a `Sheet` (`side="left"`);
    - the main column, `min-w-0` and at most about 48rem wide;
    - a right `DocsToc` from `xl`, which highlights the heading in view with an `IntersectionObserver` and uses no scroll-jacking.
  - `src/app/docs/[[...slug]]/page.tsx` does this:
    - `generateStaticParams` from `flatPages()` minus the `api/*` pages;
    - `generateMetadata` gives the title `"<title> · Vestiarion docs"`, the description, and `alternates.canonical`;
    - it renders the page's `Content`, the headings from `slugifyHeadings(readSource(slug))` for the TOC, and `DocsPager` (prev/next);
    - `notFound()` when `loadPage` returns null.
  - `src/app/docs/not-found.tsx` shows "This page does not exist" and links to `/docs`. It gets the search button in Task 5.

- [ ] **Step 5: Write `tests/docs-content.test.ts`.**
  - Every `content/docs/**/*.mdx` file is in `DOCS_NAV`, and every nav page has a file (with `it.todo` for Task 6's pages).
  - Every internal link `](/docs/…)` or `href="/docs/…"` in any MDX file points at a nav page, a generated `api/<id>` page, or `/api/v1/openapi.json`, `/llms.txt` or `/llms-full.txt`.
  - An anchor `#x` must be one of `slugifyHeadings(target source)`'s ids.

- [ ] **Step 6: Check GREEN.**
  - Run `npm run verify` and `npm run build`. The build must prerender `/docs`.
  - Start no dev server in the main checkout. The controller checks this in a browser.

- [ ] **Step 7: Commit** with the subject `feat(docs): documentation shell with MDX, sidebar, table of contents and highlighted code`.

---

### Task 3: Generated API reference pages and code samples

**Files:**
- Create: `src/lib/docs/samples.ts`, `src/lib/docs/schema-tree.ts`, `src/components/docs/ParamTable.tsx`, `SchemaTree.tsx`, `CodeSamples.tsx`, `EndpointHeader.tsx`, `src/app/docs/api/[operation]/page.tsx`, `content/docs/api.mdx` (the endpoint overview page)
- Modify: `src/lib/docs/nav.ts` (the API reference section lists `api`, then `OPERATIONS` in table order as `api/<id>`, titled with `op.summary`)
- Test: `tests/docs-samples.test.ts`, `tests/docs-schema-tree.test.ts`

**Interfaces:**
- **Consumes:** `OPERATIONS`, `operationById`, `DocOperation` and `DocParam` from Task 1; `DOCS_NAV` and `neighbours` from Task 2.
- **Produces**, from `src/lib/docs/samples.ts`:
  - `export type SampleLang = "curl" | "javascript" | "python"`
  - `export function sampleRequest(op: DocOperation, origin: string, values?: Record<string, string>): Record<SampleLang, string>`
  - `export function requestUrl(op: DocOperation, origin: string, values: Record<string, string>): string`, which fills the path params (URL-encoded) and adds only the non-empty query values
- **Produces**, from `src/lib/docs/schema-tree.ts`:
  - `export interface SchemaNode { name: string; type: string; required: boolean; nullable: boolean; description?: string; enum?: string[]; children?: SchemaNode[] }`
  - `export function schemaTree(jsonSchema: Record<string, unknown>): SchemaNode[]`, which walks `properties`, `items`, `anyOf` with `null` (becoming `nullable: true`) and `enum`

- [ ] **Step 1: Write the failing samples test:**

```ts
import { describe, expect, it } from "vitest";
import { operationById, OPERATIONS } from "@/lib/api/openapi";
import { requestUrl, sampleRequest } from "@/lib/docs/samples";

describe("code samples are generated from the operation", () => {
  it.each(OPERATIONS.map((op) => [op.id, op] as const))("%s names the method, path, key and required params", (_id, op) => {
    const s = sampleRequest(op, "https://www.vestiarion.xyz");
    for (const lang of ["curl", "javascript", "python"] as const) {
      expect(s[lang]).toContain(op.path.replace(/\{(\w+)\}/g, (_m, name) => `<${name}>`));
      expect(s[lang]).toContain("Bearer");
    }
    expect(s.curl).toMatch(/^curl /);
    expect(s.javascript).toContain("await fetch(");
    expect(s.python).toContain("requests.get(");
  });
  it("fills path params encoded and drops empty query values", () => {
    const op = operationById("get-counterparty")!;
    expect(requestUrl(op, "https://x.test", { id: "a b" })).toBe("https://x.test/api/v1/counterparties/a%20b");
    const list = operationById("list-invoices")!;
    expect(requestUrl(list, "https://x.test", { limit: "25", status: "" })).toBe("https://x.test/api/v1/invoices?limit=25");
  });
  it("produces JavaScript that parses", () => {
    for (const op of OPERATIONS) expect(() => new Function(`return (async () => { ${sampleRequest(op, "https://x.test").javascript} })`)).not.toThrow();
  });
});
```

  The samples use the placeholder `$VESTIARION_API_KEY`: shell `"Authorization: Bearer $VESTIARION_API_KEY"`, JavaScript `process.env.VESTIARION_API_KEY`, Python `os.environ["VESTIARION_API_KEY"]`. A sample never carries a literal key.

- [ ] **Step 2: Run the samples test and see it fail.** Implement `samples.ts`, then run it and see it pass.

- [ ] **Step 3: Write the failing test for `schemaTree`** against `z.toJSONSchema(InvoiceSchema)`:
  - `counterparty` is `nullable: true`, with three children;
  - `direction` has `enum ["payable", "receivable"]`;
  - every field is `required: true`, because the interface has no optional fields;
  - descriptions come through.

  Implement it and see the test pass.

- [ ] **Step 4: Write the components and the page.**
  - `EndpointHeader`: a `Badge` "GET", the path in mono (long paths wrap), and the summary.
  - `ParamTable`: name, `in`, type, required, default, allowed values and description. It uses the `Table` primitive in an `overflow-x-auto` box, and shows "No parameters." when the operation has none.
  - `SchemaTree`: nested fields in a `Disclosure` per object. The type line reads, for example, `string · nullable`.
  - `CodeSamples`: `Tabs` for cURL, JavaScript and Python, each a server-highlighted `CodeBlock`.
  - The page `/docs/api/[operation]`:
    - `generateStaticParams` from `OPERATIONS`, and the metadata;
    - it renders the header, the description, the auth note ("Send a workspace API key as `Authorization: Bearer …`", linked to `/docs/get-started/authentication`) and the parameters;
    - a slot for "Try it", which Task 4 fills; render nothing there for now;
    - the samples;
    - the response (an example `CodeBlock` of `op.example` pretty-printed, and the `SchemaTree`);
    - the errors, as a table of each code, its HTTP status and when it happens (text per code from `docs/api.md`'s "Error codes");
    - an optional notes section: if `content/docs/api/<id>.mdx` exists, render it through the same MDX pipeline (Task 6 writes these);
    - the pager.
  - `content/docs/api.mdx`, the endpoint overview:
    - one paragraph (the base URL `https://www.vestiarion.xyz/api/v1`; every endpoint is `GET` with a workspace key; responses use `{ data }`, collections add `page`);
    - then a table per tag listing each operation's path, linked to its page, and its summary.
    - Generate that table in MDX through an exported component `<EndpointTable />`, registered in `mdx-components.tsx` and rendered from `OPERATIONS`, so it can never go stale.

- [ ] **Step 5: Check GREEN.** Run `npm run verify` and `npm run build`. All 9 reference pages must prerender.

- [ ] **Step 6: Commit** with the subject `feat(docs): generated API reference pages with parameters, response schema and code samples`.

---

### Task 4: "Try it"

**Files:**
- Create: `src/components/docs/TryIt.tsx`
- Modify: `src/app/docs/api/[operation]/page.tsx` (render `<TryIt op={serializableOp} />` in the slot)
- Test: `tests/docs-try-it.test.tsx` (use the repo's existing component-test setup; check `vitest.config` for the jsdom or happy-dom environment and the `@testing-library/react` usage in existing `*.test.tsx`)

**Interfaces:**
- **Consumes:** `requestUrl` from Task 3. Pass the page a serialisable `{ id, method, path, params }`. Zod schemas cannot cross into a client component.
- **Produces:** `export default function TryIt({ op }: { op: { id: string; path: string; params: DocParam[] } })`

**Behaviour:**
- **Inputs.** A password-type `Input` for the key, labelled "Workspace API key", with a show/hide toggle. Then one `Input` per parameter, or a `Select` where the parameter has an `enum`, with "any" as the empty option.
- **Send.**
  - The key is trimmed (Review Focus 2). An empty key sends no `Authorization` header.
  - The path is `requestUrl(op, window.location.origin, values)`. It must start with `${origin}/api/v1/`; if not, refuse without sending.
  - `fetch(url, { headers, cache: "no-store" })`.
  - The status `Badge` is `tone` proof for 2xx and refused otherwise, next to the elapsed milliseconds and the pretty-printed JSON body, in a `CodeBlock`-styled `pre` (client side, no shiki) with `overflow-x-auto`.
- **Network error:** "The request did not complete." There is no retry.
- **A 401 from the API** is shown as-is, with the hint "Create a key on your workspace's Settings page (owners and admins)", linked to `/docs/get-started/authentication`.
- **The key is never persisted.** It stays in state only, and is not in the URL.

- [ ] **Step 1: Write the failing tests:**

```tsx
// Render <TryIt op={…list-invoices…} />, and mock global fetch to return 200 {"data":[],"page":{…}}.
it("sends the trimmed key only as a Bearer header, to this origin's /api/v1", async () => { /* type "  vxk_abc_def\n" → click Send → expect fetch called with `${location.origin}/api/v1/invoices` and headers.Authorization === "Bearer vxk_abc_def" */ });
it("sends no Authorization header when the key is blank", async () => { /* "   " → Send → headers has no Authorization */ });
it("never writes the key to storage or the URL", async () => { /* spy on Storage.prototype.setItem; after Send: not called; location.href does not contain the key */ });
it("shows the API's own 401 body and the hint", async () => { /* fetch → 401 {"error":{"code":"unauthorized",…}} → body text and the hint are visible */ });
it("reports a network failure without retrying", async () => { /* fetch rejects → "The request did not complete." and fetch called once */ });
```

  Write each test in full, using the environment setup the existing component tests use.

- [ ] **Step 2: Run them and see them fail.** Implement `TryIt.tsx`, then run them and see them pass.

- [ ] **Step 3: Check GREEN.** Run `npm run verify` and `npm run build`.

- [ ] **Step 4: Commit** with the subject `feat(docs): Try it on every reference page, with the key kept in memory only`.

---

### Task 5: Search, Markdown views, `llms.txt`, the sitemap and site links

**Files:**
- Create:
  - `src/lib/docs/markdown.ts`, `src/lib/docs/search-index.ts`;
  - `src/components/docs/DocsSearch.tsx`, `src/components/docs/CopyPage.tsx`;
  - `src/app/docs/[...slug].md/route.ts`: if the App Router cannot express a `.md` suffix on a catch-all, use `src/app/docs-md/[...slug]/route.ts` plus a rewrite in `next.config.ts` from `/docs/:path*.md` to `/docs-md/:path*`, and record which one you used;
  - `src/app/llms.txt/route.ts`, `src/app/llms-full.txt/route.ts`, `src/app/sitemap.ts`
- Modify: `DocsShell.tsx` (the search button with `Kbd` "Ctrl K", and `CopyPage` in the page header), `src/components/vx/SiteChrome.tsx` (a "Docs" link in the landing header links and in `SiteMenu`), `src/app/docs/not-found.tsx` (the search button)
- Test: `tests/docs-markdown.test.ts`, `tests/docs-search.test.ts`

**Interfaces:**
- **Consumes:** `flatPages`, `readSource`, `OPERATIONS`, `sampleRequest` and `schemaTree`.
- **Produces**, from `src/lib/docs/markdown.ts`:
  - `export function pageMarkdown(slug: string, origin: string): string | null`. For an MDX page, it returns the source with frontmatter removed, the import and export lines removed, and the components turned into Markdown:
    - `<Callout title="T">body</Callout>` → `> **T** body`;
    - `<EndpointTable />` → the operations table as Markdown.
    - Any other capitalised JSX tag is a test failure.

    For `api/<id>`, it returns the operation as Markdown: the title, `GET path`, the description, a parameter table, the cURL sample, the example JSON and a response field list from `schemaTree`. It returns null for an unknown slug.
  - `export function llmsIndex(origin: string): string`:

```text
# Vestiarion

> Vestiarion is an autonomous treasury agent for stablecoin businesses on Arc. Its API reads a workspace's signed ledger, books, counterparties, milestones, treasury and insights; signed webhooks push each ledger entry.

## Docs

- [Overview](https://www.vestiarion.xyz/docs.md): <description>
…one line per page, the api/* pages included, in nav order…

## Optional

- [OpenAPI document](https://www.vestiarion.xyz/api/v1/openapi.json)
```

  - `export function llmsFull(origin: string): string`: every page's Markdown in nav order, separated by `\n\n---\n\n`.
- **Produces**, from `src/lib/docs/search-index.ts`: `export interface SearchEntry { slug: string; title: string; section: string; heading?: string; anchor?: string; text: string }` and `export function buildSearchIndex(): SearchEntry[]`, with one entry per page and one per `##`/`###` heading. `text` is the first 200 characters of plain text after it. The index is built at build time and passed to `DocsSearch` as a prop from the layout.

**Search:**
- `CommandDialog` filters over title, heading and text, and shows "No results for …" when nothing matches.
- Choosing a result navigates to `/docs/<slug>#<anchor>`.
- The shortcut is Ctrl/⌘ + K. The handler ignores the key when `event.target` is an `input`, `textarea`, `select` or content-editable element, unless Ctrl or Meta is held (Review Focus 5).
- Export the handler as `isSearchShortcut(event)` so it can be unit-tested.

**Copy page:** a `CopyButton` whose value is fetched from the page's `.md` URL on click, or passed in as a prop from the server.

**Routes:** the `.md` route, `llms.txt` and `llms-full.txt` are `force-static`, with `generateStaticParams` over `flatPages()`, and are served as `text/markdown; charset=utf-8` and `text/plain; charset=utf-8`. The sitemap lists `/` and every docs page.

- [ ] **Step 1: Write the failing tests:**

```ts
// tests/docs-markdown.test.ts
it.each(flatPages().map((p) => [p.slug] as const))("%s renders to Markdown with no JSX left", (slug) => {
  const md = pageMarkdown(slug, "https://x.test");
  expect(md).not.toBeNull();
  expect(md!).not.toMatch(/<[A-Z][A-Za-z]*[\s/>]/);
});
it("returns null for an unknown page", () => expect(pageMarkdown("nope", "https://x.test")).toBeNull());
it("llms.txt lists every page once, by its .md URL", () => {
  const index = llmsIndex("https://x.test");
  for (const p of flatPages()) expect(index).toContain(`(https://x.test/docs${p.slug ? `/${p.slug}` : ""}.md)`);
});
it("llms-full.txt carries every page's title", () => {
  const full = llmsFull("https://x.test");
  for (const p of flatPages()) expect(full).toContain(p.title);
});

// tests/docs-search.test.ts
it("indexes every page and its headings", () => { /* buildSearchIndex() has an entry per flatPages() slug */ });
it("opens on Ctrl/⌘ K but never on a plain k typed in a field", () => {
  const input = document.createElement("input");
  expect(isSearchShortcut({ key: "k", ctrlKey: true, metaKey: false, target: document.body } as unknown as KeyboardEvent)).toBe(true);
  expect(isSearchShortcut({ key: "k", ctrlKey: false, metaKey: false, target: input } as unknown as KeyboardEvent)).toBe(false);
});
```

- [ ] **Step 2: Run them and see them fail.** Implement, then run them and see them pass.

- [ ] **Step 3: Check GREEN.** Run `npm run verify` and `npm run build`. Check that the build output lists the `.md`, `llms.txt`, `llms-full.txt` and `sitemap.xml` routes.

- [ ] **Step 4: Commit** with the subject `feat(docs): search, Markdown views of every page, llms.txt and a sitemap`.

---

### Task 6: Content

**Files:**
- Create or replace, in `content/docs/`:
  - `index.mdx`, `data-delivery.mdx`;
  - `get-started/{quickstart,authentication,errors,pagination,limits}.mdx`;
  - `webhooks.mdx` and `webhooks/{payload,verify,retries,security,guarantees}.mdx`;
  - `ai-integration.mdx`, `changelog.mdx`;
  - `api/<id>.mdx` notes only where there is something true to add beyond the schema, such as the ledger's ascending order and watermark cursor, the verify endpoint's `null` meaning "not checked", and status's `provenance` values.
- Modify:
  - `docs/api.md` and `docs/webhooks.md`: replace each with a short pointer to the matching `/docs` pages. Keep a single sentence and the links.
  - `README.md`: the links to the docs site.
  - `ARCHITECTURE.md`: one paragraph on the docs site and the rule "a PR that changes `/api/v1` or webhooks adds a changelog entry".
  - `src/components/ApiKeysPanel.tsx` and `src/components/WebhooksPanel.tsx`: a "Docs" link, to `/docs/get-started/authentication` and `/docs/webhooks` respectively.
- Test: `tests/docs-content.test.ts` (turn the `it.todo`s into real checks)

**Sources of truth (content must match these, not memory):**
- the current `docs/api.md` and `docs/webhooks.md` (move their content, split along the nav);
- `src/lib/api/contract.ts` for the error codes, statuses and page sizes;
- `src/lib/webhooks/*` for the webhook facts;
- `src/lib/auth/roles.ts` for who manages keys and webhooks.

**Page requirements:**
- **Overview (`index`):**
  - one paragraph on what Vestiarion is and what the API is for;
  - a card grid (use `Card` from `ui/`, exported to MDX) linking Quickstart, the API reference, Webhooks, AI integration and Changelog;
  - "What you can build": a bot that reports held payments with the agent's reasoning, an accounting sync from `/invoices`, an audit mirror from `/ledger` plus webhooks, and a treasury dashboard from `/treasury`.
- **Data delivery methods:**
  - REST pull and webhook push compared in a table (latency, auth, ordering, and when to use each);
  - one sentence that there is no WebSocket, because webhooks push each ledger entry.
- **Quickstart:** create a key (Settings, owner or admin, shown once), then the first `curl` to `/status`, then `/ledger?limit=5`, then next steps. The real example output comes from the fixtures.
- **Authentication:**
  - the key format `vxk_<prefix>_<secret>`, and that one key reads one workspace;
  - the `read` scope, revocation, and `last_used_at`;
  - that a missing, unknown and revoked key all get the same 401;
  - never put a key in a URL or in client-side code.
- **Errors:** the table of codes → statuses → meaning, and the error body example.
- **Pagination:** `limit` and `cursor`, opaque cursors, the ledger's ascending order as a watermark, and a loop example in JavaScript.
- **Limits:**
  - page size 1–200, default 50;
  - there is no rate limit per key today (D11); clients should still back off on `429` and `503`, because `rate_limited` and `unavailable` are defined codes;
  - freshness: data is read live on each request.
- **The webhooks pages:** the content of the current `docs/webhooks.md`, split along the nav, unchanged in substance. It includes the verification snippets exactly as they are there, which were tested against the repository's own signing code.
- **AI integration** (describe only what exists):
  - Markdown views: append `.md` to any docs URL, or use "Copy page";
  - `/llms.txt` and `/llms-full.txt`;
  - `/api/v1/openapi.json`;
  - setup for Claude Code, Codex and Cursor: one short block each that tells the agent to read `https://www.vestiarion.xyz/llms-full.txt` and `openapi.json`, and to keep the key in `VESTIARION_API_KEY`;
  - three copy-ready prompts:
    - "Write a webhook receiver in Node that verifies Vestiarion signatures and de-duplicates on the event id";
    - "Sync payable invoices into a spreadsheet, paging with the cursor";
    - "Alert when a payment is held, quoting the agent's reasoning".
  - No MCP server is mentioned. It does not exist yet.
- **Changelog:** dated entries, newest first, for the integration surface only:
  - 2026-09-29, these docs, OpenAPI and `llms.txt`;
  - 2026-09-29, signed webhooks;
  - 2026-09-29, workspace API keys, where the platform token no longer opens `/api/v1`.

  Check the dates against `git log --format="%ad %s" --date=short` for the merge commits of #33, #35 and this branch. Each entry states what changed for an integrator.

- [ ] **Step 1: Turn the nav test's `it.todo`s into real checks.** Every nav page must have a file. Run it and see it fail for the missing pages.
- [ ] **Step 2: Write the pages.** Run `npx vitest run tests/docs-content.test.ts tests/docs-markdown.test.ts`, which covers links, anchors and no JSX left in the `.md` output, until it is green.
- [ ] **Step 3: Check GREEN.** Run `npm run verify` and `npm run build`.
- [ ] **Step 4: Commit** with the subject `docs: developer documentation content, from quickstart to changelog`.

---

## Controller checks after Task 6 (not a subagent task)

- **Headless Edge** against a dev server in a worktree or a free port, never the other session's server:
  - `/docs`, `/docs/get-started/quickstart`, `/docs/api/list-invoices` and `/docs/webhooks/verify` at 360, 520 and 1440 px;
  - no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`);
  - search opens on Ctrl K and finds "cursor";
  - "Try it" without a key shows the 401 and the hint;
  - `/docs/api/list-invoices.md`, `/llms.txt` and `/api/v1/openapi.json` answer 200.
- **Rollout (spec §7):** after the merge, check the same URLs in production. The partner runs "Try it" with a real key. Record the outcome in the spec.
