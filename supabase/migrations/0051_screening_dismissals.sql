-- Not this person (docs/superpowers/specs/2026-10-01-dismiss-screening-match-design.md §4).
--
-- counterparties.risk_entity_id: the screening service's id for the entity
-- the current verdict matched, written by every screen, null when nothing (or
-- the bundled list, which has no ids) matched. The counterparty card offers a
-- dismissal for exactly that entity (R4, R6).
--
-- screening_dismissals: a match a person reviewed and dismissed as not the
-- same person (R1-R3). Screening skips the dismissed entity for that
-- counterparty while its name is still the one screened (R2). One per
-- counterparty and entity; it goes with its counterparty; seen and written
-- only by its own workspace.

alter table public.counterparties add column if not exists risk_entity_id text;

create table if not exists public.screening_dismissals (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs(id) on delete cascade,
  counterparty_id    uuid not null,
  matched_entity_id  text not null check (char_length(matched_entity_id) between 1 and 200),
  matched_caption    text,
  matched_score      numeric(5, 3),
  screened_name      text not null,
  reason             text not null constraint screening_dismissals_reason_check check (char_length(btrim(reason)) between 3 and 280),
  dismissed_by       uuid references auth.users(id) on delete set null,
  dismissed_at       timestamptz not null default now(),
  constraint screening_dismissals_entity_key unique (org_id, counterparty_id, matched_entity_id),
  constraint screening_dismissals_counterparty_fkey foreign key (org_id, counterparty_id)
    references public.counterparties (org_id, id) on delete cascade
);

alter table public.screening_dismissals enable row level security;
revoke all privileges on table public.screening_dismissals from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.screening_dismissals to vestiarion_tenant;
grant all privileges on table public.screening_dismissals to service_role;

drop policy if exists tenant_isolation on public.screening_dismissals;
create policy tenant_isolation on public.screening_dismissals for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.screening_dismissals;
create policy tenant_isolation_guard on public.screening_dismissals as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop table if exists public.screening_dismissals;
-- alter table public.counterparties drop column if exists risk_entity_id;
