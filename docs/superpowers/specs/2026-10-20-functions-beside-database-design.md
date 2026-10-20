# The server beside its database (2026-10-20)

## Why

Every server action and dynamic page on production took seconds. On a payee link, **Keep this address** took about
4.4 seconds to answer, although it sends no email. Sending an invoice took 3.7 seconds even after its email moved to
`after()` (#462). The reason is placement:
- Vercel ran the functions in its default region, **iad1** (Washington, D.C.).
- The Supabase project is in **ap-northeast-1** (Tokyo).

A page or an action makes its database calls one after another: reading the link, claiming it, signing a ledger entry
under its lock, reading the status back. Each call crossed the Pacific and back, about 150 ms, and an action makes
dozens of them.

Measured from Vietnam on Oct 20 before the change (median of 9, after a warm-up):

| Page | First byte | Last byte |
| --- | --- | --- |
| A payee link's page | 1,652 ms | 1,655 ms |
| `/open` | 431 ms | 823 ms |
| The landing | 383 ms | 636 ms |
| A prerendered docs page (no function, for comparison) | 88 ms | 113 ms |

## What

`vercel.json` sets `"regions": ["hnd1"]`, so every function runs in Tokyo, beside the database.
- **Region setting.** The route-level `preferredRegion` is deprecated in this Next.js version, so the setting is
  project-wide.
- **The scheduled jobs** are GitHub Actions workflows that call the API (`agent-cycle`, `fx-watch`, `transfer-watch`,
  `webhooks`, `sandbox-cleanup`). They are not Vercel crons, so they are unaffected.
- **Calls to services in the US get one ocean crossing longer:** Circle, the model provider, Resend. These calls are
  few per action, and a model call takes seconds anyway.
- **No IP allowlist.** No service the app calls holds an allowlist of Vercel's addresses, which change anyway. Redis
  is not used.
- `tests/vercel-region.test.ts` pins the region, so removing it fails a test. `ARCHITECTURE.md` has a section on where
  it runs.

## After deploy

1. Measure the same pages again with the same script.
2. Measure the payee steps again: **Keep this address** and **Send my invoice** on a new link.
3. Check the production logs for the first agent cycle and webhook run, and confirm the functions report `hnd1`.
4. Rolling back means reverting `vercel.json`.
