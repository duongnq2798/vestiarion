# MCP server: the read API, as tools an AI agent can call

This spec follows the developer docs design (`2026-09-29-developer-docs-design.md`), whose §8 names this as the next step. It was decided on 2026-09-30 by the implementer under the partner's standing instruction. Each decision states its reason.

## 1. What this builds

A remote MCP (Model Context Protocol) server at `https://www.vestiarion.xyz/api/mcp`.
- Claude Code, Cursor, Codex, or any client that speaks Streamable HTTP connects with the URL and a workspace API key.
- The agent can then answer questions from the workspace's own records: "which payments are held, and why?", "is the ledger intact?", "what is due to contractors this week?".
- Every tool is one of the documented `/api/v1` read operations. There are no write tools.

## 2. Decisions

- **M1. Built on `mcp-handler` v2 with `@modelcontextprotocol/server` v2, mounted as a Next route handler at `/api/mcp`.**
  - `createMcpHandler` returns a Web-standard `(Request) => Response`. It serves the 2026-07-28 MCP spec statelessly and falls back to stateless Streamable HTTP for 2025-era clients, from one handler.
  - Stateless means no session store and no Redis, which fits Vercel functions.
  - Both packages are official or maintained for exactly this use. Hand-rolling the protocol would mean owning version negotiation and every client quirk.
  - New dependencies: `mcp-handler`, `@modelcontextprotocol/server`. Zod 4 is already present.
- **M2. It authenticates with a workspace API key, the same as `/api/v1`.**
  - The request carries `Authorization: Bearer vxk_…`, checked by `authenticateApiKey`, with the `read` scope required.
  - A missing, malformed, unknown or revoked key answers HTTP 401 before any MCP processing, with the API's own error body and a `WWW-Authenticate: Bearer` header.
  - The key's organization scopes every tool call.
  - OAuth is out of scope: it is what the claude.ai web connectors need, and it needs an authorization server. The clients this targets (Claude Code, Cursor, Codex, and `mcp-remote` for stdio-only clients) all accept a static bearer header.
- **M3. Each tool is an API operation, generated from `OPERATIONS`.**
  - For each `DocOperation` there is one tool. Its name is the operation id in snake_case (`list_invoices`). Its description is the summary and the description. Its input schema is built from the operation's `DocParam`s (types, enums, bounds, required). Its annotations are `readOnlyHint: true`, `openWorldHint: false` and `idempotentHint: true`.
  - A call runs the operation's own route handler (`GET`) in-process, with a `Request` built from the arguments and the caller's `Authorization` header.
  - The tool returns the API's JSON exactly: as text, and as `structuredContent` when the status is 2xx.
  - This makes the tools the documented API by construction. There is no second read path to drift from the routes, the OpenAPI document or the docs; validation, pagination, errors and tenant scoping are the routes' own. A new operation becomes a tool with no further work.
  - The cost: the key is checked once by the MCP route and once by the operation route. That is two hash compares, and `last_used_at` is throttled anyway.
- **M4. API errors are tool errors, not protocol errors.**
  - A 4xx or 5xx from the operation returns `isError: true`, with the API's error body as text, so the agent can read "cursor is not valid for this endpoint" and correct itself.
  - A thrown exception is caught and reported as `isError` with a fixed message. The message is logged by tool name only; arguments and keys are never logged.
- **M5. No write tools.** Approving a payment, pausing the agent, and managing members, keys or webhooks are a person's decisions, made in the console, as the API keys design (K2) already argues. This version has no resources or prompts either: the tools cover the read surface, and the docs cover the prompts.
- **M6. Output size.** The collection tools default to the API's page size of 50, capped at 200. Their descriptions tell the agent to page with `cursor`. `get_insights` returns what the API returns. No truncation is added, so a tool's output is exactly the documented response.
- **M7. Docs.**
  - A new page, `/docs/ai-integration/mcp`, titled "MCP server". It covers the URL, auth, the tool list (generated from `OPERATIONS`, like the endpoint table), and setup for Claude Code, Cursor, Codex and stdio clients through `mcp-remote`. Each setup block is checked against that client's current documentation, and only syntax verified there is shown.
  - The AI integration page links to it, and there is a changelog entry.
  - The `llms` files and the `.md` views pick it up through the nav.
- **M8. Limits.** The MCP route sets `maxDuration` to 60. It adds no rate limit per key, the same as `/api/v1` (docs D11).

## 3. Components

```
src/lib/mcp/tools.ts          OPERATIONS → tool definitions (name, description, input schema, annotations)
src/lib/mcp/call.ts           runs one operation's GET with a built Request; maps the Response to a tool result
src/app/api/mcp/route.ts      auth gate (401), then createMcpHandler registering every tool; GET/POST/DELETE
content/docs/ai-integration/mcp.mdx   the MCP page; <McpToolTable /> generated from OPERATIONS
```

The operations' route handlers are imported through a static map from operation id to `GET`. `tests/openapi.test.ts` already proves that operations and routes match one-to-one, and the new test proves that tools and operations match one-to-one.

## 4. Testing

- **Tools = operations.**
  - One tool per operation, no more and no fewer.
  - The names are snake_case ids, and all annotations are read-only.
  - Each input schema accepts the operation's example parameters and rejects an out-of-enum value and a limit over 200.
- **Calls.**
  - Each tool is called through the handler with a real key, resolved through the same mocks as `tests/api-key-scope.test.ts`, against `fakeSupabase`.
  - Every request made names the key's organization.
  - A 200 comes back as `structuredContent` equal to the route's own JSON.
  - A bad cursor comes back as `isError` with the API's 400 body.
- **Auth.** No key, a malformed key, an unknown key, a revoked key and the platform token each answer HTTP 401 before any tool runs.
- **Protocol.** `initialize`, `tools/list` and `tools/call` over HTTP POST return well-formed JSON-RPC responses. They are driven through the exported handler with `Request` objects.
- **Hygiene.**
  - `access-gates` treats `/api/mcp` as keyed: it reaches tenant data only through the operation routes.
  - No log line contains an argument or a key.
- **Docs.** The MCP page is in the nav, its tool table lists every tool, and its links pass the link checker.

## 5. Rollout

1. Merge. Check in production:
   - `/api/mcp` without a key answers 401;
   - with the platform token it answers 401;
   - `tools/list` with a founding key, which the partner creates and uses, lists 9 tools.
2. The partner connects Claude Code with the documented command and asks "Is our ledger intact, and are any payments held?". Check that the answer cites `verify_ledger` and `list_invoices`.
3. Record the outcome here.

## 6. Out of scope

- OAuth, and claude.ai web connectors.
- Write tools.
- MCP resources and prompts.
- A stdio package on npm: `mcp-remote` covers stdio clients.
- Rate limits per key.
