-- Currency provenance and multi-currency planning (docs/superpowers/specs/2026-10-13-currency-provenance-design.md).
--
-- Reporting and planning only: payments still settle in USDC (or EURC on Arc testnet), and nothing that decides or
-- pays reads these tables. A bill already keeps its own amount, currency and the rate it was converted at
-- (invoices.original_*, 0084); a deal, a CRM deal, an accounting tool's bill and a recorded payment keep their own amount
-- and currency. What was missing is added here.
--
-- reporting_currencies: one row per workspace, the currency its reports and plans total in: USD, EUR, SGD, JPY, KRW,
-- PHP or MYR. Who set it and when. The tenant role reads, adds and changes it; the app signs each change.
--
-- cash_scenario_versions: a saved cash scenario. A version is never changed: a change is the next version of the same
-- scenario, numbered one after its last (checked on insert). The levers and the rates a person typed, as they were
-- saved, and the reporting currency then. The tenant role reads and adds.
--
-- fx_rates: every rate the workspace used, with its kind (a feed's reference rate, a provider's quote, the books'
-- accounting rate, or a rate a person typed into a saved scenario), its source, when its source published it and when
-- it was recorded. One row per kind, source, pair and publication. A typed rate names its scenario version. The tenant
-- role reads and adds; a rate is never changed.
--
-- fx_variances: on a paid bill converted at a rate, what the transfer carried less what the same part of the bill was
-- worth on the payment day, at the reference rate recorded for that day (published at most 36 hours before the payment).
-- Once per bill, with every input copied. The tenant role reads and adds.
--
-- Every foreign key is composite with org_id. Additive, and idempotent throughout: scripts/migrate.ts re-runs every
-- migration each time. It redefines no earlier migration's object.

create table if not exists public.reporting_currencies (
  org_id    uuid primary key references public.orgs(id) on delete cascade,
  currency  text not null constraint reporting_currencies_currency_check check (currency in ('USD', 'EUR', 'SGD', 'JPY', 'KRW', 'PHP', 'MYR')),
  set_by    uuid references auth.users(id) on delete set null,
  set_at    timestamptz not null default now()
);

create table if not exists public.cash_scenario_versions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.orgs(id) on delete cascade,
  scenario_id         uuid not null,
  version             integer not null constraint cash_scenario_versions_version_check check (version between 1 and 10000),
  name                text not null constraint cash_scenario_versions_name_check check (char_length(btrim(name)) between 1 and 80),
  levers              jsonb not null constraint cash_scenario_versions_levers_check check (jsonb_typeof(levers) = 'object' and octet_length(levers::text) <= 16384),
  rates               jsonb not null default '[]'::jsonb constraint cash_scenario_versions_rates_check check (jsonb_typeof(rates) = 'array' and octet_length(rates::text) <= 8192),
  reporting_currency  text constraint cash_scenario_versions_reporting_check check (reporting_currency is null or reporting_currency in ('USD', 'EUR', 'SGD', 'JPY', 'KRW', 'PHP', 'MYR')),
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint cash_scenario_versions_org_id_key unique (org_id, id),
  constraint cash_scenario_versions_version_key unique (org_id, scenario_id, version)
);

create index if not exists cash_scenario_versions_newest on public.cash_scenario_versions (org_id, created_at desc);

create table if not exists public.fx_rates (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  base                 text not null constraint fx_rates_base_check check (base ~ '^[A-Z]{3,4}$'),
  quote                text not null constraint fx_rates_quote_check check (quote ~ '^[A-Z]{3,4}$'),
  rate                 numeric(30, 12) not null constraint fx_rates_rate_check check (rate > 0),
  kind                 text not null constraint fx_rates_kind_check check (kind in ('reference', 'quote', 'accounting', 'manual')),
  source               text not null constraint fx_rates_source_check check (char_length(source) between 1 and 80),
  published_at         timestamptz not null,
  recorded_at          timestamptz not null default now(),
  recorded_by          uuid references auth.users(id) on delete set null,
  scenario_version_id  uuid,
  constraint fx_rates_pair_check check (base <> quote),
  constraint fx_rates_manual_scenario check (scenario_version_id is null or kind = 'manual'),
  constraint fx_rates_org_id_key unique (org_id, id),
  constraint fx_rates_published_once unique (org_id, kind, source, base, quote, published_at),
  constraint fx_rates_scenario_fkey foreign key (org_id, scenario_version_id) references public.cash_scenario_versions (org_id, id) on delete cascade
);

create index if not exists fx_rates_newest on public.fx_rates (org_id, kind, quote, published_at desc);

create table if not exists public.fx_variances (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.orgs(id) on delete cascade,
  invoice_id        uuid not null,
  currency          text not null constraint fx_variances_currency_check check (currency ~ '^[A-Z]{3}$' and currency <> 'USD'),
  paid_currency     text not null constraint fx_variances_paid_currency_check check (paid_currency = 'USDC'),
  paid_amount       numeric(20, 6) not null constraint fx_variances_paid_amount_check check (paid_amount > 0),
  paid_at           timestamptz not null,
  covered_amount    numeric(24, 6) not null constraint fx_variances_covered_amount_check check (covered_amount > 0),
  decision_rate     numeric(30, 12) not null constraint fx_variances_decision_rate_check check (decision_rate > 0),
  decision_source   text not null constraint fx_variances_decision_source_check check (char_length(decision_source) between 1 and 80),
  decision_at       timestamptz not null,
  payment_rate_id   uuid not null,
  payment_rate      numeric(30, 12) not null constraint fx_variances_payment_rate_check check (payment_rate > 0),
  payment_source    text not null constraint fx_variances_payment_source_check check (char_length(payment_source) between 1 and 80),
  payment_rate_at   timestamptz not null,
  value_at_payment  numeric(20, 6) not null constraint fx_variances_value_check check (value_at_payment >= 0),
  variance          numeric(20, 6) not null,
  recorded_at       timestamptz not null default now(),
  constraint fx_variances_adds_up check (variance = paid_amount - value_at_payment),
  -- The rate in force when the bill was paid: published before the payment, and at most 36 hours before it.
  constraint fx_variances_rate_in_force check (payment_rate_at <= paid_at and paid_at - payment_rate_at <= interval '36 hours'),
  constraint fx_variances_invoice_key unique (org_id, invoice_id),
  constraint fx_variances_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade,
  constraint fx_variances_rate_fkey foreign key (org_id, payment_rate_id) references public.fx_rates (org_id, id) on delete cascade
);

-- Row level security as every tenant table: a permissive policy and a restrictive guard, both on request_org_id().
do $$
declare
  t text;
begin
  foreach t in array array['reporting_currencies', 'cash_scenario_versions', 'fx_rates', 'fx_variances'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all privileges on table public.%I from anon, authenticated, vestiarion_tenant', t);
    execute format('grant all privileges on table public.%I to service_role', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format(
      'create policy tenant_isolation on public.%I for all to vestiarion_tenant
         using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()))', t);
    execute format('drop policy if exists tenant_isolation_guard on public.%I', t);
    execute format(
      'create policy tenant_isolation_guard on public.%I as restrictive for all to vestiarion_tenant
         using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()))', t);
  end loop;
end $$;

grant select, insert on table public.reporting_currencies to vestiarion_tenant;
grant update (currency, set_by, set_at) on table public.reporting_currencies to vestiarion_tenant;
-- A saved version, a rate and a variance are never changed in place.
grant select, insert on table public.cash_scenario_versions to vestiarion_tenant;
grant select, insert on table public.fx_rates to vestiarion_tenant;
grant select, insert on table public.fx_variances to vestiarion_tenant;

-- A version follows its scenario's last: version 1 starts a scenario, version n needs version n - 1 of it. The unique
-- key refuses two saves of the same number, so two people saving at once never fork a scenario.
create or replace function public.cash_scenario_versions_in_order()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.version = 1 then
    if exists (select 1 from public.cash_scenario_versions v where v.org_id = new.org_id and v.scenario_id = new.scenario_id) then
      raise exception 'cash_scenario_started' using detail = 'That scenario has versions already: save the next one.';
    end if;
  elsif not exists (
    select 1 from public.cash_scenario_versions v where v.org_id = new.org_id and v.scenario_id = new.scenario_id and v.version = new.version - 1
  ) then
    raise exception 'cash_scenario_version_gap' using detail = 'A version follows the scenario''s last one.';
  end if;
  return new;
end;
$$;

revoke execute on function public.cash_scenario_versions_in_order() from public, anon, authenticated;

drop trigger if exists cash_scenario_versions_in_order on public.cash_scenario_versions;
create trigger cash_scenario_versions_in_order
  before insert on public.cash_scenario_versions
  for each row execute function public.cash_scenario_versions_in_order();

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop table if exists public.fx_variances;
-- drop table if exists public.fx_rates;
-- drop trigger if exists cash_scenario_versions_in_order on public.cash_scenario_versions;
-- drop function if exists public.cash_scenario_versions_in_order();
-- drop table if exists public.cash_scenario_versions;
-- drop table if exists public.reporting_currencies;
