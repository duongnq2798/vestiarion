-- Ledger key rotation (docs/superpowers/specs/2026-09-30-ledger-key-rotation-design.md).
--
-- The public halves of the keys a workspace signed with before its current one,
-- in the order they were retired: [{ id, publicKeyPem, retiredAt }]. Public
-- material, so no envelope; read with the rest of the org row by orgConfig and
-- written only by the service role, in the same update that replaces
-- ledger_signing_key_enc (K1, K2). Additive: old code never selects it.
alter table public.orgs add column if not exists ledger_retired_keys jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.orgs'::regclass and conname = 'orgs_ledger_retired_keys_is_array'
  ) then
    alter table public.orgs add constraint orgs_ledger_retired_keys_is_array check (jsonb_typeof(ledger_retired_keys) = 'array');
  end if;
end $$;
