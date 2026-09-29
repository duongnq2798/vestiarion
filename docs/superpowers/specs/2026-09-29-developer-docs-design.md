# Developer docs: a documentation site for the Vestiarion API

This spec follows the webhooks design (`2026-09-29-webhooks-design.md`). The partner asked for API documentation at the level of docs.coingecko.com:
- an overview;
- AI integration;
- WebSocket;
- an endpoint overview with reference pages;
- webhooks;
- a changelog.

Decided on 2026-09-29 by the implementer under the partner's standing instruction. Each decision states its reason.

## 1. What "that level" means here

CoinGecko's docs were read on 2026-09-29. What makes them good is this:
- **One entry page.** It routes each reader to getting started, the reference, the data delivery methods, and AI tooling.
- **An endpoint overview.** One table of every endpoint and what it answers.
- **A reference page per endpoint:**
  - method and path;
  - a runnable "Try it";
  - cURL and SDK samples;
  - every parameter with its type, default and allowed values;
  - the response schema as a tree;
  - a real example response;
  - notes on limits and freshness.
- **Guides** for auth, errors and use cases.
- **Webhooks** documented as a delivery method beside REST.
- **AI integration:** docs an agent can read (copy the page as Markdown, `llms.txt`), plus setup prompts for coding agents.
- **A dated changelog** of product changes.
- **Search**, a sidebar, and "on this page" navigation.

Vestiarion has less surface than CoinGecko:
- 9 read endpoints under `/api/v1`, with workspace API keys;
- signed webhooks;
- no WebSocket;
- no SDK.

The site documents exactly that, at the same level of care.

## 2. What this builds

1. **The site.** A public docs site at `/docs` on the product's own domain. It has these sections:
   - Overview
   - Get started (quickstart, authentication, errors, pagination, limits)
   - API reference (the endpoint overview, then one page per endpoint)
   - Webhooks (the existing guide, moved in)
   - AI integration
   - Changelog
2. **An OpenAPI 3.1 document** served at `/api/v1/openapi.json`. It is built from Zod schemas, and tests keep it from drifting from the routes.
3. **Generated reference pages.** Each shows the parameters and the response schema, a real example response, cURL, JavaScript and Python samples, and a "Try it" panel that calls the real endpoint with a key the reader pastes.
4. **Docs an agent can read:**
   - every page at `<path>.md`;
   - a "Copy page" button;
   - `/llms.txt` and `/llms-full.txt`.
5. **Navigation:** search (Ctrl/⌘ K), a sidebar, an on-page table of contents, previous/next links, and a layout that works at phone width and in the partner's ~520 px pane.

## 3. Decisions

- **D1. The site lives in this app at `/docs`, built with `@next/mdx` and the product's own components.**
  - *Reasons:* one design system, one domain, no external account or plan. The content sits next to the code it describes, so a route change and its docs change land in the same PR, under the same tests.
  - *Rejected:* Mintlify, CoinGecko's host. It needs a hosted account, lives in a separate styling world, and cannot import our schemas.
  - *Rejected:* Fumadocs. Its own UI kit and Tailwind preset would sit beside ours, and its OpenAPI playground pulls in the Scalar client.
  - *Cost:* we build search, the sidebar and the table of contents ourselves. That is a few small components on primitives we already have (`Command`, `Sheet`, `Tabs`, `CopyButton`).
  - New dependencies: `@next/mdx`, `@mdx-js/loader`, `@mdx-js/react`, `@types/mdx`, and `shiki` for build-time highlighting.
- **D2. Zod schemas are the single source of truth for the API's shapes.**
  - `src/lib/api/schemas.ts` declares a Zod schema for each response payload, next to the existing TypeScript interfaces.
  - A type-level test proves each `z.infer<…>` equals its interface, so neither can change alone.
  - `src/lib/api/openapi.ts` builds the OpenAPI 3.1 document from the schemas with Zod 4's `z.toJSONSchema`, plus per-operation metadata:
    - the summary and description;
    - the parameters, with their type, default, bounds and enum;
    - the error responses;
    - the `bearerAuth` security scheme.
  - `GET /api/v1/openapi.json` serves it publicly, without a key. It describes the surface and holds no data.
- **D3. Nothing documented can drift from the code.** Tests enforce:
  - **Coverage.** Every `route.ts` under `src/app/api/v1` (found by a filesystem scan) has exactly one operation in the document, and there are no extra operations.
  - **Responses.** A route test drives each v1 route through the recorded fake database (as `tests/api-key-scope.test.ts` does), and its 200 response parses against the operation's schema.
  - **Examples.** Each operation's example response parses against its own schema.
  - **Links.** Every internal link in the docs content resolves to a page or an anchor that exists.
  - **Fixtures.** Examples come from real responses of a sandbox workspace, saved as JSON fixtures in `content/docs/examples/`. None are invented.
- **D4. Reference pages are generated from the document, not hand-written.**
  - `/docs/api/[operation]` renders each operation from the OpenAPI document:
    - method and path;
    - the description and notes;
    - the auth;
    - the parameter table;
    - the response schema tree, with nested objects collapsible;
    - the error codes;
    - the example.
  - Code samples in cURL, JavaScript (`fetch`) and Python (`requests`) come from pure functions of the operation, so they cannot disagree with it.
  - Hand-written prose per endpoint (notes, use cases) lives in an optional `content/docs/api/<operation>.mdx` that the page includes.
- **D5. "Try it" calls the real endpoint, same origin, with a key the reader pastes.**
  - The key is kept in React state only: never `localStorage`, never a cookie, never logged, never sent anywhere but the `Authorization` header of that one request to this origin's `/api/v1`.
  - It shows the status, the elapsed time and the formatted JSON.
  - Without a key it explains how to create one, with a link to the workspace's Settings.
  - Same origin means no CORS changes to the API.
- **D6. The sections mirror CoinGecko's, mapped onto Vestiarion's surface:**
  - Overview: what the API and webhooks are for, and "Data delivery methods" (REST pull vs webhook push);
  - Get started: Quickstart (key → first request in 2 minutes), Authentication, Errors, Pagination, Limits;
  - API reference: the endpoint overview plus the generated pages;
  - Webhooks: overview, payload and headers, verifying signatures, retries, security, delivery guarantees;
  - AI integration;
  - Changelog.
- **D7. No WebSocket.** Vestiarion pushes events through signed webhooks and has no streaming need that justifies a socket. "Data delivery methods" says so plainly. Nothing is built for parity alone.
- **D8. Docs an agent can read.**
  - `app/docs/[...slug].md` serves each page's Markdown:
    - the MDX source with components rendered to Markdown equivalents;
    - reference pages rendered from the document into Markdown.
  - "Copy page" copies that Markdown.
  - `/llms.txt` lists every page with a one-line summary, following the llms.txt convention.
  - `/llms-full.txt` concatenates every page.
  - The AI integration page gives copy-ready setup for Claude Code, Codex and Cursor, pointing an agent at `llms-full.txt` and `openapi.json`, plus prompts such as "write a receiver that verifies Vestiarion webhooks".
  - A Vestiarion MCP server is the next spec, not this one, and the page describes only what exists.
- **D9. The changelog is one MDX file of dated entries, newest first.**
  - Each entry has an anchor and names what changed for an integrator.
  - It is back-filled from the product PRs that changed the API or the integration surface: API keys, webhooks, OpenAPI and these docs.
  - Every later PR that changes the surface adds an entry, and `AGENTS.md` says so.
- **D10. Layout and look:**
  - The product's tokens and typography. The product has one light theme and no dark mode, so the docs have none either: a theme system is a cross-cutting change of its own. Code blocks are dark panels, as the product already shows them.
  - Three columns at ≥ 1280 px (sidebar, content, table of contents); a sidebar in a `Sheet` below that; no horizontal scroll at 360 px.
  - Code blocks highlighted at build time with shiki, with a copy button.
  - The docs are public: no login.
  - Every page has its own title, description and canonical URL. A new `src/app/sitemap.ts` lists the landing page and every docs page; the app has none today.
  - The landing page and the product nav link to `/docs`.
- **D11. Limits are stated truthfully.** Today the API has no rate limit per key, and the Limits page says so. It also covers what is bounded: page size at most 200, and the response shapes. Rate limiting is future work and is out of scope here.
- **D12. The repo's docs move into the site.** `docs/api.md` and `docs/webhooks.md` become the site's content. The files in the repository then shrink to a pointer to `/docs`, so there is one copy.

## 4. Structure

```
content/docs/                  MDX pages (overview, get-started/*, webhooks/*, ai-integration, changelog)
content/docs/api/<op>.mdx      optional hand-written notes per operation
content/docs/examples/<op>.json captured example responses
src/lib/api/schemas.ts         Zod schemas for every payload (D2)
src/lib/api/openapi.ts         builds the OpenAPI 3.1 document (D2)
src/lib/docs/nav.ts            the sidebar tree and prev/next order, one source
src/lib/docs/content.ts        loads pages, headings for the TOC, the search index
src/lib/docs/samples.ts        cURL / JavaScript / Python from an operation (D4)
src/lib/docs/markdown.ts       page → Markdown for .md, Copy page, llms (D8)
src/app/docs/layout.tsx        shell: header, search, sidebar, TOC
src/app/docs/[[...slug]]/page.tsx   MDX pages
src/app/docs/api/[operation]/page.tsx  generated reference pages
src/app/api/v1/openapi.json/route.ts
src/app/llms.txt/route.ts, src/app/llms-full.txt/route.ts
src/components/docs/*          SchemaTree, ParamTable, CodeSamples, TryIt, Toc, DocsSearch, CopyPage
```

## 5. Error handling

| Situation | Result |
|---|---|
| An unknown docs path | The site's 404 page, with search open |
| "Try it" without a key, or with a revoked key | The API's own 401 body is shown, plus a line on where keys come from |
| "Try it" with invalid parameters | The API's own 400 body is shown; the form never blocks sending |
| A network failure in "Try it" | "The request did not complete", with no retry loop |
| An MDX page that fails to compile | The build fails. It never ships a blank page |

## 6. Testing

- **The OpenAPI document:**
  - coverage against the filesystem;
  - valid 3.1 structure: `openapi`, `info`, `paths`, `components.securitySchemes`, and every `$ref` resolving;
  - each example parses;
  - a snapshot of the operation ids.
- **Schemas:** type equality with the payload interfaces. Each v1 route's 200 response, driven through the fake database, parses against its schema.
- **Samples:** for each operation, cURL, JavaScript and Python contain the method, path, `Authorization: Bearer` and the required parameters. The JavaScript and Python samples are parsed for syntax.
- **Content:**
  - every nav entry has a page and every page is in the nav;
  - every internal link and anchor resolves;
  - `llms.txt` lists every page;
  - `/docs/<page>.md` answers 200 for every page.
- **"Try it":** a component test proves the key never reaches `localStorage` or `sessionStorage`, and only goes in the request's `Authorization` header to `/api/v1/…`.
- **In a browser,** checked with headless Edge:
  - the pages at 360, 520 and 1440 px;
  - search;
  - "Try it" against the dev server with a sandbox key;
  - "Copy page".

## 7. Rollout

1. Merge. Check in production:
   - `/docs`, a reference page, `/api/v1/openapi.json`, `/llms.txt` and a `.md` page;
   - "Try it" from the founding or `note-one` workspace with a real key, which the partner runs;
   - search.
2. Record the outcome here.

## 8. Out of scope, next

- **A Vestiarion MCP server:** read-only tools over `/api/v1`, authenticated by a workspace key. It is the next spec, and the AI integration page grows with it.
- Official TypeScript and Python SDKs generated from the OpenAPI document.
- Rate limits per key, and a status page.
- Versioned docs: there is one API version, `v1`.
- Translations.
