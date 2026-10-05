-- Payment integrity (docs/superpowers/specs/2026-10-05-payment-integrity-design.md I1–I3): what the two-approvals review
-- left. Idempotent: scripts/migrate.ts re-runs every migration each time, and this file runs after 0017, 0018 and 0076,
-- whose definitions and grants it supersedes.

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

-- I3: the ledger is appended only through this function. It runs as its owner, so a tenant needs no INSERT on the
-- table, and checks the workspace itself, as row-level security no longer does for it: a tenant appends only to the
-- workspace its token names; the server's service role, whose token names none, appends to any. The search path is
-- pinned, extensions first: digest() lives there on Supabase and in public on a local database, and nothing a tenant
-- creates can stand in for it. The chain step is unchanged from 0017.
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
) returns public.ledger_entries
language plpgsql
security definer
set search_path = extensions, public
as $$
declare
  v_prev_hash text;
  v_hash      text;
  v_row       public.ledger_entries;
begin
  if p_org_id is null then
    raise exception 'append_ledger_entry: p_org_id is required';
  end if;
  if public.request_org_id() is not null and p_org_id <> public.request_org_id() then
    raise exception 'append_ledger_entry: p_org_id is not the request''s organization';
  end if;

  perform pg_advisory_xact_lock(hashtext('vestiarion_ledger:' || p_org_id::text));

  select hash into v_prev_hash
    from public.ledger_entries
   where org_id = p_org_id
   order by seq desc
   limit 1;
  v_prev_hash := coalesce(v_prev_hash, repeat('0', 64));

  v_hash := encode(digest(v_prev_hash || p_body_hash || p_signature, 'sha256'), 'hex');

  insert into public.ledger_entries (org_id, actor, domain, action, summary, detail,
                                     body_hash, signature, prev_hash, hash, signing_key_id)
  values (p_org_id, p_actor, p_domain, p_action, p_summary, coalesce(p_detail, '{}'::jsonb),
          p_body_hash, p_signature, v_prev_hash, v_hash, p_signing_key_id)
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.append_ledger_entry(uuid, text, text, text, text, jsonb, text, text, text)
  from public, anon, authenticated;
grant execute on function public.append_ledger_entry(uuid, text, text, text, text, jsonb, text, text, text)
  to vestiarion_tenant, service_role;

-- 0018 grants the tenant select and insert on the ledger, replayed on every run before this one: the insert goes.
revoke insert on table public.ledger_entries from vestiarion_tenant;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- grant insert on table public.ledger_entries to vestiarion_tenant;
-- then re-run 0017_org_scope_contract.sql for its append_ledger_entry, and 0076_two_approvals.sql for its
-- claim_invoice_decision and approvers_besides.
