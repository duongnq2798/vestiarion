-- Continuous re-screening needs a limit that survives being screened twice.
--
-- Before this migration, `screenCounterparty` read `payment_limit`, applied
-- the risk multiplier, and wrote the result back to the same column. Screening
-- a medium-risk counterparty once gave 25% of its limit; screening it again
-- gave 25% of *that*. Any counterparty re-screened on a cadence would decay
-- toward zero for no reason other than having been looked at — which is why
-- the agent only ever screened counterparties still marked 'unscreened',
-- and why RFB5's "continuous compliance" was onboarding-only in practice.
--
-- Splitting the two columns fixes it: `baseline_payment_limit` is what the
-- business configured and screening never writes to it; `payment_limit` is
-- the effective limit, recomputed from the baseline on every screen. Tiering
-- becomes idempotent, so re-screening is free.

alter table counterparties
  add column if not exists baseline_payment_limit numeric(20, 6);

-- Backfill. `paymentLimitForRisk` is invertible for the tiers that scale
-- (clear x1, medium x0.25) and lossy for 'high', which collapses to zero.
-- High-risk rows are therefore left null — the baseline is genuinely not
-- recoverable from the data — and `screenCounterparty` will capture it on the
-- next screen, or `npm run seed` will restore it, whichever comes first.
update counterparties
   set baseline_payment_limit = case
         when risk_level in ('unscreened', 'clear') then payment_limit
         when risk_level = 'medium' then payment_limit / 0.25
         else null
       end
 where baseline_payment_limit is null;

comment on column counterparties.baseline_payment_limit is
  'Limit configured by the business. Screening reads it and never writes it.';
comment on column counterparties.payment_limit is
  'Effective limit after risk tiering. Derived; recomputed on every screen.';
