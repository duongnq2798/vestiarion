import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FOUNDING_ORG_ID as A, applyMigrations, asRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0036 (docs/superpowers/specs/2026-09-30-failed-transfer-retry-design.md,
 * §1 Attempts, R1/R3): `payment_intents.provider_state`, `failure_reason`,
 * `transfer_attempt`, `previous_attempts`, and `begin_payment_retry`, the
 * RPC that opens the next attempt of a payment Circle ended in a terminal
 * failure (CANCELLED, DENIED, FAILED — STUCK is in flight, never failed).
 */

let db: PGlite;
let B: string;
let counterpartyIdA: string;
let counterpartyIdB: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  B = await createOrg(db, "retry-co-b");

  counterpartyIdA = (await db.query<{ id: string }>(
    "insert into public.counterparties (org_id, name, role) values ($1, 'Retry Vendor A', 'vendor') returning id", [A]
  )).rows[0].id;
  counterpartyIdB = (await db.query<{ id: string }>(
    "insert into public.counterparties (org_id, name, role) values ($1, 'Retry Vendor B', 'vendor') returning id", [B]
  )).rows[0].id;
}, 60_000);

afterAll(async () => {
  await db.close();
});

/** A payable invoice, so a fresh `source_id` is available per test — `payment_intents` is unique on (source_type, source_id) (0004), so each retry scenario needs its own. */
async function freshInvoice(orgId: string, counterpartyId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 1, now()) returning id",
    [orgId, counterpartyId]
  );
  return result.rows[0].id;
}

interface PaymentIntentOverrides {
  sourceId: string;
  idempotencyKey: string;
  status?: string;
  providerTxId?: string | null;
  txHash?: string | null;
  providerState?: string | null;
  failureReason?: string | null;
  transferAttempt?: number;
  previousAttempts?: unknown;
  feeUsd?: number | null;
  feeSource?: string | null;
  settledInMs?: number | null;
  confirmedAt?: string | null;
  executedAt?: string | null;
  lastError?: string | null;
}

/** A payment_intents row, written directly (the service role's stand-in), with every 0036 column controllable. */
async function paymentIntent(orgId: string, overrides: PaymentIntentOverrides): Promise<string> {
  const {
    sourceId, idempotencyKey, status = "created", providerTxId = null, txHash = null, providerState = null,
    failureReason = null, transferAttempt, previousAttempts, feeUsd = null, feeSource = null, settledInMs = null,
    confirmedAt = null, executedAt = null, lastError = null,
  } = overrides;

  // Base columns are always written; transfer_attempt/previous_attempts are
  // only named when a test overrides them, so the "existing-shaped row" test
  // can prove the table's own defaults (attempt 1, an empty history) apply.
  const entries: Array<[string, unknown]> = [
    ["org_id", orgId], ["source_type", "invoice"], ["source_id", sourceId], ["idempotency_key", idempotencyKey],
    ["provider", "circle"], ["provider_tx_id", providerTxId], ["tx_hash", txHash], ["amount", 10],
    ["destination", "sim:x"], ["status", status], ["last_error", lastError], ["confirmed_at", confirmedAt],
    ["provider_state", providerState], ["failure_reason", failureReason], ["fee_usd", feeUsd],
    ["fee_source", feeSource], ["settled_in_ms", settledInMs], ["executed_at", executedAt],
  ];
  if (transferAttempt !== undefined) entries.push(["transfer_attempt", transferAttempt]);
  if (previousAttempts !== undefined) entries.push(["previous_attempts", JSON.stringify(previousAttempts)]);

  const columns = entries.map(([column]) => column);
  const values = entries.map(([, value]) => value);
  const placeholders = entries.map(([column], i) => (column === "previous_attempts" ? `$${i + 1}::jsonb` : `$${i + 1}`));
  const sql = `insert into public.payment_intents (${columns.join(", ")}) values (${placeholders.join(", ")}) returning id`;
  const result = await db.query<{ id: string }>(sql, values);
  return result.rows[0].id;
}

/** A failed, terminally-ended row ready to retry: has a provider id and a terminal provider_state. */
async function retryableIntent(orgId: string, sourceId: string, idempotencyKey: string, opts: Partial<PaymentIntentOverrides> = {}): Promise<string> {
  return paymentIntent(orgId, {
    sourceId,
    idempotencyKey,
    status: "failed",
    providerTxId: "circle-tx-1",
    txHash: "0xabc",
    providerState: "FAILED",
    failureReason: "insufficient_funds",
    feeUsd: 1.5,
    feeSource: "provider_estimate",
    settledInMs: 4200,
    lastError: null,
    ...opts,
  });
}

const rowById = async (id: string) =>
  (await db.query<Record<string, unknown>>("select * from public.payment_intents where id = $1", [id])).rows[0];

const retry = (orgId: string, sourceId: string, expectedKey: string, newKey: string) =>
  asTenant(db, orgId, async (tx) =>
    (await tx.query<Record<string, unknown>>(
      "select * from public.begin_payment_retry($1::uuid, $2, $3::uuid, $4, $5)",
      [orgId, "invoice", sourceId, expectedKey, newKey]
    )).rows[0]);

describe("payment_intents columns (0036)", () => {
  it("provider_state and failure_reason are nullable text", async () => {
    const columns = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'payment_intents'
          and column_name in ('provider_state', 'failure_reason') order by column_name`
    );
    expect(columns.rows).toEqual([
      { column_name: "failure_reason", data_type: "text", is_nullable: "YES" },
      { column_name: "provider_state", data_type: "text", is_nullable: "YES" },
    ]);
  });

  it("transfer_attempt is a not-null integer defaulting to 1", async () => {
    const column = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `select data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'payment_intents' and column_name = 'transfer_attempt'`
    );
    expect(column.rows).toEqual([{ data_type: "integer", is_nullable: "NO", column_default: "1" }]);
  });

  it("previous_attempts is a not-null jsonb defaulting to an empty array", async () => {
    const column = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `select data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'payment_intents' and column_name = 'previous_attempts'`
    );
    expect(column.rows).toEqual([{ data_type: "jsonb", is_nullable: "NO", column_default: "'[]'::jsonb" }]);
  });

  it("an existing-shaped row (no new columns named) reads attempt 1 and an empty history", async () => {
    const sourceId = await freshInvoice(A, counterpartyIdA);
    const id = await paymentIntent(A, { sourceId, idempotencyKey: "shape-a-1" });
    const row = await rowById(id);
    expect(row.transfer_attempt).toBe(1);
    expect(row.previous_attempts).toEqual([]);
  });

  it("refuses transfer_attempt below 1", async () => {
    const sourceId = await freshInvoice(A, counterpartyIdA);
    await expect(
      db.query(
        "insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination, transfer_attempt) values ($1, 'invoice', $2, 'bad-attempt', 'simulate', 1, 'sim:x', 0)",
        [A, sourceId]
      )
    ).rejects.toThrow(/payment_intents_transfer_attempt_positive/);
  });

  it("refuses a non-array previous_attempts", async () => {
    const sourceId = await freshInvoice(A, counterpartyIdA);
    await expect(
      db.query(
        "insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination, previous_attempts) values ($1, 'invoice', $2, 'bad-history', 'simulate', 1, 'sim:x', $3::jsonb)",
        [A, sourceId, JSON.stringify({ not: "an array" })]
      )
    ).rejects.toThrow(/payment_intents_previous_attempts_is_array/);
  });
});

describe("begin_payment_retry", () => {
  it("moves a terminal-failed row to attempt 2: new key, history entry, transfer fields cleared, status created", async () => {
    const sourceId = await freshInvoice(A, counterpartyIdA);
    const id = await retryableIntent(A, sourceId, "retry-ok-1");
    const before = await rowById(id);
    expect(before.updated_at).toBeTruthy();

    const row = await retry(A, sourceId, "retry-ok-1", "retry-ok-1-attempt-2");
    expect(row).toMatchObject({
      id,
      idempotency_key: "retry-ok-1-attempt-2",
      transfer_attempt: 2,
      status: "created",
      provider_tx_id: null,
      tx_hash: null,
      provider_state: null,
      failure_reason: null,
      fee_usd: null,
      fee_source: null,
      settled_in_ms: null,
      last_error: null,
      confirmed_at: null,
      executed_at: null,
    });

    const history = row.previous_attempts as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      attempt: 1,
      idempotencyKey: "retry-ok-1",
      providerTxId: "circle-tx-1",
      providerState: "FAILED",
      failureReason: "insufficient_funds",
    });
    expect(history[0].failedAt).toBeTruthy();

    // Persisted, not only returned.
    expect(await rowById(id)).toMatchObject({ idempotency_key: "retry-ok-1-attempt-2", transfer_attempt: 2, status: "created" });
  });

  it("accepts CANCELLED and DENIED as terminal, same as FAILED", async () => {
    for (const state of ["CANCELLED", "DENIED"]) {
      const sourceId = await freshInvoice(A, counterpartyIdA);
      const key = `retry-terminal-${state}`;
      const id = await retryableIntent(A, sourceId, key, { providerState: state });
      const row = await retry(A, sourceId, key, `${key}-2`);
      expect(row).toMatchObject({ id, transfer_attempt: 2, status: "created" });
    }
  });

  it("returns a row of nulls (no change) when the expected key is stale", async () => {
    const sourceId = await freshInvoice(A, counterpartyIdA);
    const id = await retryableIntent(A, sourceId, "retry-wrong-key");
    const row = await retry(A, sourceId, "not-the-current-key", "retry-wrong-key-2");
    expect(row.id ?? null).toBeNull();
    expect(await rowById(id)).toMatchObject({ idempotency_key: "retry-wrong-key", transfer_attempt: 1 });
  });

  it("returns a row of nulls when status is not failed (e.g. pending)", async () => {
    const sourceId = await freshInvoice(A, counterpartyIdA);
    const id = await retryableIntent(A, sourceId, "retry-pending", { status: "pending" });
    const row = await retry(A, sourceId, "retry-pending", "retry-pending-2");
    expect(row.id ?? null).toBeNull();
    expect(await rowById(id)).toMatchObject({ status: "pending", transfer_attempt: 1 });
  });

  it("returns a row of nulls when there is no provider id", async () => {
    const sourceId = await freshInvoice(A, counterpartyIdA);
    const id = await retryableIntent(A, sourceId, "retry-no-provider-id", { providerTxId: null });
    const row = await retry(A, sourceId, "retry-no-provider-id", "retry-no-provider-id-2");
    expect(row.id ?? null).toBeNull();
    expect(await rowById(id)).toMatchObject({ provider_tx_id: null, transfer_attempt: 1 });
  });

  it("returns a row of nulls when provider_state is STUCK (in flight, never failed)", async () => {
    const sourceId = await freshInvoice(A, counterpartyIdA);
    const id = await retryableIntent(A, sourceId, "retry-stuck", { providerState: "STUCK" });
    const row = await retry(A, sourceId, "retry-stuck", "retry-stuck-2");
    expect(row.id ?? null).toBeNull();
    expect(await rowById(id)).toMatchObject({ provider_state: "STUCK", transfer_attempt: 1 });
  });

  it("returns a row of nulls when provider_state is null", async () => {
    const sourceId = await freshInvoice(A, counterpartyIdA);
    const id = await retryableIntent(A, sourceId, "retry-null-state", { providerState: null });
    const row = await retry(A, sourceId, "retry-null-state", "retry-null-state-2");
    expect(row.id ?? null).toBeNull();
    expect(await rowById(id)).toMatchObject({ provider_state: null, transfer_attempt: 1 });
  });

  it("as the tenant role, changes only its own organization's row; another org's row is untouched even when p_org_id names it", async () => {
    const sourceIdB = await freshInvoice(B, counterpartyIdB);
    const idB = await retryableIntent(B, sourceIdB, "isolation-b-key");

    // Acting as tenant A, but naming B as p_org_id — the argument a caller
    // bug might pass. RLS confines the UPDATE to A's own rows regardless of
    // the argument, so nothing in B matches and nothing changes.
    const attempt = await asTenant(db, A, async (tx) =>
      (await tx.query<Record<string, unknown>>(
        "select * from public.begin_payment_retry($1::uuid, $2, $3::uuid, $4, $5)",
        [B, "invoice", sourceIdB, "isolation-b-key", "isolation-b-key-2"]
      )).rows[0]);
    expect(attempt.id ?? null).toBeNull();
    expect(await rowById(idB)).toMatchObject({ idempotency_key: "isolation-b-key", transfer_attempt: 1, status: "failed" });

    // Sanity: the identical call genuinely succeeds when run as B itself.
    const asB = await retry(B, sourceIdB, "isolation-b-key", "isolation-b-key-2");
    expect(asB).toMatchObject({ id: idB, transfer_attempt: 2 });
  });

  it("stays closed to the browser roles", async () => {
    const sourceId = await freshInvoice(A, counterpartyIdA);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(
        asRole(db, role, (tx) => tx.query("select * from public.begin_payment_retry($1::uuid, $2, $3::uuid, $4, $5)", [A, "invoice", sourceId, "k", "k2"]))
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("is executable by the tenant role and the service role, per has_function_privilege", async () => {
    const privileges = await db.query<{ anon: boolean; authed: boolean; tenant: boolean; service: boolean }>(
      `select has_function_privilege('anon', 'public.begin_payment_retry(uuid,text,uuid,text,text)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.begin_payment_retry(uuid,text,uuid,text,text)', 'execute') as authed,
              has_function_privilege('vestiarion_tenant', 'public.begin_payment_retry(uuid,text,uuid,text,text)', 'execute') as tenant,
              has_function_privilege('service_role', 'public.begin_payment_retry(uuid,text,uuid,text,text)', 'execute') as service`
    );
    expect(privileges.rows[0]).toEqual({ anon: false, authed: false, tenant: true, service: true });
  });
});

describe("0036 is idempotent", () => {
  it("replays twice without error, keeping an already-retried row unchanged", async () => {
    const sourceId = await freshInvoice(A, counterpartyIdA);
    const id = await retryableIntent(A, sourceId, "replay-key-1");
    await retry(A, sourceId, "replay-key-1", "replay-key-1-attempt-2");
    const before = await rowById(id);

    await applyMigrations(db);
    await applyMigrations(db);

    expect(await rowById(id)).toEqual(before);
  });
});
