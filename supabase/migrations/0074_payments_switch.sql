-- The platform's switch for every payment, and the wallet a send went from
-- (docs/superpowers/specs/2026-10-05-payment-safety-design.md S7, R5).
--
-- platform_controls holds one row. While payments_disabled_at is set, nothing moves money in any workspace. It is read
-- by every running deployment at once, a console tab Vercel's skew protection keeps on an older deployment included,
-- so stopping payments needs no redeploy. Only the service role reads or writes it: `npm run payments -- off "<reason>"`
-- and `npm run payments -- on`. PAYMENTS_DISABLED in the environment still works beside it.
--
-- payment_intents.sent_wallet_id is the Circle wallet a send under the current key went from, when it was not the
-- account's own: the agent's wallet, for a payment through the spending limit contract. A send Circle never answered is
-- looked for there, by its reference, before anything is sent again (R4, R5).
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.platform_controls (
  id                       boolean primary key default true constraint platform_controls_one_row check (id),
  payments_disabled_at     timestamptz,
  payments_disabled_reason text constraint platform_controls_reason_length check (char_length(payments_disabled_reason) <= 280),
  updated_at               timestamptz not null default now()
);

insert into public.platform_controls (id) values (true) on conflict (id) do nothing;

alter table public.platform_controls enable row level security;
revoke all privileges on table public.platform_controls from public, anon, authenticated, vestiarion_tenant;
grant select, update on table public.platform_controls to service_role;

comment on table public.platform_controls is
  'One row of platform-wide controls. payments_disabled_at set: nothing moves money in any workspace (0074).';

alter table public.payment_intents add column if not exists sent_wallet_id text;

comment on column public.payment_intents.sent_wallet_id is
  'The Circle wallet a send under the current key went from when it was not the account''s own (the agent''s, through the spending limit contract); null otherwise (0074).';

notify pgrst, 'reload schema';

-- Rollback:
-- alter table public.payment_intents drop column if exists sent_wallet_id;
-- drop table if exists public.platform_controls;
