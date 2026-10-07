-- Shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S1, S3, S6, S7, S9).
--
-- 1. shadow_modes: one row per workspace in shadow mode, in the business's own currency. The agent reads it once per
--    stage: a payment that passes every check is held for a person to agree. An owner turns it on and off through
--    the app, which records each change in the ledger.
-- 2. decision_verdicts: a person's verdict on one decision of the agent's, named by its ledger entry, once.
-- 3. invoices.original_*: the bill's own currency and amount, the rate it was converted at, where the rate came from
--    and when: all five or none. amount and currency stay the USDC figure everything else reads.
-- 4. counterparties.mirror_wallet_id: the Circle wallet Vestiarion made for a supplier with no Arc address, on Arc
--    testnet, in shadow mode.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.shadow_modes (
  org_id     uuid primary key references public.orgs(id) on delete cascade,
  currency   text not null constraint shadow_modes_currency_check check (currency ~ '^[A-Z]{3}$'),
  started_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now()
);

alter table public.shadow_modes enable row level security;
revoke all privileges on table public.shadow_modes from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.shadow_modes to vestiarion_tenant;
grant all privileges on table public.shadow_modes to service_role;

drop policy if exists tenant_isolation on public.shadow_modes;
create policy tenant_isolation on public.shadow_modes for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.shadow_modes;
create policy tenant_isolation_guard on public.shadow_modes as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

create table if not exists public.decision_verdicts (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  entry_seq    bigint not null,
  subject      text not null constraint decision_verdicts_subject_check check (subject in ('invoice', 'milestone')),
  subject_id   uuid not null,
  agent_action text not null,
  verdict      text not null constraint decision_verdicts_verdict_check check (verdict in ('agree', 'disagree')),
  reason       text constraint decision_verdicts_reason_check check (reason is null or char_length(reason) between 1 and 280),
  decided_by   uuid references auth.users(id) on delete set null,
  decided_at   timestamptz not null default now(),
  constraint decision_verdicts_org_id_entry_seq_key unique (org_id, entry_seq)
);

create index if not exists decision_verdicts_subject on public.decision_verdicts (org_id, subject, subject_id);

alter table public.decision_verdicts enable row level security;
revoke all privileges on table public.decision_verdicts from anon, authenticated, vestiarion_tenant;
grant select, insert on table public.decision_verdicts to vestiarion_tenant;
grant all privileges on table public.decision_verdicts to service_role;

drop policy if exists tenant_isolation on public.decision_verdicts;
create policy tenant_isolation on public.decision_verdicts for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.decision_verdicts;
create policy tenant_isolation_guard on public.decision_verdicts as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

alter table public.invoices add column if not exists original_currency text;
alter table public.invoices add column if not exists original_amount numeric(24, 6);
alter table public.invoices add column if not exists fx_rate numeric(24, 12);
alter table public.invoices add column if not exists fx_source text;
alter table public.invoices add column if not exists fx_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.invoices'::regclass and conname = 'invoices_original_complete') then
    alter table public.invoices add constraint invoices_original_complete check (
      (original_currency is null and original_amount is null and fx_rate is null and fx_source is null and fx_at is null)
      or (original_currency is not null and original_amount is not null and fx_rate is not null and fx_source is not null and fx_at is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.invoices'::regclass and conname = 'invoices_original_currency_check') then
    alter table public.invoices add constraint invoices_original_currency_check check (
      original_currency is null or (original_currency ~ '^[A-Z]{3}$' and original_currency not in ('USDC', 'EURC'))
    );
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.invoices'::regclass and conname = 'invoices_original_amount_check') then
    alter table public.invoices add constraint invoices_original_amount_check check (original_amount is null or original_amount > 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.invoices'::regclass and conname = 'invoices_fx_rate_check') then
    alter table public.invoices add constraint invoices_fx_rate_check check (fx_rate is null or fx_rate > 0);
  end if;
end $$;

alter table public.counterparties add column if not exists mirror_wallet_id text;
