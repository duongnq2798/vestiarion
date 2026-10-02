import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0057 (docs/superpowers/specs/2026-10-02-batch-payouts-design.md §4): a payment's batch is its
 * key, size and when it was sent, all three or none, and a batch has 2 to 20 payments.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function intent(slug: string): Promise<{ orgId: string; id: string }> {
  const orgId = await createOrg(db, slug);
  const result = await db.query<{ id: string }>(
    `insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination)
     values ($1, 'milestone', gen_random_uuid(), gen_random_uuid()::text, 'circle', 2, '0x1111111111111111111111111111111111111111') returning id`,
    [orgId]
  );
  return { orgId, id: result.rows[0].id };
}

const batch = (id: string, key: string | null, size: number | null, sentAt: string | null) =>
  db.query("update public.payment_intents set batch_key = $2, batch_size = $3, batch_sent_at = $4 where id = $1", [id, key, size, sentAt]);

describe("payment_intents batch columns (0057)", () => {
  it("are empty for a payment sent alone", async () => {
    const { id } = await intent("batch-alone");
    const row = await db.query<{ batch_key: string | null; batch_size: number | null; batch_sent_at: string | null }>(
      "select batch_key, batch_size, batch_sent_at from public.payment_intents where id = $1",
      [id]
    );
    expect(row.rows[0]).toEqual({ batch_key: null, batch_size: null, batch_sent_at: null });
  });

  it("keep a batch's key, size and time together, and its size between 2 and 20", async () => {
    const { id } = await intent("batch-checks");
    await batch(id, "batch-1", 3, "2026-10-02T10:00:00Z");
    await expect(batch(id, "batch-1", null, "2026-10-02T10:00:00Z")).rejects.toThrow(/payment_intents_batch_check/);
    await expect(batch(id, "batch-1", 3, null)).rejects.toThrow(/payment_intents_batch_check/);
    await expect(batch(id, "batch-1", 1, "2026-10-02T10:00:00Z")).rejects.toThrow(/payment_intents_batch_check/);
    await expect(batch(id, "batch-1", 21, "2026-10-02T10:00:00Z")).rejects.toThrow(/payment_intents_batch_check/);
    await batch(id, null, null, null);
  });

  it("are found by the batch's key", async () => {
    const indexes = await db.query<{ indexname: string }>("select indexname from pg_indexes where tablename = 'payment_intents' and indexname = 'payment_intents_batch_key_idx'");
    expect(indexes.rows).toHaveLength(1);
  });
});
