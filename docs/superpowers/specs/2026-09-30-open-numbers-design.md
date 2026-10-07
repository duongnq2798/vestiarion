# Open numbers: a public page of platform-wide usage

Date: 2026-09-30. Status: shipped (PR #69) (design decided under the standing autonomy
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

- **2026-09-30, about 14:50 UTC.** The partner applied 0037 with `npm run db:migrate` and put two accounts on the team with `npm run numbers -- team add`. The three other sign-in accounts were left off by choice, so their two sandbox workspaces count as customers'.
- **Read-only probe in production.**
  - `open_numbers`, `set_platform_team_member` and `platform_team_members` are all `security definer` with `search_path=""`.
  - None of the three is executable by anon or authenticated; the service role can execute all three.
  - `platform_team` has RLS on, and anon and authenticated cannot select from it.
- **`npm run numbers` against an independent SQL probe.** Every row matched. All time:
  - 7 workspaces opened: 2 customers', 5 ours.
  - 2 live, both ours.
  - 3 people: 1 customer, 2 ours.
  - 12 payments settled on Arc testnet, 16.815 USDC, to 6 payee wallets, all ours.
  - 14 invoices decided and 2 contractor milestones paid on Arc testnet.
  - 68 cycles and 90 decisions made by a model, with 3 departures from the written policy and 0 refused by code.
  - 50.765 USDC in Arc testnet wallets.
- **Before merging.** Main (#70, 0036) was merged into the branch, and `npm run verify` passed on the merged tree: 195 files, 3973 tests.
- **Merged** as `d693010` at 15:00 UTC.
  - CI's typecheck, lint and test steps passed on the head commit, and the Vercel preview built it. The build step was also checked locally with `next build`.
- **After the deploy, `www.vestiarion.xyz/open` answered 200 at 15:01 UTC.** It showed real activity since the probe: a 0.50 USDC payment at 14:56 UTC, which took the payments to 13 and 17.32 USDC and the wallet total to 50.27.
- **`?since=2026-09-27` on the page** showed:
  - 5 payments settled on Arc testnet, 12.50 USDC, to 2 payee wallets;
  - 5 invoices decided;
  - 44 cycles, with 56 decisions made by a model.

## 9. Redesign (2026-10-07)

The page read as a database report: every figure at the same weight, a screen of Arc mainnet zeros first, and the
agent's outcomes in a second table. It now answers, top down, who uses Vestiarion, whether money settles, what the
agent does on its own, what stops it, and how to check it. No figure, query or ruling changed; R6 holds (customers'
payments are counted, never listed, and never shown as a day's amount).

- **Order.** A network with figures gets the full section, Arc mainnet before Arc testnet when both have some; a network
  with nothing in it yet, or whose numbers cannot be read, is a compact card after them. A page of zeros never leads.
- **Heading.** "Vestiarion, in production", a live badge with the time read, and three promises: customers counted apart,
  one network at a time, checkable on chain.
- **Real customer usage.** Six headline figures are customers' alone, each with the total that includes our workspaces
  beneath it, so nobody has to ask how many of them are the team's.
- **How the agent performs.** Four shares across every workspace (decided by the agent itself, paid on time, on time with
  no person involved, flags upheld), each with its meter, its counts and customers' own share.
- **What stands between the model and the money.** The checks a payment decision passes, each with its count: a model
  proposes; it is compared with the written policy; hard limits in code; a person when it matters; it settles. The row
  once named "Model departed from the written policy" is now "Model disagreed with the written policy": the same
  figure, named for what it measures, and the method says the model's choice still passes the same checks in code.
- **Payments you can check on chain.** The newest five of ours, the rest behind a disclosure.
- **Every figure.** One table, folded, grouped as adoption, money moved, agent activity, outcomes, and safety and
  controls; customers' column is the one set in ink.
- **How the figures are counted.** The method, unchanged, folded into five groups, with the two new definitions
  (disagreeing with the written policy, refused by code).
- Not done, because the data does not exist or would break R6: milestone annotations on the chart, a USDC-by-day view
  for customers, and a "view all payments" page past the latest 20.
