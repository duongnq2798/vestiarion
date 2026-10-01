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

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.counterparties'::regclass and conname = 'counterparties_chain_check'
  ) then
    alter table public.counterparties
      add constraint counterparties_chain_check
      check (chain in ('ARC-TESTNET', 'BASE-SEPOLIA', 'ARB-SEPOLIA', 'ETH-SEPOLIA'));
  end if;
end $$;

alter table public.payment_intents add column if not exists destination_chain text;
alter table public.payment_intents add column if not exists mint_tx_hash text;
alter table public.payment_intents add column if not exists bridge_fee numeric(20, 6);

-- Rollback:
-- alter table public.payment_intents drop column if exists bridge_fee;
-- alter table public.payment_intents drop column if exists mint_tx_hash;
-- alter table public.payment_intents drop column if exists destination_chain;
-- alter table public.counterparties drop constraint if exists counterparties_chain_check;
