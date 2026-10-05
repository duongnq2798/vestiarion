-- Payment integrity (docs/superpowers/specs/2026-10-05-payment-integrity-design.md I1–I3): what the two-approvals review
-- left. Idempotent: scripts/migrate.ts re-runs every migration each time, and this file runs after 0076, whose two
-- function definitions it supersedes. It does not touch append_ledger_entry or the ledger's grants.

-- I1: whoever entered a payable may claim its approval only on another person's open approval of this payment, of the
-- same amount and currency, by someone who may still approve payments (approvers_among). Otherwise as in 0076.
create or replace function public.claim_invoice_decision(
  p_org_id uuid, p_invoice_id uuid, p_by uuid, p_decision text
) returns public.invoices
language plpgsql
set search_path = ''
as $$
declare
  v public.invoices;
begin
  if p_decision is null or p_decision not in ('approve', 'reject', 'return') then
    raise exception 'invalid_decision: % is not approve, reject or return', p_decision;
  end if;

  update public.invoices as i
     set status = 'processing', reviewed_by = p_by, reviewed_at = now()
   where i.id = p_invoice_id and i.org_id = p_org_id and i.direction = 'payable'
     and (i.status in ('held', 'flagged', 'awaiting_info')
          or (i.status = 'processing' and coalesce(i.reviewed_at, '-infinity'::timestamptz) < now() - interval '10 minutes'))
     and (p_decision <> 'approve' or i.created_by is distinct from p_by or public.sole_approver(p_org_id, p_by)
          or exists (
            select 1 from public.payment_approvals a
             where a.org_id = p_org_id and a.source_type = 'invoice' and a.source_id = p_invoice_id
               and a.approved_by <> p_by and a.used_at is null
               and a.amount = i.amount and a.currency = coalesce(i.currency, 'USDC')
               and a.approved_by = any(public.approvers_among(p_org_id, array[a.approved_by]))))
  returning i.* into v;
  if found then
    return v;
  end if;

  select * into v from public.invoices where id = p_invoice_id and org_id = p_org_id and direction = 'payable';
  if not found then
    raise exception 'invoice_not_found: no payable with that id in this organization';
  end if;
  if p_decision = 'approve' and v.created_by = p_by and not public.sole_approver(p_org_id, p_by) and (
       v.status in ('held', 'flagged', 'awaiting_info')
       or (v.status = 'processing' and coalesce(v.reviewed_at, '-infinity'::timestamptz) < now() - interval '10 minutes')
     ) then
    raise exception 'self_approval: the person who created an invoice cannot approve it';
  end if;
  raise exception 'already_decided: the invoice is % now', v.status;
end;
$$;

revoke execute on function public.claim_invoice_decision(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_invoice_decision(uuid, uuid, uuid, text) to vestiarion_tenant, service_role;

-- I2: null for another workspace than the token's, which the app refuses rather than reading as "no one else can
-- approve"; a null in the list is left out rather than making every comparison unknown.
create or replace function public.approvers_besides(p_org_id uuid, p_excluded uuid[]) returns integer
language sql stable
security definer
set search_path = ''
as $$
  select case
    when public.request_org_id() is null or p_org_id = public.request_org_id() then (
      select count(*)::integer from public.memberships
       where org_id = p_org_id and role in ('owner', 'admin', 'approver')
         and not (user_id = any(array_remove(coalesce(p_excluded, '{}'::uuid[]), null))))
    else null
  end
$$;

revoke execute on function public.approvers_besides(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.approvers_besides(uuid, uuid[]) to vestiarion_tenant, service_role;

-- I3: a request's insert into the ledger must link the chain exactly as append_ledger_entry links it. The tenant may call
-- that function, so it gains nothing by inserting directly; this makes sure a direct insert, from a bug or a stolen
-- request token, cannot add an entry that no chain step links. The check is a trigger, not a revoked grant and a definer
-- function: the migration runner replays 0016–0018 before this file on every run, and their append (as its caller) and
-- grant would otherwise leave tenant appends failing until this file ran again. Each step takes the workspace's ledger
-- lock (the same key as append_ledger_entry's, so the two are one queue), reads the last entry, and checks the previous
-- hash and the hash: sha256 of the text, as pgcrypto's digest() in append_ledger_entry computes it. It stamps the time,
-- as the function does through the column default. The platform's own roles (migrations, the service role) write as
-- before.
create or replace function public.ledger_entries_linked() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_head text;
begin
  if current_user <> 'vestiarion_tenant' then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('vestiarion_ledger:' || new.org_id::text));
  select e.hash into v_head
    from public.ledger_entries e
   where e.org_id = new.org_id
   order by e.seq desc
   limit 1;
  v_head := coalesce(v_head, pg_catalog.repeat('0', 64));
  if new.prev_hash is distinct from v_head
     or new.hash is distinct from pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(new.prev_hash || new.body_hash || new.signature, 'UTF8')), 'hex') then
    raise exception 'ledger_entries: an entry must link the chain as append_ledger_entry links it';
  end if;
  new.ts := pg_catalog.now();
  return new;
end;
$$;

revoke execute on function public.ledger_entries_linked() from public, anon, authenticated;

drop trigger if exists ledger_entries_linked on public.ledger_entries;
create trigger ledger_entries_linked before insert on public.ledger_entries
  for each row execute function public.ledger_entries_linked();

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop trigger if exists ledger_entries_linked on public.ledger_entries;
-- drop function if exists public.ledger_entries_linked();
-- then re-run 0076_two_approvals.sql for its claim_invoice_decision and approvers_besides.
