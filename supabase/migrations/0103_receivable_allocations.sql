-- Money received applied to invoices (docs/superpowers/specs/2026-10-12-allocations-design.md L1, L3, L5).
--
-- receivable_allocations: part or all of one incoming payment on Arc (incoming_transfers) applied to one receivable
-- (kind 'payment'); a difference a person marked as a fee on one receivable, with a reason (kind 'fee'); or the
-- reversal of one earlier row, with a reason (kind 'reversal'). Nothing is edited: the tenant role may only read and
-- insert, and a reversal appends a correction that frees the payment and the receivable again.
--
-- The invariants hold here, whoever writes:
-- * receivable_allocations_check (before insert, as the inserting role, so row-level security still applies) locks the
--   payment's incoming_transfers row (for a fee's reversal, the receivable's payments), then the receivable's invoices
--   row, and refuses: a receivable not open or not a
--   receivable of the workspace; a payment or a receivable a whole match claimed; another currency than both the
--   payment's and the receivable's; a payment already applied to another customer; more from a payment than it
--   brought; more on a receivable than it owes; a fee with no payment beside it; a reversal that does not mirror its
--   row, names a reversal, or would leave a fee without its payment; and a stale payment_seq.
-- * payment_seq numbers one payment's rows 1, 2, 3, ...; a person's application names the next number as they saw it,
--   so two people applying the same payment at once cannot both succeed, and the unique index holds it even past the
--   trigger. One reversal per row is a unique index too.
-- * receivable_allocations_settle (after insert) settles a receivable once nothing is owed, with the latest applied
--   payment's arrival and transaction, and reopens a received one a reversal leaves owing; in the same transaction.
-- * incoming_transfers_whole_match (before a whole match's claim, 0050's invoice_id) refuses a payment or a receivable
--   already applied, under the receivable's lock.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'incoming_transfers_org_id_id_key' and conrelid = 'public.incoming_transfers'::regclass) then
    alter table public.incoming_transfers add constraint incoming_transfers_org_id_id_key unique (org_id, id);
  end if;
end $$;

create table if not exists public.receivable_allocations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  kind        text not null constraint receivable_allocations_kind_check check (kind in ('payment', 'fee', 'reversal')),
  invoice_id  uuid not null,
  transfer_id uuid,
  amount      numeric(20, 6) not null constraint receivable_allocations_amount_check check (amount > 0),
  currency    text not null constraint receivable_allocations_currency_check check (currency in ('USDC', 'EURC')),
  reverses    uuid,
  reason      text constraint receivable_allocations_reason_check check (reason is null or char_length(reason) between 1 and 280),
  basis       text constraint receivable_allocations_basis_check check (basis is null or basis in ('sender', 'amount', 'person')),
  payment_seq integer constraint receivable_allocations_payment_seq_check check (payment_seq is null or payment_seq >= 1),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint receivable_allocations_shape check (
    (kind = 'payment' and transfer_id is not null and payment_seq is not null and basis is not null and reverses is null and reason is null)
    or (kind = 'fee' and transfer_id is null and payment_seq is null and basis is null and reverses is null and reason is not null)
    or (kind = 'reversal' and reverses is not null and reason is not null and basis is null and (transfer_id is null) = (payment_seq is null))
  ),
  constraint receivable_allocations_org_id_key unique (org_id, id),
  constraint receivable_allocations_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade,
  constraint receivable_allocations_transfer_fkey foreign key (org_id, transfer_id) references public.incoming_transfers (org_id, id) on delete cascade,
  constraint receivable_allocations_reverses_fkey foreign key (org_id, reverses) references public.receivable_allocations (org_id, id) on delete cascade
);

-- One payment's rows are numbered once each; a row is reversed at most once.
create unique index if not exists receivable_allocations_payment_seq on public.receivable_allocations (org_id, transfer_id, payment_seq)
  where transfer_id is not null;
create unique index if not exists receivable_allocations_one_reversal on public.receivable_allocations (org_id, reverses)
  where reverses is not null;
create index if not exists receivable_allocations_invoice_idx on public.receivable_allocations (org_id, invoice_id);

alter table public.receivable_allocations enable row level security;
revoke all privileges on table public.receivable_allocations from anon, authenticated, vestiarion_tenant;
grant select, insert on table public.receivable_allocations to vestiarion_tenant;
grant all privileges on table public.receivable_allocations to service_role;

drop policy if exists tenant_isolation on public.receivable_allocations;
create policy tenant_isolation on public.receivable_allocations for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.receivable_allocations;
create policy tenant_isolation_guard on public.receivable_allocations as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

create or replace function public.receivable_allocations_check() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_transfer public.incoming_transfers;
  v_invoice  public.invoices;
  v_original public.receivable_allocations;
  v_next     integer;
  -- What is applied now, rows of this same insert before this one included: from the payment; on the receivable, all
  -- of it, and the part that payments brought.
  v_from_payment numeric := 0;
  v_on_invoice   numeric := 0;
  v_paid         numeric := 0;
begin
  -- The payment first, then the receivable: the same order as a whole match's claim, so the two never deadlock.
  if new.transfer_id is not null then
    select * into v_transfer from public.incoming_transfers where org_id = new.org_id and id = new.transfer_id for update;
    if not found then
      raise exception 'allocation_no_payment: no such payment in this workspace' using errcode = 'P0001';
    end if;
    select coalesce(sum(case a.kind when 'payment' then a.amount when 'reversal' then -a.amount else 0 end), 0)
      into v_from_payment
      from public.receivable_allocations a
     where a.org_id = new.org_id and a.transfer_id = new.transfer_id;
  elsif new.kind = 'reversal' then
    -- A fee's reversal names no payment, and the payment beside it may be reversed next in the same insert: the payments
    -- applied to the receivable are locked first, in one order, so this never holds the receivable while waiting on a
    -- payment that someone applying it holds while waiting on the receivable.
    perform 1 from public.incoming_transfers t
     where t.org_id = new.org_id
       and t.id in (select a.transfer_id from public.receivable_allocations a where a.org_id = new.org_id and a.invoice_id = new.invoice_id and a.kind = 'payment')
     order by t.id
       for update;
  end if;

  select * into v_invoice from public.invoices where org_id = new.org_id and id = new.invoice_id for update;
  if not found or v_invoice.direction <> 'receivable' then
    raise exception 'allocation_not_a_receivable: no such receivable in this workspace' using errcode = 'P0001';
  end if;
  select coalesce(sum(case a.kind when 'reversal' then -a.amount else a.amount end), 0),
         coalesce(sum(case
                        when a.kind = 'payment' then a.amount
                        when a.kind = 'reversal' and a.transfer_id is not null then -a.amount
                        else 0
                      end), 0)
    into v_on_invoice, v_paid
    from public.receivable_allocations a
   where a.org_id = new.org_id and a.invoice_id = new.invoice_id;

  if new.kind = 'reversal' then
    select * into v_original from public.receivable_allocations where org_id = new.org_id and id = new.reverses;
    if not found or v_original.kind = 'reversal' then
      raise exception 'allocation_not_reversible: only a payment or a fee applied can be reversed' using errcode = 'P0001';
    end if;
    if v_original.invoice_id <> new.invoice_id or v_original.transfer_id is distinct from new.transfer_id
       or v_original.amount <> new.amount or v_original.currency <> new.currency then
      raise exception 'allocation_reversal_mismatch: a reversal names the row it reverses, as it was' using errcode = 'P0001';
    end if;
    -- A fee stands only beside a payment the customer made: its last payment goes after its fees.
    if v_original.kind = 'payment' and v_paid - new.amount <= 0 and v_on_invoice - v_paid > 0 then
      raise exception 'allocation_fee_left: reverse the fee recorded beside this payment first' using errcode = 'P0001';
    end if;
  else
    if v_invoice.status not in ('pending', 'matched') then
      raise exception 'allocation_receivable_closed: the receivable is not open' using errcode = 'P0001';
    end if;
    if new.currency <> coalesce(v_invoice.currency, 'USDC') then
      raise exception 'allocation_currency: the receivable is in another currency' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.incoming_transfers t where t.org_id = new.org_id and t.invoice_id = new.invoice_id) then
      raise exception 'allocation_receivable_matched: a payment was matched to this receivable whole' using errcode = 'P0001';
    end if;
    if v_on_invoice + new.amount > v_invoice.amount then
      raise exception 'allocation_exceeds_receivable: more than the receivable owes' using errcode = 'P0001';
    end if;
    if new.kind = 'fee' and v_paid <= 0 then
      raise exception 'allocation_fee_without_payment: a fee is recorded beside a payment applied' using errcode = 'P0001';
    end if;
  end if;

  if new.transfer_id is not null then
    if new.kind = 'payment' then
      if v_transfer.invoice_id is not null then
        raise exception 'allocation_payment_matched: this payment was matched to a receivable whole' using errcode = 'P0001';
      end if;
      if v_transfer.token <> new.currency then
        raise exception 'allocation_currency: the payment is in another currency' using errcode = 'P0001';
      end if;
      if exists (
        select 1
          from public.receivable_allocations a
          join public.invoices i on i.org_id = a.org_id and i.id = a.invoice_id
         where a.org_id = new.org_id and a.transfer_id = new.transfer_id and a.kind = 'payment'
           and i.counterparty_id <> v_invoice.counterparty_id
           and not exists (select 1 from public.receivable_allocations r where r.org_id = a.org_id and r.reverses = a.id)
      ) then
        raise exception 'allocation_other_customer: this payment is applied to another customer' using errcode = 'P0001';
      end if;
      if v_from_payment + new.amount > v_transfer.amount then
        raise exception 'allocation_exceeds_payment: more than the payment brought' using errcode = 'P0001';
      end if;
    end if;
    -- The payment's next number: a person names the one they expect, as they read the payment; the agent names none.
    select coalesce(max(a.payment_seq), 0) + 1 into v_next
      from public.receivable_allocations a
     where a.org_id = new.org_id and a.transfer_id = new.transfer_id;
    if new.payment_seq is null then
      new.payment_seq := v_next;
    elsif new.payment_seq <> v_next then
      raise exception 'allocation_stale: the payment changed since it was read' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.receivable_allocations_settle() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_invoice     public.invoices;
  v_applied     numeric;
  v_received_at timestamptz;
  v_tx_hash     text;
begin
  select * into v_invoice from public.invoices where org_id = new.org_id and id = new.invoice_id;
  select coalesce(sum(case a.kind when 'reversal' then -a.amount else a.amount end), 0) into v_applied
    from public.receivable_allocations a
   where a.org_id = new.org_id and a.invoice_id = new.invoice_id;
  if new.kind <> 'reversal' and v_applied >= v_invoice.amount and v_invoice.status in ('pending', 'matched') then
    -- Settled by the latest payment applied: its arrival and its transaction.
    select t.received_at, t.tx_hash into v_received_at, v_tx_hash
      from public.receivable_allocations a
      join public.incoming_transfers t on t.org_id = a.org_id and t.id = a.transfer_id
     where a.org_id = new.org_id and a.invoice_id = new.invoice_id and a.kind = 'payment'
       and not exists (select 1 from public.receivable_allocations r where r.org_id = a.org_id and r.reverses = a.id)
     order by t.received_at desc, a.payment_seq desc
     limit 1;
    update public.invoices
       set status = 'received', settled_at = coalesce(v_received_at, now()), tx_ref = v_tx_hash, decided_at = now()
     where org_id = new.org_id and id = new.invoice_id;
  elsif new.kind = 'reversal' and v_applied < v_invoice.amount and v_invoice.status = 'received' then
    update public.invoices
       set status = 'pending', settled_at = null, tx_ref = null, decided_at = now()
     where org_id = new.org_id and id = new.invoice_id;
  end if;
  return null;
end;
$$;

create or replace function public.incoming_transfers_whole_match() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.invoice_id is not null and new.invoice_id is distinct from old.invoice_id then
    perform 1 from public.invoices where org_id = new.org_id and id = new.invoice_id for update;
    if exists (
      select 1 from public.receivable_allocations a
       where a.org_id = new.org_id and a.transfer_id = new.id
      having coalesce(sum(case a.kind when 'payment' then a.amount when 'reversal' then -a.amount else 0 end), 0) > 0
    ) then
      raise exception 'transfer_partly_applied: this payment is applied to receivables' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.receivable_allocations a
       where a.org_id = new.org_id and a.invoice_id = new.invoice_id
      having coalesce(sum(case a.kind when 'reversal' then -a.amount else a.amount end), 0) > 0
    ) then
      raise exception 'receivable_partly_paid: payments are applied to this receivable' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.receivable_allocations_check() from public, anon, authenticated;
revoke all on function public.receivable_allocations_settle() from public, anon, authenticated;
revoke all on function public.incoming_transfers_whole_match() from public, anon, authenticated;

drop trigger if exists receivable_allocations_check on public.receivable_allocations;
create trigger receivable_allocations_check before insert on public.receivable_allocations
  for each row execute function public.receivable_allocations_check();

drop trigger if exists receivable_allocations_settle on public.receivable_allocations;
create trigger receivable_allocations_settle after insert on public.receivable_allocations
  for each row execute function public.receivable_allocations_settle();

drop trigger if exists incoming_transfers_whole_match on public.incoming_transfers;
create trigger incoming_transfers_whole_match before update of invoice_id on public.incoming_transfers
  for each row execute function public.incoming_transfers_whole_match();

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop trigger if exists incoming_transfers_whole_match on public.incoming_transfers;
-- drop function if exists public.incoming_transfers_whole_match();
-- drop table if exists public.receivable_allocations;
-- drop function if exists public.receivable_allocations_settle();
-- drop function if exists public.receivable_allocations_check();
-- alter table public.incoming_transfers drop constraint if exists incoming_transfers_org_id_id_key;
