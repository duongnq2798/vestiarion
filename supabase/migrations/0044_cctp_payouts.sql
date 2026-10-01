-- Cross-chain payouts through CCTP (docs/superpowers/specs/2026-10-01-cctp-payouts-design.md).
--
-- A payee's chain is Arc testnet, paid directly, or one of the testnets CCTP
-- V2 pays to from Arc with the Forwarding Service: Base, Arbitrum and Ethereum
-- Sepolia (X1). Every counterparty in production was on ARC-TESTNET when this
-- was written, so the check holds for existing rows.
--
-- A payment intent for a bridged payment records the chain it was minted on,
-- the mint's transaction (the Forwarding Service submits it) and the fee paid
-- on top of the invoice from the operating wallet (X8). tx_hash stays the
-- transaction on Arc: for a bridge, the burn. Idempotent; no function is
-- redefined.

-- Only a vendor is paid on another chain: a contractor's milestones are
-- released on Arc (review C1). Any chain written before this, when the field
-- was free text, was always paid on Arc, so it is read as ARC-TESTNET.
update public.counterparties
   set chain = 'ARC-TESTNET'
 where chain is not null and chain not in ('ARC-TESTNET', 'BASE-SEPOLIA', 'ARB-SEPOLIA', 'ETH-SEPOLIA');

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.counterparties'::regclass and conname = 'counterparties_chain_check'
  ) then
    alter table public.counterparties
      add constraint counterparties_chain_check
      check (chain in ('ARC-TESTNET', 'BASE-SEPOLIA', 'ARB-SEPOLIA', 'ETH-SEPOLIA') and (chain = 'ARC-TESTNET' or role = 'vendor'));
  end if;
end $$;

alter table public.payment_intents add column if not exists destination_chain text;
alter table public.payment_intents add column if not exists mint_tx_hash text;
alter table public.payment_intents add column if not exists bridge_fee numeric(20, 6);

-- The chain a payee link's payee is paid on, so the page asks for an address
-- on that chain (review I3). A function of its own: payee_link_preview (0039)
-- returns a table, and changing its columns would break a run of 0039 from a
-- branch without this file. Null for a link that is used, revoked, expired or
-- unknown, like the preview.
create or replace function public.payee_link_chain(p_token_hash text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.chain
    from public.payee_links l
    join public.counterparties c on c.org_id = l.org_id and c.id = l.counterparty_id
   where l.token_hash = p_token_hash
     and l.used_at is null and l.revoked_at is null and l.expires_at > now()
$$;

revoke execute on function public.payee_link_chain(text) from public, anon, authenticated;
grant execute on function public.payee_link_chain(text) to service_role;

notify pgrst, 'reload schema';

-- Rollback:
-- drop function if exists public.payee_link_chain(text);
-- alter table public.payment_intents drop column if exists bridge_fee;
-- alter table public.payment_intents drop column if exists mint_tx_hash;
-- alter table public.payment_intents drop column if exists destination_chain;
-- alter table public.counterparties drop constraint if exists counterparties_chain_check;
