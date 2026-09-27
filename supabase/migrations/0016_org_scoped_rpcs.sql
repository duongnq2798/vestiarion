-- One ledger chain, one simulated clock and one set of payment intents per
-- organization.
--
-- ADDITIVE. Every function gains an overload that takes p_org_id; the old
-- signatures stay so the code deployed before this change keeps working until
-- 0017 removes them. PostgREST resolves an RPC by its argument names, so a
-- call without p_org_id reaches the old function and a call with it reaches
-- the new one; neither can reach the other by accident.
--
-- While both exist, the new append also takes the old global lock. An old
-- deployment appending to the founding chain and a new one appending at the
-- same moment therefore serialise instead of reading the same prev_hash and
-- forking the chain. 0017 drops the global lock with the old function.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

-- ------------------------------------------------------------- sim clock
--
-- org_id becomes the primary key so every organization gets its own row.
-- id is kept — not dropped — because 0001_init.sql is never edited and
-- scripts/migrate.ts replays it on every invocation; its bootstrap insert,
-- `insert into sim_clock (id, current_day) values (1, 0) on conflict (id)
-- do nothing`, needs a real unique target on id for that on conflict clause
-- to remain valid Postgres. id therefore stays as a vestigial, nullable,
-- unique column: the founding row keeps id = 1 (written by 0001 before this
-- migration ever ran), and every new organization's row gets id = null — a
-- unique constraint permits any number of nulls, and 0001's `check (id = 1)`
-- is satisfied vacuously by null, so it does not reject the insert either.
-- The old, id-scoped `advance_sim_day()` therefore keeps updating exactly
-- the founding row, and never a new organization's.
alter table public.sim_clock
  add column if not exists org_id uuid not null
  default '00000000-0000-4000-8000-000000000001'
  references public.orgs(id) on delete cascade;

do $$
begin
  if exists (
    select 1
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid = 'public.sim_clock'::regclass
       and c.contype = 'p'
       and a.attname = 'id'
  ) then
    alter table public.sim_clock drop constraint sim_clock_pkey;
    alter table public.sim_clock add primary key (org_id);
    alter table public.sim_clock add constraint sim_clock_id_key unique (id);
  end if;
end $$;

-- Idempotent on their own (dropping an already-absent default, or already-not-null
-- flag, is a no-op): a new organization's row must not be forced to id = 1.
alter table public.sim_clock alter column id drop default;
alter table public.sim_clock alter column id drop not null;

-- ---------------------------------------------------------------- ledger
create or replace function public.append_ledger_entry(
  p_org_id         uuid,
  p_actor          text,
  p_domain         text,
  p_action         text,
  p_summary        text,
  p_detail         jsonb,
  p_body_hash      text,
  p_signature      text,
  p_signing_key_id text default null
) returns ledger_entries
language plpgsql
as $$
declare
  v_prev_hash text;
  v_hash      text;
  v_row       ledger_entries;
begin
  if p_org_id is null then
    raise exception 'append_ledger_entry: p_org_id is required';
  end if;

  -- TRANSITIONAL (dropped by 0017): the lock the old signature takes.
  perform pg_advisory_xact_lock(hashtext('vestiarion_ledger'));
  perform pg_advisory_xact_lock(hashtext('vestiarion_ledger:' || p_org_id::text));

  select hash into v_prev_hash
    from ledger_entries
   where org_id = p_org_id
   order by seq desc
   limit 1;
  v_prev_hash := coalesce(v_prev_hash, repeat('0', 64));

  v_hash := encode(digest(v_prev_hash || p_body_hash || p_signature, 'sha256'), 'hex');

  insert into ledger_entries (org_id, actor, domain, action, summary, detail,
                              body_hash, signature, prev_hash, hash, signing_key_id)
  values (p_org_id, p_actor, p_domain, p_action, p_summary, coalesce(p_detail, '{}'::jsonb),
          p_body_hash, p_signature, v_prev_hash, v_hash, p_signing_key_id)
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.ledger_entries_for_targets(
  p_org_id        uuid,
  p_invoice_ids   text[] default '{}'::text[],
  p_milestone_ids text[] default '{}'::text[]
) returns setof public.ledger_entries
language sql
stable
set search_path = public
as $$
  select entry.*
    from public.ledger_entries entry
   where entry.org_id = p_org_id
     and (entry.detail ->> 'invoiceId' = any(p_invoice_ids)
          or entry.detail ->> 'milestoneId' = any(p_milestone_ids))
   order by entry.seq desc;
$$;

revoke execute on function public.ledger_entries_for_targets(uuid, text[], text[])
  from public, anon, authenticated;
grant execute on function public.ledger_entries_for_targets(uuid, text[], text[])
  to service_role;

-- ----------------------------------------------------------- sim clock rpc
create or replace function public.advance_sim_day(p_org_id uuid) returns integer
language sql
as $$
  insert into public.sim_clock as clock (org_id, current_day)
  values (p_org_id, 1)
  on conflict (org_id) do update set current_day = clock.current_day + 1
  returning current_day;
$$;

-- ------------------------------------------------------- payment intents
create or replace function public.claim_payment_intent(p_org_id uuid, p_idempotency_key text)
returns public.payment_intents
language plpgsql
set search_path = ''
as $$
declare
  claimed public.payment_intents;
begin
  update public.payment_intents
     set status = 'submitting',
         attempt_count = attempt_count + 1,
         last_error = null,
         updated_at = now()
   where org_id = p_org_id
     and idempotency_key = p_idempotency_key
     and (
       status in ('created', 'failed')
       or (status = 'submitting' and updated_at < now() - interval '2 minutes')
     )
  returning * into claimed;

  return claimed;
end;
$$;

revoke execute on function public.claim_payment_intent(uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_payment_intent(uuid, text)
  to service_role;

-- Rollback (before 0017 only; the old functions are still in place):
-- drop function if exists public.append_ledger_entry(uuid, text, text, text, text, jsonb, text, text, text);
-- drop function if exists public.ledger_entries_for_targets(uuid, text[], text[]);
-- drop function if exists public.advance_sim_day(uuid);
-- drop function if exists public.claim_payment_intent(uuid, text);
-- update public.sim_clock set id = 1 where org_id = '00000000-0000-4000-8000-000000000001';
-- alter table public.sim_clock alter column id set not null;
-- alter table public.sim_clock alter column id set default 1;
-- alter table public.sim_clock drop constraint sim_clock_id_key;
-- alter table public.sim_clock drop constraint sim_clock_pkey;
-- alter table public.sim_clock add primary key (id);
-- alter table public.sim_clock drop column org_id;
