import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0080 (docs/superpowers/specs/2026-10-06-stuck-transfer-alert-design.md D2): when a payment's current attempt
 * was sent. A trigger stamps it whenever a row becomes `submitting`, so a first send, a retry and a claim taken again
 * are each stamped, and rows in flight are backfilled. It runs again without harm, as db:migrate runs every file.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function intent(orgId: string, key: string, status = "created"): Promise<string> {
  const row = await db.query<{ id: string }>(
    `insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status)
     values ($1, 'invoice', gen_random_uuid(), $2, 'circle', 'live', 1.5, '0x1111111111111111111111111111111111111111', $3) returning id`,
    [orgId, key, status]
  );
  return row.rows[0].id;
}

const stamp = async (id: string) =>
  (await db.query<{ submitted_at: Date | null }>("select submitted_at from public.payment_intents where id = $1", [id])).rows[0].submitted_at;
const setStatus = (id: string, status: string) => db.query("update public.payment_intents set status = $2 where id = $1", [id, status]);
/** The database's clock moves on between statements only if time passes: wait a little, so a later stamp is later. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

describe("when a payment's attempt was sent (0080)", () => {
  it("stamps a row when it becomes submitting, and keeps the stamp while it is pending", async () => {
    const orgId = await createOrg(db, "submitted-first");
    const id = await intent(orgId, "submitted-first-1");
    expect(await stamp(id)).toBeNull();

    await setStatus(id, "submitting");
    const sent = await stamp(id);
    expect(sent).toBeInstanceOf(Date);

    await tick();
    await setStatus(id, "pending");
    expect(await stamp(id)).toEqual(sent);
  });

  it("stamps a retry again: a failed row put back to created and claimed later is later", async () => {
    const orgId = await createOrg(db, "submitted-retry");
    const id = await intent(orgId, "submitted-retry-1");
    await setStatus(id, "submitting");
    const first = (await stamp(id)) as Date;
    await setStatus(id, "failed");

    await tick();
    // As begin_payment_retry leaves it: a new key, status created; then the next claim.
    await db.query("update public.payment_intents set idempotency_key = 'submitted-retry-2', status = 'created' where id = $1", [id]);
    await setStatus(id, "submitting");
    const second = (await stamp(id)) as Date;
    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });

  it("stamps a row inserted as submitting", async () => {
    const orgId = await createOrg(db, "submitted-insert");
    expect(await stamp(await intent(orgId, "submitted-insert-1", "submitting"))).toBeInstanceOf(Date);
  });

  it("does not stamp a row that only becomes confirmed or failed", async () => {
    const orgId = await createOrg(db, "submitted-other");
    const id = await intent(orgId, "submitted-other-1");
    await setStatus(id, "failed");
    expect(await stamp(id)).toBeNull();
  });

  it("serves the watch with an index over live rows in flight, and runs again without a second trigger", async () => {
    await applyMigrations(db, (file) => file.startsWith("0080"));
    const triggers = await db.query<{ count: number }>(
      "select count(*)::int as count from pg_trigger where tgname = 'payment_intents_submitted' and not tgisinternal"
    );
    expect(triggers.rows[0].count).toBe(1);
    const index = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'payment_intents_in_flight'");
    expect(index.rows[0].indexdef).toContain("submitted_at");
    expect(index.rows[0].indexdef).toContain("provider_mode = 'live'");
  });

  it("backfills a row already in flight from when it was executed", async () => {
    const orgId = await createOrg(db, "submitted-backfill");
    const id = await intent(orgId, "submitted-backfill-1");
    // In flight before 0080: pending, executed, and no stamp.
    await db.query("alter table public.payment_intents disable trigger payment_intents_submitted");
    await db.query("update public.payment_intents set status = 'pending', executed_at = '2026-10-06T05:00:00Z', submitted_at = null where id = $1", [id]);
    await db.query("alter table public.payment_intents enable trigger payment_intents_submitted");
    await applyMigrations(db, (file) => file.startsWith("0080"));
    expect((await stamp(id))?.toISOString()).toBe("2026-10-06T05:00:00.000Z");
  });
});
