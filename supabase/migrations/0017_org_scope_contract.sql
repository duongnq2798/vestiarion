-- Contract: every write now names its organization, so the transitional parts
-- of 0015 and 0016 go.
--
-- RUN ONLY AFTER the code that passes p_org_id is live. Before that, this
-- breaks every append, every simulated day and every payment claim — and,
-- once org_id has no default, every insert the old code makes too (NOT NULL
-- org_id). Until then: `npm run db:migrate -- --through 0016`.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

drop function if exists public.append_ledger_entry(text, text, text, text, jsonb, text, text, text);
drop function if exists public.advance_sim_day();
drop function if exists public.claim_payment_intent(text);
drop function if exists public.ledger_entries_for_targets(text[], text[]);

-- The per-organization append, without the global lock that protected the
-- deploy window. Two organizations now append concurrently.
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

-- create or replace keeps existing grants, but state it: only the server calls this.
revoke execute on function public.append_ledger_entry(uuid, text, text, text, text, jsonb, text, text, text)
  from public, anon, authenticated;
grant execute on function public.append_ledger_entry(uuid, text, text, text, text, jsonb, text, text, text)
  to service_role;

do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'counterparties', 'invoices', 'milestones', 'treasury_actions', 'compliance_checks',
    'forecasts', 'ledger_entries', 'payment_intents', 'cycle_runs', 'cycle_snapshots'
  ]
  loop
    execute format('alter table public.%I alter column org_id drop default', t);
  end loop;
end $$;

-- sim_clock keeps its founding default: 0001, replayed on every db:migrate
-- run, inserts its bootstrap row without naming org_id, and Postgres checks
-- NOT NULL before ON CONFLICT. Every real write names its organization —
-- advance_sim_day(p_org_id) and the DAL's stamped upsert.

-- sim_clock.id stays: 0001, which db:migrate replays on every run, inserts into
-- it and creates advance_sim_day() over it. 0016 made it nullable and unique.

-- Rollback (restores the defaults and the old signatures; run before reverting the code):
-- do $$ declare t text; begin foreach t in array array['accounts','counterparties','invoices','milestones',
--   'treasury_actions','compliance_checks','forecasts','ledger_entries','payment_intents','cycle_runs',
--   'cycle_snapshots','sim_clock'] loop execute format('alter table public.%I alter column org_id set default '
--   '''00000000-0000-4000-8000-000000000001''', t); end loop; end $$;
-- then `npm run db:migrate -- --through 0016`, which replays 0001–0016: the four
-- old signatures with their revokes, and 0016's append that also takes the
-- global lock, so old and new deployments serialise during the switch.
-- Only while the founding organization is the only one with rows — 0014's
-- append links to the newest row of any organization, and the old code reads
-- every tenant table unfiltered. A later plain db:migrate re-applies 0017.
