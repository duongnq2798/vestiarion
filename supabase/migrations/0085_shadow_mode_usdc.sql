-- Shadow mode in USDC (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S1, S6): a workspace's bills can be
-- entered in USDC itself, with nothing converted, as well as in a currency of their own. shadow_modes.currency took a
-- three-letter code only; it now takes USDC too, which Settings offers first. EURC stays out: shadow mode pays in USDC.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.shadow_modes drop constraint if exists shadow_modes_currency_check;
alter table public.shadow_modes add constraint shadow_modes_currency_check check (currency ~ '^[A-Z]{3}$' or currency = 'USDC');

-- Down (by hand; first change any workspace in USDC to a three-letter currency, or turn its shadow mode off):
-- alter table public.shadow_modes drop constraint if exists shadow_modes_currency_check;
-- alter table public.shadow_modes add constraint shadow_modes_currency_check check (currency ~ '^[A-Z]{3}$');
