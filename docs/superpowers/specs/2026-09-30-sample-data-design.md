# Sample data: try the agent in a sandbox before setting anything up

A new workspace is empty. Before a person sees the agent decide anything, they have to add a counterparty, add an invoice and run a cycle, and even then one invoice shows one outcome. The product's point — the agent pays some things, holds some, flags some, asks about others, and a person has the last word — only shows once several of those happen at once.

This design adds a **sample-data loader**: one click fills a sandbox with example counterparties, invoices and milestones chosen so that one cycle shows every outcome, and a second click removes exactly those rows again. It is the last item of Tier 3 besides audit export (identity-and-tenancy spec §11; the go-live flow shipped in #47).

It was decided on 2026-09-30 by the implementer under the partner's standing instruction.

## 1. What this builds

- **A "Try it with sample data" card on the console.** It shows to owners and admins (`records.write`) of a sandbox that pays with the simulator and has no counterparties yet. The button is **Load sample data**.
- **Loading** inserts, in the workspace's own scope:
  - six counterparties, each marked `sample = true`, all fictional, none with an address;
  - seven invoices and two milestones against them (§3);
  - one ledger entry, `system/sample_data_loaded`, with the counts and who loaded it.
- **While sample data is loaded**, the console shows a callout: **Sample data is loaded**, with a **Remove sample data** button behind a confirmation. The Counterparties page shows a **Sample** badge next to each sample counterparty.
- **Removing** deletes every sample counterparty, and with it (the existing `on delete cascade`) its invoices, milestones and compliance checks, and the payment intents recorded for those invoices and milestones. It appends `system/sample_data_removed` with the counts. The ledger keeps every entry the sample data caused, as it keeps everything.
- **Connecting Circle and choosing a hosted wallet are refused while sample data is loaded**, with the message "Remove the sample data first. It exists only to try the agent with simulated payments."
- **The Get started checklist ignores sample rows**: sample invoices do not tick "Add an invoice", and a sample counterparty does not tick "Add a counterparty with an Arc address".
- **The "Your first payment" guide** gains a short "Try it with sample data first" section. Its quoted UI strings are pinned by the existing guides test.

## 2. Decisions

- **S1. Sample data lives only where payments are simulated.** A workspace pays for real whenever it holds readable Circle credentials, whatever its mode (go-live spec §1). A sample counterparty has no address, so a live provider would send to `sim:<id>` and Circle would reject it. So:
  - loading is refused unless the workspace is a sandbox with no Circle credentials stored and no wallet host chosen;
  - connecting Circle and choosing a hosted wallet are refused while any sample counterparty exists.

  The two checks are not one transaction. If a load and a connect race, the worst case is a Circle transfer rejected for an invalid address: no money can move to a counterparty without an address. That cost is accepted rather than moving the go-live checks into SQL.
- **S2. One marker, on counterparties only.** `counterparties.sample boolean not null default false`. Invoices and milestones are sample because their counterparty is. Removal is then one delete that the existing foreign keys finish. An invoice a person adds against a sample counterparty is removed with it; the confirmation says so ("…and everything recorded against them").
- **S3. Loading twice is impossible, not merely checked.** A partial unique index `(org_id, name) where sample` makes a second concurrent load fail on the counterparty insert; the loader reports that case as "Sample data is already loaded". The counterparties are one insert statement, so they arrive together or not at all. If the invoice or milestone insert then fails, the loader removes the counterparties it just inserted before reporting the error.
- **S4. Removal refuses while money could be moving.** It refuses while a cycle is running (the same 15-minute `cycle_runs` check as Edit limit) and while any intent for a sample obligation is `submitting` or `pending`. Simulated transfers settle synchronously, so in practice neither blocks for long.
- **S5. Balances and treasury history are not rewound.** Simulated payments to sample counterparties reduced the simulated operating balance, and a treasury sweep may have moved simulated cash. Removal leaves both as the cycles left them: undoing them would be rewriting history the ledger already signed. The confirmation says the ledger keeps its history.
- **S6. Fictional names only, no watchlist.** The operator's `seed.ts` fixture uses real company names and relies on the bundled watchlist, which OpenSanctions replaces when configured. The sample uses invented names, and every outcome comes from the invoice facts and limits alone, so it behaves the same on every deployment.
- **S7. No API change.** `/api/v1` keeps its payloads: a sample counterparty is a counterparty. The `sample` flag is not exposed, so there is no changelog entry.

## 3. The sample

Amounts are sized for the simulated operating balance of 10,000 USDC that every new sandbox starts with.

| Counterparty | Role | Limit | What is recorded | The first cycle's outcome |
|---|---|---|---|---|
| Northwind Hosting | vendor | 2,000 | 240 "Hosting — September", PO-1042, received, due in 3 days | paid |
| Northwind Hosting | | | 95 "Bandwidth overage", no PO, not received, due in 4 days | awaiting information |
| Harbor Office Supply | vendor | 500 | 1,200 "Standing desks", PO-2210, received, due in 6 days | held: over the limit |
| Kestrel Print Co | vendor | 1,500 | 180 "Brochure print run", PO-3307, **paid** 20 days ago | history |
| Kestrel Print Co | | | 180 "Brochure print run", PO-3307, received, due in 2 days | flagged: repeats a paid invoice |
| Lumen Retail Co | client | — | receivable 3,000 "Q4 platform retainer", SO-771, due in 10 days | forecast inflow |
| Priya Shah (contractor) | contractor | 4,000 | milestone 1,200 "API rate-limiting module", verified | released |
| Diego Ramirez (contractor) | contractor | 2,500 | milestone 900 "Landing page redesign", not verified | waits |

The exact outcomes are asserted by an end-to-end check in the sandbox (§5), not assumed from this table: if the agent decides differently, the fixture changes, not the claim.

## 4. Components

```
supabase/migrations/0034_sample_data.sql   counterparties.sample + partial unique index
src/lib/sample-data.ts                     the fixture, loadSampleData, removeSampleData, sampleDataState
src/app/o/[slug]/console/…                 SampleDataCard, the loaded callout, server actions
src/app/o/[slug]/counterparties/…          the Sample badge
src/lib/getting-started.ts                 input gains sample flags; ticks ignore sample rows
src/lib/platform/go-live.ts                connectCircle / chooseHostedWallet refuse with sample_data_loaded
content/docs/guides/first-payment.mdx      "Try it with sample data first"
```

- `sampleFixture(now)` is pure: it returns the rows to insert with dates relative to `now`, so it is tested without a database.
- `loadSampleData({ actorId })` and `removeSampleData({ actorId })` run inside the workspace scope (`inOrg`), through the tenant client, and throw a `SampleDataError` with a code and a message the UI shows as is (`not_sandbox`, `connected`, `already_loaded`, `not_loaded`, `cycle_running`, `payment_in_flight`).
- The server actions call `authorize(slug, "records.write")` first, as every exported action does (the structural access-gate test enforces it).

## 5. Testing and rollout

- **Unit:** the fixture's shape and dates; each refusal code; removal deleting intents before counterparties; the load compensating on a failed invoice insert; checklist ticks with sample rows present; go-live refusals; the card's and callout's visibility per role and state (`renderToStaticMarkup`).
- **Migration:** a PGlite test applies every migration and asserts that a second sample counterparty with the same name in the same org fails, and that a non-sample duplicate still succeeds.
- **Rollout:**
  1. Apply `0034` before the merge. It is additive: the old code never reads `sample`, and the default keeps every existing row non-sample.
  2. Merge on green.
  3. In a new sandbox: load, run one cycle, check each outcome in §3 against the Approvals page and the ledger, remove, and check that no sample row and no orphaned intent remains while the ledger still verifies.
  4. Record the measured outcome in this spec.

## 6. Out of scope

- Resetting simulated balances on removal (S5).
- Sample data in a connected or live workspace (S1).
- Choosing between several sample businesses.
- Exposing `sample` in `/api/v1` or the MCP tools (S7).
