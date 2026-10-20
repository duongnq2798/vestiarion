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

Signed-in workspace pages (`base-payout-test`, median of 5, after a warm-up):

| Page | First byte | Last byte |
| --- | --- | --- |
| Treasury (`/console`) | 1,211 ms | 4,435 ms |
| Bills & receivables | 1,371 ms | 6,336 ms |
| Counterparties | 1,685 ms | 3,391 ms |
| Approvals | 1,452 ms | 1,737 ms |

## What

`vercel.json` sets `"regions": ["hnd1"]`, so every function runs in Tokyo, beside the database.
- **Region setting.** The route-level `preferredRegion` is deprecated in this Next.js version, so the setting is
  project-wide.
- **The scheduled routes are not Vercel crons**, so they are unaffected:
  - Supabase Cron (pg_cron and pg_net, `supabase/cron/watches.sql`) calls six of them from the Tokyo database: the
    transfer watch, the FX watch, webhooks, the agent tick, the accounting sync and FX rates. They now reach a function
    next door.
  - GitHub's schedule calls only the sandbox cleanup. The other workflows stay for manual runs.
- **Calls to services in the US get one ocean crossing longer:** Circle (Wallets, Iris, Gateway), the Arc RPC, the
  model providers, Resend, BlindPay, the accounting and CRM connectors, and customers' webhook endpoints.
  - **A user's action makes few of them.** A model call takes seconds anyway.
  - **A scheduled run makes more.** The tick's start cutoff, the Circle waits and the connector sweep's budget are
    wall-clock limits, so a slower call means less work in a run, never a run past its limit.
  - **For the tick**, the review estimated about 8 to 12 calls to US services for each paid bill, which add 1.2 to
    1.8 seconds, against 20 to 40 database calls in a row, which save 3 to 6 seconds.
- **`vercel.json` holds only the region.** The security page's test now allows the file but checks that it sends no
  header, so the page's line about the Content Security Policy stays true.
- **No IP allowlist.** No service the app calls holds an allowlist of Vercel's addresses, which change anyway. Redis
  is not used.
- `tests/vercel-region.test.ts` pins the region, so removing it fails a test. `ARCHITECTURE.md` has a section on where
  it runs.

## After deploy

1. Measure the same pages again with the same script.
2. Measure the payee steps again: **Keep this address** and **Send my invoice** on a new link.
3. Check the production logs for the first agent cycle and webhook run, and confirm the functions report `hnd1`.
4. Rolling back means reverting `vercel.json`.
