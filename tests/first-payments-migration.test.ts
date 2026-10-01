import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0042 (docs/superpowers/specs/2026-10-01-first-payment-design.md §3):
 * `open_first_payments(p_since)`, how many workspaces made their first payment
 * on Arc testnet in a period, and the median time from the workspace's
 * creation to that payment (R3), split like the other open numbers.
 */

interface Side {
  firstPayments: number;
  medianMinutesToFirstPayment: number | null;
}
interface FirstPayments {
  sides: { customers: Side; ours: Side; total: Side };
}

let db: PGlite;

async function org(slug: string, createdBy: string | null, createdAt: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into public.orgs (slug, name, mode, created_by, created_at) values ($1, $1, 'live', $2, $3) returning id",
    [slug, createdBy, createdAt]
  );
  return result.rows[0].id;
}

async function payment(orgId: string, at: string, fields: { provider?: "circle" | "simulate"; status?: string } = {}): Promise<void> {
  const provider = fields.provider ?? "circle";
  await db.query(
    `insert into public.payment_intents
       (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status, executed_at, tx_hash, chain)
     values ($1, 'invoice', gen_random_uuid(), gen_random_uuid()::text, $2, $3, 1, '0xAAA', $4, $5, '0xtx', 'ARC-TESTNET')`,
    [orgId, provider, provider === "circle" ? "live" : "simulate", fields.status ?? "confirmed", at]
  );
}

const firstPayments = async (since: string | null): Promise<FirstPayments> =>
  (await db.query<{ n: FirstPayments }>("select public.open_first_payments($1::timestamptz) as n", [since])).rows[0].n;

const numeric = (side: Side) => ({ firstPayments: Number(side.firstPayments), median: side.medianMinutesToFirstPayment === null ? null : Number(side.medianMinutesToFirstPayment) });

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);

  const team = await createUser(db, "team@vestiarion.test");
  await db.query("select public.set_platform_team_member('team@vestiarion.test', true)");
  const [a, b, c, d, e] = await Promise.all(["a", "b", "c", "d", "e"].map((name) => createUser(db, `${name}@customer.test`)));

  // Ours: first payment 30 minutes in, and a later one that does not move it.
  const ours = await org("ours-co", team, "2026-09-20T00:00:00Z");
  await payment(ours, "2026-09-20T00:30:00Z");
  await payment(ours, "2026-09-25T00:00:00Z");

  // A: a failed and a simulated payment come first and never count; the first real one is 2 hours in.
  const custA = await org("cust-a", a, "2026-09-20T00:00:00Z");
  await payment(custA, "2026-09-20T00:05:00Z", { status: "failed" });
  await payment(custA, "2026-09-20T00:10:00Z", { provider: "simulate" });
  await payment(custA, "2026-09-20T02:00:00Z");

  // B: a day in.
  const custB = await org("cust-b", b, "2026-09-21T00:00:00Z");
  await payment(custB, "2026-09-22T00:00:00Z");

  // C: never paid anyone.
  await org("cust-c", c, "2026-09-21T00:00:00Z");

  // D: first payment before 2026-09-18, and another inside any later period.
  const custD = await org("cust-d", d, "2026-09-10T00:00:00Z");
  await payment(custD, "2026-09-15T00:00:00Z");
  await payment(custD, "2026-09-26T00:00:00Z");

  // E: holds a payment from before the workspace was opened (as the founding workspace does: its rows were moved
  // into it when workspaces were introduced). It made a first payment, but there is no time to it to measure.
  const custE = await org("cust-e", e, "2026-09-30T12:00:00Z");
  await payment(custE, "2026-09-30T11:00:00Z");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("open_first_payments (0042)", () => {
  it("counts each workspace once, by its first confirmed live payment, with the median minutes from its creation", async () => {
    const { sides } = await firstPayments(null);
    // Customers: A 120, B 1440, D 7200, and E with no time. Ours: 30.
    expect(numeric(sides.customers)).toEqual({ firstPayments: 4, median: 1440 });
    expect(numeric(sides.ours)).toEqual({ firstPayments: 1, median: 30 });
    expect(numeric(sides.total)).toEqual({ firstPayments: 5, median: 780 });
  });

  it("counts a workspace in a period only when its first payment falls in it", async () => {
    const { sides } = await firstPayments("2026-09-18T00:00:00Z");
    // D's first payment was before the period; its later one does not make it a first.
    expect(numeric(sides.customers)).toEqual({ firstPayments: 3, median: 780 });
    expect(numeric(sides.total)).toEqual({ firstPayments: 4, median: 120 });
  });

  it("counts a first payment from before the workspace was opened, but leaves it out of the time", async () => {
    const { sides } = await firstPayments("2026-09-30T00:00:00Z");
    expect(numeric(sides.customers)).toEqual({ firstPayments: 1, median: null });
  });

  it("has no median for a period with no first payment", async () => {
    const { sides } = await firstPayments("2026-10-01T00:00:00Z");
    for (const side of [sides.customers, sides.ours, sides.total]) expect(numeric(side)).toEqual({ firstPayments: 0, median: null });
  });

  it("runs for the service role only", async () => {
    const result = await asServiceRole(db, (tx) => tx.query<{ n: FirstPayments }>("select public.open_first_payments(null) as n"));
    expect(Number(result.rows[0].n.sides.total.firstPayments)).toBe(5);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.open_first_payments(null)"))).rejects.toThrow(/permission denied/);
    }
  });
});
