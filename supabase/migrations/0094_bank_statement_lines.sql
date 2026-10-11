-- What the business paid, from its bank statement (docs/superpowers/specs/2026-10-10-bank-statement-design.md B9, B10).
--
-- bank_statement_lines: a line of a bank statement, kept when it records what the business paid for a bill: the account
-- as the person named it, the booking and value days, the signed amount (money out negative) and its currency, the
-- description, payee, reference and running balance as the bank wrote them, the line of the file, who imported it and
-- when. Only the lines used are kept; the rest of a statement is read and never stored. line_hash (SHA-256 of the
-- account, the day, the amount, the currency, the text, the balance and the line's place among those that look the
-- same) is unique per workspace, so a re-import of the same or an overlapping statement finds the lines it used. A line
-- is a fact read from a bank: the tenant role may only read and insert it.
--
-- payment_actuals gains the source `statement` and statement_line_id: a record from a statement names its line, in the
-- same workspace, one record per line, and only a statement's payment names one.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.bank_statement_lines (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  account     text not null constraint bank_statement_lines_account_check check (char_length(account) between 1 and 80),
  booked_on   date not null,
  value_on    date,
  amount      numeric(24, 6) not null constraint bank_statement_lines_amount_check check (amount <> 0),
  currency    text not null constraint bank_statement_lines_currency_check check (currency ~ '^[A-Z]{3}$' or currency in ('USDC', 'EURC')),
  description text not null constraint bank_statement_lines_description_check check (char_length(description) <= 500),
  payee       text constraint bank_statement_lines_payee_check check (payee is null or char_length(payee) between 1 and 200),
  reference   text constraint bank_statement_lines_reference_check check (reference is null or char_length(reference) between 1 and 140),
  balance     numeric(24, 6),
  file_line   integer not null constraint bank_statement_lines_file_line_check check (file_line >= 1),
  line_hash   text not null constraint bank_statement_lines_hash_check check (line_hash ~ '^[0-9a-f]{64}$'),
  imported_by uuid references auth.users(id) on delete set null,
  imported_at timestamptz not null default now(),
  constraint bank_statement_lines_org_id_key unique (org_id, id),
  constraint bank_statement_lines_line_hash_key unique (org_id, line_hash)
);

alter table public.bank_statement_lines enable row level security;
revoke all privileges on table public.bank_statement_lines from anon, authenticated, vestiarion_tenant;
grant select, insert on table public.bank_statement_lines to vestiarion_tenant;
grant all privileges on table public.bank_statement_lines to service_role;

drop policy if exists tenant_isolation on public.bank_statement_lines;
create policy tenant_isolation on public.bank_statement_lines for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.bank_statement_lines;
create policy tenant_isolation_guard on public.bank_statement_lines as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

-- A record from a statement names its line.
alter table public.payment_actuals add column if not exists statement_line_id uuid;

alter table public.payment_actuals drop constraint if exists payment_actuals_source_check;
alter table public.payment_actuals add constraint payment_actuals_source_check check (source in ('form', 'csv', 'statement'));

alter table public.payment_actuals drop constraint if exists payment_actuals_statement_line_fkey;
alter table public.payment_actuals add constraint payment_actuals_statement_line_fkey
  foreign key (org_id, statement_line_id) references public.bank_statement_lines (org_id, id);

-- A record has a line exactly when it is a payment from a statement.
alter table public.payment_actuals drop constraint if exists payment_actuals_statement_line_check;
alter table public.payment_actuals add constraint payment_actuals_statement_line_check check (
  (statement_line_id is not null) = (source = 'statement' and outcome = 'paid')
);

-- One record per line.
create unique index if not exists payment_actuals_one_per_statement_line on public.payment_actuals (org_id, statement_line_id)
  where statement_line_id is not null;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop index if exists public.payment_actuals_one_per_statement_line;
-- alter table public.payment_actuals drop constraint if exists payment_actuals_statement_line_check;
-- alter table public.payment_actuals drop constraint if exists payment_actuals_statement_line_fkey;
-- alter table public.payment_actuals drop column if exists statement_line_id;
-- alter table public.payment_actuals drop constraint if exists payment_actuals_source_check;
-- alter table public.payment_actuals add constraint payment_actuals_source_check check (source in ('form', 'csv'));
-- drop table if exists public.bank_statement_lines;
