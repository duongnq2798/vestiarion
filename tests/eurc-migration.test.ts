import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0040 (EURC invoices spec E1, E6): an invoice is in USDC or EURC, a
 * payment intent records the token it sent, and the open numbers keep EURC
 * out of every USDC figure while still counting an EURC payment as a payment.
 */

let db: PGlite;
let orgId: string;
let counterpartyId: string;

async function intent(fields: { token?: string; amount: number; hash: string; at: string }) {
  const columns = fields.token ? ", token" : "";
  const values = fields.token ? ", $6" : "";
  await db.query(
    `insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status, executed_at, tx_hash${columns})
     values ($1, 'invoice', gen_random_uuid(), gen_random_uuid()::text, 'circle', 'live', $2, '0xabc', 'confirmed', $3, $4${values.replace("$6", "$5")})`,
    fields.token ? [orgId, fields.amount, fields.at, fields.hash, fields.token] : [orgId, fields.amount, fields.at, fields.hash]
  );
}

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  const owner = await createUser(db, "team@vestiarion.test");
  await db.query("select public.set_platform_team_member('team@vestiarion.test', true)");
  orgId = (await db.query<{ id: string }>("insert into public.orgs (slug, name, mode, created_by) values ('eurc-co', 'EURC Co', 'live', $1) returning id", [owner]))
    .rows[0].id;
  counterpartyId = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Berlin GmbH', 'vendor') returning id", [orgId]))
    .rows[0].id;
  await intent({ amount: 3, hash: "0xusdc", at: "2026-10-01T10:00:00Z" });
  await intent({ token: "EURC", amount: 5, hash: "0xeurc", at: "2026-10-01T11:00:00Z" });
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("invoices.currency (0040)", () => {
  it("is USDC or EURC", async () => {
    for (const currency of ["USDC", "EURC"]) {
      await db.query(
        "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, currency) values ($1, 'payable', $2, 1, now(), $3)",
        [orgId, counterpartyId, currency]
      );
    }
    await expect(
      db.query("insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, currency) values ($1, 'payable', $2, 1, now(), 'JPY')", [orgId, counterpartyId])
    ).rejects.toThrow(/invoices_currency_check/);
  });
});

describe("payment_intents.token (0040)", () => {
  it("defaults to USDC, and is USDC or EURC", async () => {
    const tokens = await db.query<{ token: string }>("select token from public.payment_intents where org_id = $1 order by executed_at", [orgId]);
    expect(tokens.rows.map((row) => row.token)).toEqual(["USDC", "EURC"]);
    await expect(intent({ token: "USDT", amount: 1, hash: "0xusdt", at: "2026-10-01T12:00:00Z" })).rejects.toThrow(/payment_intents_token_check/);
  });
});

describe("open_numbers with EURC (0040)", () => {
  it("counts an EURC payment as a payment but keeps it out of USDC paid", async () => {
    const numbers = (await db.query<{ n: { sides: { ours: { payments: number; usdcPaid: number } }; daily: Array<{ oursUsdc: number }>; ourPayments: Array<{ txHash: string; token: string; amount: number }> } }>(
      "select public.open_numbers(null) as n"
    )).rows[0].n;
    expect(numbers.sides.ours.payments).toBe(2);
    expect(numbers.sides.ours.usdcPaid).toBe(3);
    expect(numbers.daily.reduce((sum, day) => sum + day.oursUsdc, 0)).toBe(3);
    expect(numbers.ourPayments.map((payment) => [payment.txHash, payment.token, payment.amount])).toEqual([
      ["0xeurc", "EURC", 5],
      ["0xusdc", "USDC", 3],
    ]);
  });
});
