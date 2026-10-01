import type { FakeReply, RecordedRequest } from "./fake-supabase";

/**
 * A minimal `payment_intents` table behind the fake REST wire — enough to
 * drive `executePayment`'s ensure → claim → transfer → recordResult path the
 * way the real table would, without a real database. Modelled on the
 * `SupabasePaymentIntentStore.claim` tests in `tests/payments.test.ts`, but
 * stateful across the whole flow rather than a single canned response.
 *
 * Rows are one per source (`unique (source_type, source_id)`), found by
 * source or by their current key, and `begin_payment_retry` moves a row to
 * its next attempt under the same condition migration 0036 applies.
 *
 * Moved here from `tests/pay.test.ts` so the AP stage's tests
 * (`tests/ap-stage.test.ts`) run the real payment step over the same table.
 */
export function paymentIntentsBackend(orgId: string) {
  const rows: Array<Record<string, unknown>> = [];
  const retries: Array<Record<string, unknown>> = [];
  const eq = (value: string | null) => value?.replace(/^eq\./, "");
  const byKey = (key: unknown) => rows.find((row) => row.idempotency_key === key);
  const bySource = (type: unknown, id: unknown) => rows.find((row) => row.source_type === type && row.source_id === id);

  const COLUMNS = [
    "id", "org_id", "source_type", "source_id", "idempotency_key", "provider", "provider_tx_id", "tx_hash",
    "amount", "destination", "status", "attempt_count", "last_error", "confirmed_at", "chain",
    "provider_mode", "fee_usd", "fee_source", "settled_in_ms", "executed_at", "provider_state", "failure_reason",
    "transfer_attempt", "previous_attempts", "created_at", "updated_at", "token",
  ];
  // No matching row: every field null, the same shape PostgREST sends when a
  // `returns payment_intents` function's UPDATE matched nothing.
  const nothing = (): FakeReply => ({ body: Object.fromEntries(COLUMNS.map((column) => [column, null])) });

  const insert = (body: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      id: `intent-${rows.length + 1}`,
      org_id: orgId,
      source_type: body.source_type,
      source_id: body.source_id,
      idempotency_key: body.idempotency_key,
      provider: body.provider,
      provider_tx_id: null,
      tx_hash: null,
      amount: String(body.amount),
      destination: body.destination,
      status: "created",
      attempt_count: 0,
      last_error: null,
      confirmed_at: null,
      chain: null,
      provider_mode: body.provider_mode,
      token: body.token ?? "USDC",
      fee_usd: null,
      fee_source: null,
      settled_in_ms: null,
      executed_at: null,
      provider_state: null,
      failure_reason: null,
      transfer_attempt: 1,
      previous_attempts: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    rows.push(row);
    return row;
  };

  const respond = (sent: RecordedRequest): FakeReply => {
    if (sent.path === "/rest/v1/payment_intents") {
      if (sent.method === "POST") {
        const body = (Array.isArray(sent.body) ? sent.body[0] : sent.body) as Record<string, unknown>;
        // on_conflict=source_type,source_id with ignore-duplicates: a source keeps its one row.
        if (!bySource(body.source_type, body.source_id)) insert(body);
        return { body: [] };
      }
      if (sent.method === "GET") {
        const key = eq(sent.params.get("idempotency_key"));
        const row = key ? byKey(key) : bySource(eq(sent.params.get("source_type")), eq(sent.params.get("source_id")));
        return { body: row ?? null };
      }
      if (sent.method === "PATCH") {
        const row = byKey(eq(sent.params.get("idempotency_key")));
        if (row) Object.assign(row, sent.body as Record<string, unknown>);
        return { body: [] };
      }
    }
    if (sent.path === "/rest/v1/rpc/claim_payment_intent") {
      const row = byKey((sent.body as Record<string, unknown> | undefined)?.p_idempotency_key);
      if (row && ["created", "failed"].includes(row.status as string)) {
        row.status = "submitting";
        row.attempt_count = (row.attempt_count as number) + 1;
        return { body: { ...row } };
      }
      return nothing();
    }
    if (sent.path === "/rest/v1/rpc/begin_payment_retry") {
      const args = sent.body as Record<string, unknown>;
      retries.push(args);
      const row = bySource(args.p_source_type, args.p_source_id);
      if (
        !row ||
        row.idempotency_key !== args.p_expected_key ||
        row.status !== "failed" ||
        row.provider_tx_id === null ||
        !["CANCELLED", "DENIED", "FAILED"].includes(row.provider_state as string)
      ) {
        return nothing();
      }
      Object.assign(row, {
        previous_attempts: [
          ...(row.previous_attempts as unknown[]),
          {
            attempt: row.transfer_attempt, idempotencyKey: row.idempotency_key, providerTxId: row.provider_tx_id,
            providerState: row.provider_state, failureReason: row.failure_reason, failedAt: row.updated_at,
          },
        ],
        idempotency_key: args.p_new_key,
        transfer_attempt: (row.transfer_attempt as number) + 1,
        provider_tx_id: null, tx_hash: null, provider_state: null, failure_reason: null,
        fee_usd: null, fee_source: null, settled_in_ms: null,
        status: "created", last_error: null, confirmed_at: null, executed_at: null,
      });
      return { body: { ...row } };
    }
    return { body: [] };
  };

  return { rows, retries, respond, insert };
}
