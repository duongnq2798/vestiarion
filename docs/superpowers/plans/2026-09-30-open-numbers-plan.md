# Open Numbers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public `/open` page and `npm run numbers` that report platform-wide usage from production, customers counted apart from our own workspaces.

**Architecture:** One `security definer` function, `open_numbers(p_since)`, is the only thing that reads across tenants; it returns aggregates as one `jsonb` document. `src/lib/platform/open-numbers.ts` calls it through `platformDb()`, validates it with Zod and memoises it for 60 s. The page and the script both read through that module.

**Tech Stack:** Postgres (Supabase; PGlite in tests), Next.js App Router server components, Zod, D3 scales for the chart, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-open-numbers-design.md`

## Global Constraints

- Migration file is `supabase/migrations/0037_open_numbers.sql` (0036 belongs to an open branch); idempotent; ends with a commented rollback.
- New functions: `security definer`, `set search_path = ''`, `revoke execute … from public, anon, authenticated`, `grant execute … to service_role`.
- `platform_team`: RLS enabled, no policies, `revoke all … from anon, authenticated`, `grant all … to service_role`.
- A workspace is a customer's only when `created_by is not null` and not in `platform_team`.
- Payments: `provider = 'circle' and provider_mode = 'live' and status = 'confirmed'`, time `coalesce(executed_at, confirmed_at, updated_at)`.
- Sample counterparties (`sample = true`) never count. Customer payments are never listed.
- Copy says "Arc testnet" plainly; no disclaimers that talk the product down. Commit messages neutral.
- Dates on the page use `utcDay` from `src/lib/copy.ts`.

## Review Focus

- The RPC failing (migration not applied, network): the page still renders with a plain "could not be read" note, never a 500 — pinned in Task 4.
- A `since` in the future, before 2026, malformed, or given twice: falls back to all time and says so — pinned in Task 2.
- A workspace whose creator deleted their account (`created_by` null): counted as ours, never as a customer — pinned in Task 1.
- The same payee wallet paid from a customer and from us, or one person in both kinds of workspace: Total counts them once — pinned in Task 1.
- A confirmed payment with no `tx_hash`: counted, but not listed (no broken arcscan link) — pinned in Task 1.

---

### Task 1: Migration 0037 — `platform_team`, `open_numbers`, team functions

**Files:**
- Create: `supabase/migrations/0037_open_numbers.sql`
- Test: `tests/open-numbers-migration.test.ts`

**Interfaces:**
- Produces: `open_numbers(p_since timestamptz) returns jsonb` with keys `generatedAt`, `sides.{customers,ours,total}.{workspacesOpened,liveWorkspaces,people,payments,usdcPaid,payees,invoicesDecided,milestonesReleased,cycles,modelDecisions,policyDepartures,refusedByCode,usdcInWallets}`, `daily[] {day,customers,ours,customersUsdc,oursUsdc}` (days with payments only), `ourPayments[] {at,amount,txHash,chain}` (latest 20, ours, with a hash); `set_platform_team_member(p_email text, p_member boolean) returns boolean`; `platform_team_members() returns table (email text, added_at timestamptz)`.

- [ ] **Step 1: Write the failing test** — `tests/open-numbers-migration.test.ts` using `createDatabase`, `applyMigrations`, `createUser`, `asRole`, `asServiceRole` from `./support/pglite`. Seed with SQL: a team user and a customer user; `platform_team` gets the team user via `set_platform_team_member`. Orgs: `ours-co` (created_by team), `cust-co` (created_by customer, mode live), `orphan-co` (created_by null). In `cust-co`: an account with `circle_wallet_id` and balance 40 USDC; a counterparty `Acme` and a sample counterparty; payments — confirmed live 5.00 to `0xAAA` (executed 2026-09-28), confirmed live 3.00 to `0xaaa` (2026-09-29, same payee other case), pending live 9.00, confirmed simulate 7.00; an invoice decided 2026-09-28 and one with the sample counterparty decided the same day; a paid milestone settled 2026-09-29; a cycle_run 2026-09-28 with model 3, disagreements 1, overrides 1. In `ours-co`: confirmed live 2.00 to `0xAAA` with `tx_hash '0xh1'` (2026-09-27), confirmed live 1.00 with `tx_hash` null (2026-09-26). Assertions:
  - `select open_numbers(null)`: customers.payments 2, usdcPaid 8, payees 1; ours.payments 2, usdcPaid 3, payees 1; total.payees 1; customers.workspacesOpened 1, ours.workspacesOpened 2 (ours-co + orphan-co); customers.liveWorkspaces 1; customers.invoicesDecided 1; customers.milestonesReleased 1; customers.cycles 1, modelDecisions 3, policyDepartures 1, refusedByCode 1; customers.usdcInWallets 40; people: customers 1, ours 1, total 2 (members inserted for both users).
  - `open_numbers('2026-09-28T00:00:00Z')`: customers.payments 2, ours.payments 0.
  - `daily` has one entry per day with payments, ascending, with the split.
  - `ourPayments` is exactly `[{txHash:'0xh1', amount:2, …}]` — never the customer's, never the hash-less one.
  - `anon` and `authenticated` get permission denied on `open_numbers`, `set_platform_team_member`, `platform_team_members` and `select * from platform_team`.
  - `set_platform_team_member('nobody@x', true)` raises `user_not_found`; adding twice returns `true` then `false`; removing returns `true`; `platform_team_members()` lists emails.
- [ ] **Step 2: Run** `npx vitest run tests/open-numbers-migration.test.ts` — expect failure (function does not exist).
- [ ] **Step 3: Write the migration** (full SQL):

```sql
create table if not exists public.platform_team (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.platform_team enable row level security;
revoke all privileges on table public.platform_team from anon, authenticated;
grant all privileges on table public.platform_team to service_role;

create or replace function public.set_platform_team_member(p_email text, p_member boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_changed int;
begin
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then raise exception 'user_not_found: no account with that email'; end if;
  if p_member then
    insert into public.platform_team (user_id) values (v_user) on conflict (user_id) do nothing;
  else
    delete from public.platform_team where user_id = v_user;
  end if;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

create or replace function public.platform_team_members() returns table (email text, added_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select u.email::text, t.added_at from public.platform_team t join auth.users u on u.id = t.user_id order by t.added_at
$$;

create or replace function public.open_numbers(p_since timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  with
  org_side as (
    select o.id, o.mode, o.created_at,
           case when o.created_by is not null
                 and not exists (select 1 from public.platform_team t where t.user_id = o.created_by)
                then 'customers' else 'ours' end as side
      from public.orgs o
  ),
  sides(side) as (values ('customers'), ('ours'), ('total')),
  pay as (
    select s.side, p.amount, lower(p.destination) as payee, p.tx_hash, p.chain,
           coalesce(p.executed_at, p.confirmed_at, p.updated_at) as at
      from public.payment_intents p join org_side s on s.id = p.org_id
     where p.provider = 'circle' and p.provider_mode = 'live' and p.status = 'confirmed'
       and coalesce(p.executed_at, p.confirmed_at, p.updated_at) >= coalesce(p_since, '-infinity')
  ),
  person as (
    select distinct m.user_id,
           case when exists (select 1 from public.platform_team t where t.user_id = m.user_id) then 'ours' else 'customers' end as side
      from public.memberships m
  ),
  inv as (
    select s.side from public.invoices i
      join org_side s on s.id = i.org_id
      join public.counterparties c on c.id = i.counterparty_id
     where i.decided_at is not null and i.decided_at >= coalesce(p_since, '-infinity') and not c.sample
  ),
  mil as (
    select s.side from public.milestones m
      join org_side s on s.id = m.org_id
      join public.counterparties c on c.id = m.contractor_id
     where m.status = 'paid' and coalesce(m.settled_at, m.decided_at, m.created_at) >= coalesce(p_since, '-infinity') and not c.sample
  ),
  run as (
    select s.side, r.model_decision_count, r.reference_disagreement_count, r.guardrail_override_count
      from public.cycle_runs r join org_side s on s.id = r.org_id
     where r.started_at >= coalesce(p_since, '-infinity')
  ),
  wallet as (
    select s.side, a.balance from public.accounts a join org_side s on s.id = a.org_id
     where s.mode = 'live' and a.circle_wallet_id is not null and a.token = 'USDC'
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'sides', (select jsonb_object_agg(sd.side, jsonb_build_object(
      'workspacesOpened', (select count(*) from org_side o where sd.side in ('total', o.side) and o.created_at >= coalesce(p_since, '-infinity')),
      'liveWorkspaces',   (select count(*) from org_side o where sd.side in ('total', o.side) and o.mode = 'live'),
      'people',           (select count(distinct x.user_id) from person x where sd.side in ('total', x.side)),
      'payments',         (select count(*) from pay x where sd.side in ('total', x.side)),
      'usdcPaid',         (select coalesce(sum(x.amount), 0) from pay x where sd.side in ('total', x.side)),
      'payees',           (select count(distinct x.payee) from pay x where sd.side in ('total', x.side)),
      'invoicesDecided',  (select count(*) from inv x where sd.side in ('total', x.side)),
      'milestonesReleased', (select count(*) from mil x where sd.side in ('total', x.side)),
      'cycles',           (select count(*) from run x where sd.side in ('total', x.side)),
      'modelDecisions',   (select coalesce(sum(x.model_decision_count), 0) from run x where sd.side in ('total', x.side)),
      'policyDepartures', (select coalesce(sum(x.reference_disagreement_count), 0) from run x where sd.side in ('total', x.side)),
      'refusedByCode',    (select coalesce(sum(x.guardrail_override_count), 0) from run x where sd.side in ('total', x.side)),
      'usdcInWallets',    (select coalesce(sum(x.balance), 0) from wallet x where sd.side in ('total', x.side))
    )) from sides sd),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object(
        'day', d.day, 'customers', d.customers, 'ours', d.ours,
        'customersUsdc', d.customers_usdc, 'oursUsdc', d.ours_usdc) order by d.day), '[]'::jsonb)
      from (select to_char(x.at at time zone 'UTC', 'YYYY-MM-DD') as day,
                   count(*) filter (where x.side = 'customers') as customers,
                   count(*) filter (where x.side = 'ours') as ours,
                   coalesce(sum(x.amount) filter (where x.side = 'customers'), 0) as customers_usdc,
                   coalesce(sum(x.amount) filter (where x.side = 'ours'), 0) as ours_usdc
              from pay x group by 1) d),
    'ourPayments', (select coalesce(jsonb_agg(jsonb_build_object(
        'at', y.at, 'amount', y.amount, 'txHash', y.tx_hash, 'chain', y.chain) order by y.at desc), '[]'::jsonb)
      from (select * from pay x where x.side = 'ours' and x.tx_hash is not null order by x.at desc limit 20) y)
  )
$$;
-- plus the revoke/grant pairs for all three functions and the commented rollback
```

- [ ] **Step 4: Run** the test file — expect PASS. Also `npx vitest run tests/composite-fks.test.ts tests/go-live-migration.test.ts` (other full-migration suites) — expect PASS.
- [ ] **Step 5: Commit** — `git commit -m "Count platform usage in one aggregate function, with our own workspaces apart"`.

### Task 2: `src/lib/platform/open-numbers.ts`

**Files:**
- Create: `src/lib/platform/open-numbers.ts`
- Modify: `src/lib/dal/index.ts` (`PLATFORM_RPCS` += `"open_numbers", "set_platform_team_member", "platform_team_members"`)
- Test: `tests/open-numbers.test.ts`

**Interfaces:**
- Produces:
  - `type SideKey = "customers" | "ours" | "total"`; `interface SideNumbers { workspacesOpened; liveWorkspaces; people; payments; usdcPaid; payees; invoicesDecided; milestonesReleased; cycles; modelDecisions; policyDepartures; refusedByCode; usdcInWallets: number }`
  - `interface OpenNumbers { generatedAt: string; sides: Record<SideKey, SideNumbers>; daily: DailyPayments[]; ourPayments: OurPayment[] }`, `DailyPayments { day: string; customers: number; ours: number; customersUsdc: number; oursUsdc: number }`, `OurPayment { at: string; amount: number; txHash: string; chain: string | null }`
  - `interface Period { key: "all" | "7d" | "30d" | "since"; since: Date | null; label: string; query: string; fallback: boolean }`
  - `parsePeriod(params: { period?: string | string[]; since?: string | string[] }, now?: Date): Period`
  - `readOpenNumbers(period: Period, now?: number): Promise<OpenNumbers>` (60 s memo per `period.key + since`)
  - `dailySeries(daily: DailyPayments[], period: Period, now?: Date): DailyPayments[]` (every UTC day from the start to today, zeros filled, latest 90 at most; all time starts at the first day with a payment; empty input → empty output)
  - `setTeamMember(email: string, member: boolean): Promise<boolean>`, `listTeam(): Promise<Array<{ email: string; addedAt: string }>>`

- [ ] **Step 1: Failing tests** — `parsePeriod`: `{}` → all/"All time"; `{period:"7d"}` → since = now−7 d, label "Last 7 days", query `?period=7d`; `{since:"2026-09-27"}` → label "Since Sep 27, 2026", query `?since=2026-09-27`; future date, `2025-12-31`, `2026-02-30`, `"x"`, `["2026-09-27","2026-09-28"]` → all time with `fallback: true`. `dailySeries`: fills gaps with zeros, caps at 90, empty stays empty, `since` period starts at the since day. `readOpenNumbers`: with a fake platform client (pattern in `tests/dal.test.ts`, `scoped(..., null)`), calls `open_numbers` with `p_since` ISO or null, parses numbers given as strings, reuses the memo within 60 s, re-reads after, and drops a rejected read from the memo.
- [ ] **Step 2: Run** — FAIL (module missing).
- [ ] **Step 3: Implement** with `z.coerce.number()` for every figure, `utcDay` for the label, and the memo as `Map<string, { at: number; value: Promise<OpenNumbers> }>`.
- [ ] **Step 4: Run** the new test and `tests/dal.test.ts` — PASS.
- [ ] **Step 5: Commit** — `"Read the open numbers through the platform client, by period"`.

### Task 3: `npm run numbers`

**Files:**
- Create: `scripts/open-numbers.ts`
- Modify: `package.json` (`"numbers": "tsx scripts/open-numbers.ts"`)

- [ ] **Step 1:** Script: loads dotenv like `scripts/status.ts`; `team list|add <email>|remove <email>` call `listTeam`/`setTeamMember`; otherwise `--since YYYY-MM-DD` / `--period 7d|30d` build a `Period` through `parsePeriod` and print a three-column table (customers, ours, total) plus the daily rows and our payments' hashes. Exits 1 with the message on an error.
- [ ] **Step 2:** `npm run typecheck`, `npm run lint` — PASS.
- [ ] **Step 3: Commit** — `"Print the open numbers and manage the team list from the command line"`.

### Task 4: The `/open` page

**Files:**
- Create: `src/app/open/page.tsx`, `src/components/open/OpenNumbersTable.tsx`, `src/components/open/PaymentsChart.tsx`, `src/components/open/OurPayments.tsx`, `src/components/open/PeriodNav.tsx`
- Test: `tests/open-page.test.tsx`

**Interfaces:**
- Consumes: Task 2's `parsePeriod`, `readOpenNumbers`, `dailySeries`, types.
- Produces: `OPEN_ROWS: ReadonlyArray<{ key: keyof SideNumbers; label: string; kind: "period" | "now"; format: "count" | "usdc" }>` in `OpenNumbersTable.tsx`.

- [ ] **Step 1: Failing tests** (`vi.mock("@/lib/platform/open-numbers", …)` keeping the real `parsePeriod`/`dailySeries`; render with `renderToStaticMarkup(await OpenPage({ searchParams: Promise.resolve({...}) }))`): the table has the three column headers and every `OPEN_ROWS` label; figures render (USDC with two decimals); a "now" row says "now"; the period nav marks the current period with `aria-current="page"`; a fallback period shows "showing all time"; our payments link to `https://testnet.arcscan.app/tx/<hash>`; the method note says customer payments are counted, not listed; with `readOpenNumbers` rejecting, the page renders "could not be read" and no table; with zero payments the chart shows its empty state.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Read the `dataviz` skill before writing `PaymentsChart`. Page frame like `LegalPage` (SiteHeader, `main#main`, `max-w-5xl`, `SiteFooter compact`), `export const dynamic = "force-dynamic"`, metadata title "Open numbers", canonical `/open`. Table is a real `<table>` with `<caption>`, `scope` on headers, mono tabular figures, horizontally scrollable wrapper on small screens. Chart: server-rendered SVG, `scaleBand`/`scaleLinear`, customers and ours stacked, `role="img"` with an `aria-label` summary, a visible legend, and the day range under it.
- [ ] **Step 4: Run** the page test, then `npm run typecheck && npm run lint`.
- [ ] **Step 5: Commit** — `"Add the open numbers page"`.

### Task 5: Links to the page

**Files:**
- Modify: `src/components/landing/LiveProof.tsx` (a link "Platform-wide open numbers →" to `/open` beside "Inspect the records →"), `src/components/vx/SiteChrome.tsx` (Resources column: `{ href: "/open", label: "Open numbers" }` first), `src/app/sitemap.ts` (`/open` right after `/`, comment updated)
- Test: `tests/site-footer.test.tsx`, `tests/docs-content.test.ts` (sitemap order), landing test if it pins LiveProof links

- [ ] **Step 1:** Update the expectations first; run — FAIL.
- [ ] **Step 2:** Make the changes; run the three test files — PASS.
- [ ] **Step 3:** `npm run verify` — PASS.
- [ ] **Step 4: Commit** — `"Link the open numbers from the landing page, the footer and the sitemap"`.

### Task 6: Verify against production and ship

- [ ] Partner applies 0037 (`npm run db:migrate`) and adds the team (`npm run numbers -- team add <email>`); read-only probe confirms grants.
- [ ] `npm run numbers` and a local `next dev` of `/open` against production agree with a read-only SQL probe.
- [ ] PR, CI green, merge; `/open` in production 200 and equal to the probe; record in the spec §7; roadmap row T1 → DONE; arc-canteen update.
