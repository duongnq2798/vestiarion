-- Decision cards must keep their reasoning after the ledger grows beyond a
-- fixed recent-entry window. Query immutable entries by the business target
-- ids embedded in their signed detail instead.

create index if not exists ledger_entries_invoice_target_idx
  on public.ledger_entries ((detail ->> 'invoiceId'))
  where detail ? 'invoiceId';

create index if not exists ledger_entries_milestone_target_idx
  on public.ledger_entries ((detail ->> 'milestoneId'))
  where detail ? 'milestoneId';

create or replace function public.ledger_entries_for_targets(
  p_invoice_ids text[] default '{}'::text[],
  p_milestone_ids text[] default '{}'::text[]
) returns setof public.ledger_entries
language sql
stable
set search_path = public
as $$
  select entry.*
    from public.ledger_entries entry
   where entry.detail ->> 'invoiceId' = any(p_invoice_ids)
      or entry.detail ->> 'milestoneId' = any(p_milestone_ids)
   order by entry.seq desc;
$$;

revoke execute on function public.ledger_entries_for_targets(text[], text[])
  from public, anon, authenticated;
grant execute on function public.ledger_entries_for_targets(text[], text[])
  to service_role;
