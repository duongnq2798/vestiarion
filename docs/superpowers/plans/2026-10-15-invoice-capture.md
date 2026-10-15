# Invoice capture for Chrome: plan

Spec: `docs/superpowers/specs/2026-10-15-invoice-capture-design.md`.

1. **Migration 0121** (`supabase/migrations/0121_invoice_capture.sql`): `invoice_drafts` (tenant), `extension_grants`
   and `extension_auth_codes` (platform), `invoice_capture_sweep()` (service role). PGlite test first; then the shared
   registries (`TENANT_TABLES`, `PLATFORM_TABLES`, the RLS, cascade, composite-key and account-deletion tests).
2. **Model** (`src/lib/invoice-drafts/`): field schema, the extension's view, the store with "not set up", the capture
   read through `readInvoiceDraft`, the console's review list with duplicates.
3. **Commands** (`src/lib/commands/invoice-drafts.ts`): capture, edit, send (the `chrome` surface) and confirm,
   discard (the console); `addInvoice` and `createInvoice` learn `via: "chrome"`.
4. **Authorization** (`src/lib/extension/`): settings from `CHROME_EXTENSION_IDS`, PKCE, codes and tokens, the request
   guard with CORS and limits. Tests for every refusal first.
5. **Routes**: `/extension/authorize` and its consent action; `/api/extension/v1/{token,revoke,session}` and
   `invoice-drafts`, `invoice-drafts/[id]`, `invoice-drafts/[id]/send`.
6. **Console**: Captured drafts on Bills & receivables, the Chrome extension section of Settings, the counterparty name
   prefill, the cleanup's sweep.
7. **Extension** (`extensions/chrome-invoice-capture/`): manifest, service worker, popup, icons, store listing; the
   manifest's static test.
8. **Docs**: guide, privacy, architecture, changelogs. Then `TZ=UTC npm run verify` and `npx next build`.
