-- Follow-up on decisions the agent already made.
--
-- An invoice that went to 'held' or 'awaiting_info' left the decision loop
-- permanently: the agent asked a vendor for a purchase order and never looked
-- again, while the invoice went on counting against the liquidity buffer. This
-- column is what stops the fix from becoming its own problem — without a record
-- of when a human was last told, the agent would repeat the same escalation
-- every cycle until nobody read them.
--
-- Null means never escalated, which is not the same as escalated long ago.

alter table invoices
  add column if not exists escalated_at timestamptz;

comment on column invoices.escalated_at is
  'When the agent last raised this frozen invoice for a human decision. Null means never.';

create index if not exists invoices_frozen_idx
  on invoices (direction, status)
  where status in ('held', 'awaiting_info', 'flagged');
