-- The three-way match, checked in code (docs/superpowers/specs/2026-10-05-three-way-match-design.md M2): whether a
-- counterparty needs a purchase order before the agent pays or schedules its invoices. Every counterparty needs one
-- unless an owner or admin marks it "Paid without purchase orders": the rule the written policy has applied all along,
-- now one the model cannot waive. Re-runnable, as every migration here: db:migrate applies them all in order.
--
-- A column of counterparties, so it is read, written and deleted with the row, under the table's existing policies.

alter table public.counterparties add column if not exists purchase_order_required boolean not null default true;

comment on column public.counterparties.purchase_order_required is
  'Whether the agent needs a purchase order on file before it pays or schedules this counterparty''s invoices (three-way match design M2); goods received is always needed.';

-- Rollback:
-- alter table public.counterparties drop column if exists purchase_order_required;
