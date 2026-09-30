# Open numbers: a public page of platform-wide usage

Date: 2026-09-30. Status: approved for implementation (design decided under the standing autonomy
grant; rulings below carry their cost if wrong).

## 1. Why

The landing page's figures come from one workspace, the founding one, by design: a sandbox's demo
data must never inflate a "live" figure. That leaves no public answer to "how much is Vestiarion
used?" — how many businesses run on it, how many payments settled on Arc testnet, how much USDC
moved — and no answer that separates our own workspaces from anyone else's.

`/open` answers it from the production database on every load, with our own activity counted apart
from customers', and `npm run numbers` prints the same figures for the team.

## 2. What the page shows

A period switch: **All time** (default), **Last 7 days**, **Last 30 days**, or `?since=YYYY-MM-DD`
(stated on the page as "Since 27 Sep 2026"). Flow figures follow the period; stock figures say
"now".

One table, three columns — **Customers**, **Our workspaces**, **Total** — with these rows:

| Row | Kind | Source |
|---|---|---|
| Workspaces opened | period | `orgs.created_at` |
| Live on Arc testnet | now | `orgs.mode = 'live'` |
| People | now | customers: distinct members of customers' workspaces who are not on the team; ours: distinct members of our workspaces; total: distinct members |
| Payments settled on Arc testnet | period | `payment_intents`: provider `circle`, mode `live`, status `confirmed`, at `coalesce(executed_at, confirmed_at)` |
| USDC paid | period | sum of those payments' `amount` |
| Distinct payee wallets | period | distinct `lower(destination)` of those payments |
| Invoices decided | period | `invoices.decided_at`, excluding sample counterparties |
| Contractor milestones paid on Arc testnet | period | `milestones.status = 'paid'` whose settled Arc payment intent (`source_type = 'milestone'`) falls in the period, excluding sample counterparties |
| Agent cycles | period | `cycle_runs.started_at` |
| Decisions made by a model | period | `sum(cycle_runs.model_decision_count)` |
| Model departed from the written policy | period | `sum(reference_disagreement_count)` |
| Decisions refused by code | period | `sum(guardrail_override_count)` (a model's or the rule-based path's decision) |
| USDC in Arc testnet wallets | now | `accounts.balance` of live workspaces' accounts that hold a Circle wallet, token USDC, chain `ARC-TESTNET`, with `balance_synced_at` set (read from the chain at least once) |

Below it: a daily bar chart of settled payments across the period (customers and ours stacked;
all time starts at the first payment's day; at most the latest 90 days; a customer's amounts are
never shown by day, only their count), then **payments from our own workspaces** — the latest 20
in the period from the founding workspace and workspaces a team member opened, each with amount,
time and an arcscan link. A closing note states the method: what counts, what never counts, and
that customer payments are counted but never listed.

## 3. Rulings

- **R1 — route `/open`, title "Open numbers".** The build-in-public convention for a page of live
  company metrics. Cost if wrong: a rename and a redirect.
- **R2 — one boundary crosses tenants: `open_numbers(p_since timestamptz)`**, a `security definer`
  function with an empty `search_path`, executable by `service_role` only, returning one `jsonb`
  document of aggregates. It joins `PLATFORM_RPCS`; no tenant table joins `PLATFORM_TABLES`. No row
  of a customer workspace leaves the database, only counts and sums.
- **R3 — who is "us".** A table `platform_team (user_id uuid primary key references auth.users on
  delete cascade, added_at timestamptz)`, service-role only, managed by `npm run numbers -- team
  add|remove|list <email>`. A workspace is a **customer's** only when its `created_by` is set and
  not on the team; everything else — the founding workspace, a team member's, and one whose creator
  deleted their account — is counted as ours. A person is a customer unless on the team. The rule
  can only under-count customers, never inflate them.
- **R4 — only settled Arc payments count as payments.** Sandbox payments are simulated
  (`provider = 'simulate'`) and never appear; neither do pending or failed ones.
- **R5 — sample data never counts.** Invoices and milestones whose counterparty has `sample = true`
  are excluded from every row.
- **R6 — customers' payments are counted, never listed.** Only payments from the founding
  workspace and workspaces a team member opened are listed with transaction links; a workspace
  whose creator deleted their account is counted as ours but never listed, because it may be a
  former customer's. A customer's amounts never appear by day either: with one or two customers,
  a day's amount could point to a single transfer. A customer's payments are public on chain, but
  tying a hash to "a Vestiarion customer" is ours to withhold. The privacy page says the page
  publishes counts and totals only.
- **R7 — deleted workspaces drop out.** `delete_org` removes a workspace's rows; the page counts
  what exists. It never adds tombstones back.
- **R8 — period parsing.** `since` must be a calendar date from 2026-01-01 through today (UTC);
  anything else falls back to all time and says so. `7d`/`30d` are rolling from now.
- **R9 — freshness.** Read on every request (`dynamic = "force-dynamic"`), memoised in process for
  60 s per period so a busy page cannot hammer the database.

## 4. Pieces

- `supabase/migrations/0037_open_numbers.sql` — `platform_team` (RLS on, no policies, service
  role only) and `open_numbers(timestamptz)`. (0036 is taken by an open branch.)
- `src/lib/platform/open-numbers.ts` — `readOpenNumbers(period)` calls the RPC through
  `platformDb()`, validates the document with Zod, memoises it; `parsePeriod(searchParams)`;
  `team{Add,Remove,List}` for the script.
- `src/app/open/page.tsx` + `src/components/open/*` — the page, built from `src/components/ui` and
  `vx` primitives; the chart is a small declarative D3-scale SVG like `InsightsCharts`.
- `scripts/open-numbers.ts` — `npm run numbers [-- --since YYYY-MM-DD]` and the team subcommands.
- The landing's live figures link to `/open`; the site footer and `sitemap.xml` list it.

## 5. Tests

- PGlite (all migrations): the function's grants; each row's inclusion rules (live vs simulated,
  confirmed vs pending, sample excluded, period boundaries); the customer/ours split including a
  null creator and a team creator; the ours-only payment list; the daily series.
- Unit: `parsePeriod` (valid, future, pre-2026, malformed), the Zod contract, the memo.
- Render: the table's three columns, the empty states, the "counted, not listed" note.

## 6. Rollout

1. Partner runs `npm run db:migrate` (0037; additive).
2. Partner adds the team: `npm run numbers -- team add <email>` for each team account.
3. Merge → deploy; compare `/open` and `npm run numbers` with a read-only SQL probe.
4. Record the outcome here in §8.

## 7. Review changes (2026-09-30)

The whole-branch review found, and the branch fixed with a failing test first each time: a
former customer's workspace listed as ours (now counted, never listed); People counting as a
customer someone who belongs to no customer workspace; wallet USDC counting Base Sepolia and
never-synced seed balances; the milestones row counting milestones marked paid in a sandbox (now
only those a settled Arc payment paid, timed by that payment); the refusals row claiming a model
was overruled when the rule-based path's decisions count too; and customers' per-day USDC.

## 8. Rollout record

(pending)
