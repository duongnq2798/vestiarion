# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A remote MCP server at `/api/mcp`. It authenticates with a workspace API key and exposes each `/api/v1` read operation as a read-only tool. It is documented at `/docs/ai-integration/mcp`.

**Architecture:**
- The tools are generated from `OPERATIONS` (src/lib/api/openapi.ts).
- A tool call runs that operation's own route `GET` in-process, with a `Request` built from the arguments and the caller's `Authorization` header. The API's JSON comes back verbatim.
- The route checks the key first (401 before any MCP processing), then hands the request to `createMcpHandler` from `mcp-handler` v2.

**Tech Stack:** Next.js 16.3.6 route handlers, `mcp-handler` ^2, `@modelcontextprotocol/server` ^2, Zod 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-mcp-server-design.md` (M1–M8)

## Global Constraints

- **Next.js.** Read `node_modules/next/dist/docs/` before writing Next code. For `mcp-handler` and `@modelcontextprotocol/server`, read their READMEs and type definitions in `node_modules` before using an API. Both are v2, and their APIs differ from v1 examples found elsewhere: `registerTool` takes a full `z.object(...)`, and handler context is `ctx.http?.authInfo`.
- **Dependencies.** Only `mcp-handler` and `@modelcontextprotocol/server` are new. Install them with `npm install`, pinned exact (`--save-exact`), so `check:lock` stays green.
- **The key.** Keys and tool arguments are never logged. Log lines name the tool only.
- **Read-only.** There are no write tools, resources or prompts.
- **Docs copy.** Describe only what is built. Every client setup block is checked against that client's current official documentation, and a block that could not be checked is left out rather than guessed. No plan numbers, no hackathon wording, never "powerful".
- **Commits.** A neutral subject, then a blank line, then the Co-Authored-By trailer. Check that `git branch --show-current` is `feat/mcp-server` before every commit. `npm run verify` must be green at every commit.
- **Production.** Never run anything against production, never read `.env.local` values, and never start a dev server.

## Review Focus

1. **A key in the wrong place.** A key sent as `?key=` or in the MCP `_meta` instead of the header is refused with 401, and is never echoed back.
2. **Large responses.** `get_insights` returns the full API payload. The tool must not fail or truncate on a large JSON body.
3. **Arguments.** An argument of the wrong type (`limit: "abc"`) or an unknown enum value (`status: "bogus"`) is refused by the tool's input schema, or passed through to answer the API's own 400 as `isError`. It is never a thrown protocol error.
4. **Cross-tenant.** A tool call can only ever read the calling key's workspace. `get_counterparty` with another workspace's id answers `not_found`.
5. **Old clients.** A 2025-era client (protocol version `2025-06-18`) can initialize and list tools.

---

### Task 1: Tools from operations, and the in-process call

**Files:**
- Create: `src/lib/mcp/tools.ts`, `src/lib/mcp/call.ts`
- Test: `tests/mcp-tools.test.ts`, `tests/mcp-call.test.ts`
- Modify: `package.json` and `package-lock.json` (install the two dependencies)

**Interfaces:**
- **Consumes:** `OPERATIONS`, `DocOperation` and `DocParam` from `src/lib/api/openapi.ts`, and `requestUrl` from `src/lib/docs/samples.ts`.
- **Produces:**
  - `export interface McpTool { name: string; operationId: string; title: string; description: string; inputSchema: z.ZodObject; annotations: { readOnlyHint: true; openWorldHint: false; idempotentHint: true } }`
  - `export const MCP_TOOLS: readonly McpTool[]`, one per operation, in `OPERATIONS` order
  - `export function toolName(operationId: string): string`: `"list-invoices"` → `"list_invoices"`
  - `export interface ToolResult { content: [{ type: "text"; text: string }]; structuredContent?: Record<string, unknown>; isError?: boolean }`
  - `export async function callOperation(operationId: string, args: Record<string, unknown>, authorization: string, origin: string): Promise<ToolResult>`

**Details:**
- **The input schema per operation.** For each `DocParam`:
  - an `integer` becomes `z.number().int()`, with `.min`/`.max` from `minimum`/`maximum`;
  - a `string` becomes `z.string()`, or `z.enum(p.enum)` when there is an enum;
  - it is `.optional()` unless `required`;
  - `.describe(p.description)`.

  The object is `z.object(shape)`. Unknown keys are stripped.
- **The description** is `${op.summary}. ${op.description}`, plus, for collection operations (`op.collection`), "Returns one page; pass page.nextCursor back as cursor for the next."
- **`callOperation`:**
  - It looks up `ROUTES[operationId]`, a static map from operation id to the route module's `GET`: `import { GET as listInvoices } from "@/app/api/v1/invoices/route"` and so on, for all 9.
  - It builds `new Request(requestUrl(op, origin, stringValues(args)), { headers: { authorization } })`. For `get-counterparty` the route's second argument is `{ params: Promise.resolve({ id }) }`.
  - It awaits the response and reads its text:
    - 2xx: `{ content: [{ type: "text", text }], structuredContent: JSON.parse(text) }`;
    - other: `{ content: [{ type: "text", text }], isError: true }`;
    - a thrown exception: `{ content: [{ type: "text", text: "The operation failed. Try again." }], isError: true }`, logging `console.error("mcp tool failed", operationId)` only.
- **Tests:**
  - `MCP_TOOLS` maps 1:1 to `OPERATIONS`; names match `^[a-z_]+$`; the annotations are read-only.
  - A schema accepts `{ limit: 5, status: "held" }` for list_invoices, and rejects `limit: 500` and `status: "bogus"`.
  - `callOperation` against `fakeSupabase` with a key resolved to one org, using the mocks from `tests/api-key-scope.test.ts`, covers:
    - a 200 returns `structuredContent` equal to the route's JSON;
    - a bad cursor returns `isError` with the 400 body;
    - get_counterparty for an unknown id returns `isError` with `not_found`;
    - every tenant request names the key's org.

- [ ] Install: `npm install --save-exact mcp-handler@<latest 2.x> @modelcontextprotocol/server@<latest 2.x>`
- [ ] Write the failing tests and see them fail.
- [ ] Implement, and see them pass.
- [ ] Run `npm run verify`, then commit with the subject `feat(mcp): tools generated from the API operations, called in-process`.

### Task 2: The `/api/mcp` route

**Files:**
- Create: `src/app/api/mcp/route.ts`
- Test: `tests/mcp-route.test.ts`
- Modify: `tests/access-gates.test.ts` and `tests/api-key-scope.test.ts` if their route inventories need to name `/api/mcp`. Keep them strict: the exemption is by exact file name.

**Details:**
- `export const maxDuration = 60; export const dynamic = "force-dynamic";`
- **Auth gate.**
  - Read the `authorization` header with the same helper the guard uses (`src/lib/agent-security.ts`, `src/lib/api/guard.ts`), then call `authenticateApiKey`.
  - When there is no key, or it is revoked or unknown, or its scopes lack `read`, answer 401 or 403 with the API's error body (`apiError`) and `WWW-Authenticate: Bearer realm="vestiarion"`. Do this before calling the MCP handler.
  - Never read a key from the query string.
- **Handler.**
  - Build it with `createMcpHandler((server) => { for (const tool of MCP_TOOLS) server.registerTool(tool.name, { title, description, inputSchema, annotations }, (args) => callOperation(tool.operationId, args, authorization, origin)) }, { serverInfo: { name: "vestiarion", version: "1.0.0" } })`.
  - The origin is `new URL(request.url).origin`: the operation runs in-process, so the origin only has to make `requestUrl` produce the route's path.
  - The per-request `authorization` must reach the tool callbacks. Either build the handler per request (a closure over `authorization`; check the cost is small), or read it from the SDK's request context. Check what `mcp-handler` v2 exposes (`ctx.http`) and pick the documented way.
- **Methods.** `export { handler as GET, handler as POST, handler as DELETE }`, wrapped by the auth gate.
- **Tests,** driven with `Request` objects against the exported `POST`:
  - no key, a malformed key, an unknown key, a revoked key and the platform token each answer 401, and the MCP handler is never reached;
  - `?key=vxk_…` in the URL is ignored and answers 401;
  - `initialize` answers 200 with `serverInfo.name === "vestiarion"`, using the protocol version `mcp-handler` negotiates, plus one test with `"2025-06-18"`;
  - `tools/list` lists 9 tools with read-only annotations;
  - `tools/call` `verify_ledger` returns a result;
  - a JSON-RPC request with an unknown tool returns a JSON-RPC error or `isError`, not an HTTP 500.

  Use the SDK's own request format; read its README for the headers Streamable HTTP needs (`accept: application/json, text/event-stream`, `mcp-protocol-version`).
- [ ] TDD as above. Run `npm run verify` and `npm run build`, then commit with the subject `feat(mcp): a remote MCP server at /api/mcp, authenticated by a workspace API key`.

### Task 3: Docs

**Files:**
- Create: `content/docs/ai-integration/mcp.mdx`, `src/components/docs/McpToolTable.tsx`
- Modify:
  - `src/lib/docs/nav.ts`: add `ai-integration/mcp`, "MCP server", after `ai-integration`;
  - `src/lib/docs/content.ts` (`PAGE_LOADERS`);
  - `mdx-components.tsx` (register `McpToolTable`);
  - `src/lib/docs/markdown.ts` (convert `<McpToolTable />` to a Markdown table);
  - `content/docs/ai-integration.mdx` (a section linking the MCP page);
  - `content/docs/changelog.mdx` (a dated entry, 2026-09-30);
  - README (one line).

**The page content:**
- What it is: every API read operation as a read-only tool, answering from your workspace's own records.
- The URL: `https://www.vestiarion.xyz/api/mcp`.
- Auth: a workspace API key as `Authorization: Bearer`, linked to Authentication.
- The tool table: name, what it answers, and a link to the matching reference page.
- Setup blocks for:
  - Claude Code (the `claude mcp add` command for an HTTP server with a header);
  - Cursor (`.cursor/mcp.json` with `url` and `headers`);
  - Codex (`~/.codex/config.toml`);
  - stdio-only clients through `npx mcp-remote <url> --header "Authorization: Bearer ${VESTIARION_API_KEY}"`.

  **Check each block's syntax against that client's current official docs with WebFetch, and cite the doc URL in your report.** Leave out any block you could not confirm. Keep the key in an environment variable in every example.
- Example questions an agent can answer with the tools.
- What it does not do: no writes (approvals are a person's decision), and no OAuth, so it does not work as a claude.ai web connector.

**Tests:** the existing docs tests (nav, loaders, links, no JSX in `.md`, search) must pass with the new page. Add a test that `McpToolTable` lists every `MCP_TOOLS` name.

- [ ] TDD, then run `npm run verify` and `npm run build`, then commit with the subject `docs: the MCP server`.
