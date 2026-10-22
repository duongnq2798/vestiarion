-- "Was this you?" (docs/superpowers/specs/2026-10-22-address-change-check-design.md AC1-AC4): when a payee's address
-- changes to a new one, the payee's billing email on file is asked, through a one-time link, whether they made the
-- change. "No, this wasn't me" freezes the payee: its address's confirmation is withdrawn, and no one can confirm it again
-- until an owner or admin unfreezes it.
--
-- address_change_checks: one open per counterparty. Only the link's SHA-256 is kept. The workspace reads its own under
-- RLS; every write goes through the functions below, run by the server's service role.
--
-- create_address_change_check(...): replaces the counterparty's open check and makes the new one, only while the address
-- asked about is still the one on file (a late ask never replaces a newer one).
-- mark_address_change_check_sent(p_check_id): the email went out, so the check shows as asked.
-- address_change_check_preview(p_token_hash): what the payee's page shows, for an open, unexpired check only.
-- answer_address_change_check(p_token_hash, p_not_me): the answer, once. "Not me" freezes the payee in the same step,
-- and withdraws its confirmation, while the address in question is still the one on file.
-- unfreeze_counterparty(p_org_id, p_counterparty_id): an owner's or admin's unfreeze, returning what it cleared; the
-- server checks the role, and puts the freeze back with restore_counterparty_freeze when its ledger entry is not written.
-- counterparties_frozen_guard: refuses any confirmation of a frozen payee's address, whoever writes it, and any change to
-- the freeze itself by the tenant role, which goes through these functions only.
--
-- Additive and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.counterparties add column if not exists frozen_at timestamptz;
alter table public.counterparties add column if not exists frozen_check_id uuid;

create table if not exists public.address_change_checks (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  counterparty_id  uuid not null,
  from_address     text not null constraint address_change_checks_from_check check (from_address ~ '^0x[0-9a-fA-F]{40}$'),
  to_address       text not null constraint address_change_checks_to_check check (to_address ~ '^0x[0-9a-fA-F]{40}$'),
  -- How the address changed: a member's edit, the payee's one-time link, or /payto on GitHub (with the login).
  via              text not null constraint address_change_checks_via_check check (via in ('member', 'payee_link', 'github')),
  github_login     text constraint address_change_checks_login_check check (github_login is null or char_length(github_login) between 1 and 39),
  -- The member whose edit changed it, when one did: they do not unfreeze it while another owner or admin can (AC4).
  changed_by       uuid references auth.users(id) on delete set null,
  -- The billing email asked: the counterparty's notice email when the address changed.
  sent_to          text not null constraint address_change_checks_sent_to_check
                        check (char_length(sent_to) between 3 and 254 and sent_to ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  token_hash       text not null
                        constraint address_change_checks_token_hash_key unique
                        constraint address_change_checks_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  -- open: waiting for an answer; confirmed: "Yes, I made this change"; disputed: "No, this wasn't me"; replaced: a newer
  -- change asked again.
  status           text not null default 'open'
                        constraint address_change_checks_status_check check (status in ('open', 'confirmed', 'disputed', 'replaced')),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  -- Set once the email went out; a check whose email did not go stays unsent, and nothing shows it as asked.
  sent_at          timestamptz,
  closed_at        timestamptz,
  constraint address_change_checks_counterparty_fkey foreign key (org_id, counterparty_id) references public.counterparties (org_id, id) on delete cascade,
  constraint address_change_checks_closed_check check ((status = 'open') = (closed_at is null)),
  constraint address_change_checks_expiry_check check (expires_at > created_at)
);

create unique index if not exists address_change_checks_one_open on public.address_change_checks (org_id, counterparty_id) where status = 'open';
create index if not exists address_change_checks_counterparty_idx on public.address_change_checks (org_id, counterparty_id, created_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'counterparties_frozen_check_fkey' and conrelid = 'public.counterparties'::regclass
  ) then
    alter table public.counterparties add constraint counterparties_frozen_check_fkey
      foreign key (frozen_check_id) references public.address_change_checks (id) on delete set null;
  end if;
end;
$$;

alter table public.address_change_checks enable row level security;
revoke all privileges on table public.address_change_checks from anon, authenticated, vestiarion_tenant;
grant select on table public.address_change_checks to vestiarion_tenant;
grant all privileges on table public.address_change_checks to service_role;

drop policy if exists tenant_isolation on public.address_change_checks;
create policy tenant_isolation on public.address_change_checks for select to vestiarion_tenant
  using (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.address_change_checks;
create policy tenant_isolation_guard on public.address_change_checks as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

-- No confirmation of a frozen payee's address, whoever writes it (AC3): withdrawing one, or unfreezing, passes. And the
-- tenant role never sets or clears a freeze itself: the functions below, which run as their owner, do.
create or replace function public.counterparties_frozen_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'vestiarion_tenant'
     and (new.frozen_at is distinct from old.frozen_at or new.frozen_check_id is distinct from old.frozen_check_id) then
    raise exception 'counterparty_freeze_locked: a payee is frozen and unfrozen through Vestiarion only';
  end if;
  if new.frozen_at is not null
     and new.address_confirmed_at is not null
     and new.address_confirmed_at is distinct from old.address_confirmed_at then
    raise exception 'counterparty_frozen: this payee is frozen until an owner or admin unfreezes it';
  end if;
  return new;
end;
$$;

drop trigger if exists counterparties_frozen_guard on public.counterparties;
create trigger counterparties_frozen_guard before update on public.counterparties
  for each row execute function public.counterparties_frozen_guard();

create or replace function public.create_address_change_check(
  p_org_id          uuid,
  p_counterparty_id uuid,
  p_from            text,
  p_to              text,
  p_via             text,
  p_github_login    text,
  p_changed_by      uuid,
  p_sent_to         text,
  p_token_hash      text,
  p_expires_at      timestamptz
) returns public.address_change_checks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.address_change_checks;
begin
  perform pg_advisory_xact_lock(hashtext('vestiarion_address_change_checks:' || p_counterparty_id::text));
  if not exists (select 1 from public.counterparties c where c.org_id = p_org_id and c.id = p_counterparty_id) then
    raise exception 'check_not_possible: no such counterparty';
  end if;
  -- Asked late, after the address changed again: the newer change's own check stands, and this one makes nothing.
  if not exists (
    select 1 from public.counterparties c
     where c.org_id = p_org_id and c.id = p_counterparty_id and lower(c.address) = lower(p_to)
  ) then
    return null;
  end if;
  update public.address_change_checks set status = 'replaced', closed_at = now()
   where org_id = p_org_id and counterparty_id = p_counterparty_id and status = 'open';
  insert into public.address_change_checks (org_id, counterparty_id, from_address, to_address, via, github_login, changed_by, sent_to, token_hash, expires_at)
  values (p_org_id, p_counterparty_id, p_from, p_to, p_via, p_github_login, p_changed_by, p_sent_to, p_token_hash, p_expires_at)
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.mark_address_change_check_sent(p_check_id uuid) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int;
begin
  update public.address_change_checks set sent_at = now() where id = p_check_id and sent_at is null;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

create or replace function public.address_change_check_preview(p_token_hash text)
returns table (org_name text, counterparty_name text, from_address text, to_address text, via text, github_login text,
               created_at timestamptz, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name, c.name, k.from_address, k.to_address, k.via, k.github_login, k.created_at, k.expires_at
    from public.address_change_checks k
    join public.orgs o on o.id = k.org_id
    join public.counterparties c on c.org_id = k.org_id and c.id = k.counterparty_id
   where k.token_hash = p_token_hash and k.status = 'open' and k.expires_at > now()
$$;

create or replace function public.answer_address_change_check(p_token_hash text, p_not_me boolean)
returns table (outcome text, check_id uuid, org_id uuid, counterparty_id uuid, from_address text, to_address text,
               org_name text, org_slug text, counterparty_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check public.address_change_checks;
  v_frozen int;
  v_org public.orgs;
  v_name text;
begin
  select * into v_check from public.address_change_checks k
   where k.token_hash = p_token_hash and k.status = 'open' and k.expires_at > now()
   for update;
  if not found then
    return query select 'not_valid'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  select * into v_org from public.orgs o where o.id = v_check.org_id;
  select c.name into v_name from public.counterparties c where c.org_id = v_check.org_id and c.id = v_check.counterparty_id;
  if not p_not_me then
    update public.address_change_checks set status = 'confirmed', closed_at = now() where id = v_check.id;
    return query select 'confirmed'::text, v_check.id, v_check.org_id, v_check.counterparty_id, v_check.from_address, v_check.to_address,
                        v_org.name, v_org.slug, v_name;
    return;
  end if;
  update public.address_change_checks set status = 'disputed', closed_at = now() where id = v_check.id;
  -- Frozen only while the address in question is still the one on file; its confirmation withdrawn with it.
  update public.counterparties c
     set frozen_at = coalesce(c.frozen_at, now()), frozen_check_id = v_check.id, address_confirmed_at = null
   where c.org_id = v_check.org_id and c.id = v_check.counterparty_id and lower(c.address) = lower(v_check.to_address);
  get diagnostics v_frozen = row_count;
  return query select (case when v_frozen > 0 then 'frozen' else 'disputed' end)::text,
                      v_check.id, v_check.org_id, v_check.counterparty_id, v_check.from_address, v_check.to_address,
                      v_org.name, v_org.slug, v_name;
end;
$$;

create or replace function public.unfreeze_counterparty(p_org_id uuid, p_counterparty_id uuid)
returns table (frozen_at timestamptz, frozen_check_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
  v_check uuid;
begin
  select c.frozen_at, c.frozen_check_id into v_at, v_check from public.counterparties c
   where c.org_id = p_org_id and c.id = p_counterparty_id and c.frozen_at is not null
   for update;
  if not found then
    return;
  end if;
  update public.counterparties c set frozen_at = null, frozen_check_id = null
   where c.org_id = p_org_id and c.id = p_counterparty_id;
  return query select v_at, v_check;
end;
$$;

-- An unfreeze whose ledger entry could not be written is put back, so no unfreeze stands unrecorded (AC4).
create or replace function public.restore_counterparty_freeze(p_org_id uuid, p_counterparty_id uuid, p_frozen_at timestamptz, p_check_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int;
begin
  update public.counterparties c set frozen_at = p_frozen_at, frozen_check_id = p_check_id, address_confirmed_at = null
   where c.org_id = p_org_id and c.id = p_counterparty_id and c.frozen_at is null;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

revoke execute on function public.create_address_change_check(uuid, uuid, text, text, text, text, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.create_address_change_check(uuid, uuid, text, text, text, text, uuid, text, text, timestamptz) to service_role;
revoke execute on function public.mark_address_change_check_sent(uuid) from public, anon, authenticated;
grant execute on function public.mark_address_change_check_sent(uuid) to service_role;
revoke execute on function public.address_change_check_preview(text) from public, anon, authenticated;
grant execute on function public.address_change_check_preview(text) to service_role;
revoke execute on function public.answer_address_change_check(text, boolean) from public, anon, authenticated;
grant execute on function public.answer_address_change_check(text, boolean) to service_role;
revoke execute on function public.unfreeze_counterparty(uuid, uuid) from public, anon, authenticated;
grant execute on function public.unfreeze_counterparty(uuid, uuid) to service_role;
revoke execute on function public.restore_counterparty_freeze(uuid, uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.restore_counterparty_freeze(uuid, uuid, timestamptz, uuid) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.restore_counterparty_freeze(uuid, uuid, timestamptz, uuid);
-- drop function if exists public.unfreeze_counterparty(uuid, uuid);
-- drop function if exists public.answer_address_change_check(text, boolean);
-- drop function if exists public.address_change_check_preview(text);
-- drop function if exists public.mark_address_change_check_sent(uuid);
-- drop function if exists public.create_address_change_check(uuid, uuid, text, text, text, text, uuid, text, text, timestamptz);
-- drop trigger if exists counterparties_frozen_guard on public.counterparties;
-- drop function if exists public.counterparties_frozen_guard();
-- alter table public.counterparties drop constraint if exists counterparties_frozen_check_fkey;
-- drop table if exists public.address_change_checks;
-- alter table public.counterparties drop column if exists frozen_check_id;
-- alter table public.counterparties drop column if exists frozen_at;
