-- Failed-transfer retry (docs/superpowers/specs/2026-09-30-failed-transfer-retry-design.md).
--
-- A payment Circle reports as terminally failed (CANCELLED, DENIED or FAILED
-- — STUCK is in flight, never failed, R1) can be sent again, by a person,
-- never twice. The row stays one per source (`unique (source_type,
-- source_id)`, 0004) rather than gaining a row per attempt, so every reader
-- that looks an intent up by its source keeps working (R3); the failed
-- attempt is preserved in `previous_attempts` instead.
--
-- provider_state carries Circle's `state`; failure_reason carries Circle's
-- `errorReason`. `last_error` keeps its existing meaning — an error of ours,
-- such as a read that did not complete — and is untouched here.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.payment_intents add column if not exists provider_state text;
alter table public.payment_intents add column if not exists failure_reason text;
alter table public.payment_intents add column if not exists transfer_attempt integer not null default 1;
alter table public.payment_intents add column if not exists previous_attempts jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.payment_intents'::regclass and conname = 'payment_intents_transfer_attempt_positive') then
    alter table public.payment_intents add constraint payment_intents_transfer_attempt_positive check (transfer_attempt >= 1);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.payment_intents'::regclass and conname = 'payment_intents_previous_attempts_is_array') then
    alter table public.payment_intents add constraint payment_intents_previous_attempts_is_array check (jsonb_typeof(previous_attempts) = 'array');
  end if;
end $$;

-- Opens the next attempt of a payment whose current attempt Circle ended in a
-- terminal failure (R1, R3): only when the row still holds the expected key,
-- is failed, has a provider id, and its provider state is terminal. Returns
-- the row, or a row of nulls when nothing matched (as claim_payment_intent).
--
-- Every field that describes the attempt that just failed is cleared, not
-- only the ones the RPC's own precondition reads: provider_tx_id and tx_hash
-- name a transfer that no longer applies to this row once a new key is in
-- play, and confirmed_at/executed_at describe a settlement that never
-- happened for it. fee_usd, fee_source and settled_in_ms are the same kind of
-- field — recordResult (src/lib/payments.ts) writes all three from Circle's
-- reply for every outcome, including a failure, so a failed attempt's row can
-- hold a non-null fee estimate and a null-or-real settled_in_ms. Left in
-- place they would read as measurements of the new attempt, which has not
-- been sent yet; clearing them keeps the row honest until the next
-- recordResult call fills them in again.
create or replace function public.begin_payment_retry(
  p_org_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_expected_key text,
  p_new_key text
)
returns public.payment_intents
language plpgsql
set search_path = ''
as $$
declare
  retried public.payment_intents;
begin
  update public.payment_intents
     set previous_attempts = previous_attempts || jsonb_build_array(jsonb_build_object(
           'attempt', transfer_attempt,
           'idempotencyKey', idempotency_key,
           'providerTxId', provider_tx_id,
           'providerState', provider_state,
           'failureReason', failure_reason,
           'failedAt', updated_at
         )),
         idempotency_key = p_new_key,
         transfer_attempt = transfer_attempt + 1,
         provider_tx_id = null,
         tx_hash = null,
         provider_state = null,
         failure_reason = null,
         fee_usd = null,
         fee_source = null,
         settled_in_ms = null,
         status = 'created',
         last_error = null,
         confirmed_at = null,
         executed_at = null,
         updated_at = now()
   where org_id = p_org_id
     and source_type = p_source_type
     and source_id = p_source_id
     and idempotency_key = p_expected_key
     and status = 'failed'
     and provider_tx_id is not null
     and provider_state in ('CANCELLED', 'DENIED', 'FAILED')
  returning * into retried;
  return retried;
end;
$$;

revoke execute on function public.begin_payment_retry(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.begin_payment_retry(uuid, text, uuid, text, text) to service_role;
grant execute on function public.begin_payment_retry(uuid, text, uuid, text, text) to vestiarion_tenant;

-- Rollback:
-- drop function if exists public.begin_payment_retry(uuid, text, uuid, text, text);
-- alter table public.payment_intents drop constraint if exists payment_intents_previous_attempts_is_array;
-- alter table public.payment_intents drop constraint if exists payment_intents_transfer_attempt_positive;
-- alter table public.payment_intents drop column if exists previous_attempts;
-- alter table public.payment_intents drop column if exists transfer_attempt;
-- alter table public.payment_intents drop column if exists failure_reason;
-- alter table public.payment_intents drop column if exists provider_state;
