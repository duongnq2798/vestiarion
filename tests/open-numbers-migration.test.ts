import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0037 (docs/superpowers/specs/2026-09-30-open-numbers-design.md):
 * `open_numbers(p_since)`, the one function that reads across workspaces for
 * the public /open page, and the `platform_team` list that decides which
 * workspaces are ours. Only aggregates leave it, and a workspace counts as a
 * customer's only when a person outside the team created it (R3).
 */

let db: PGlite;
let teamUser: string;
let customerUser: string;

interface Side {
  workspacesOpened: number;
  liveWorkspaces: number;
  people: number;
  payments: number;
  usdcPaid: number;
  payees: number;
  invoicesDecided: number;
  milestonesReleased: number;
  cycles: number;
  modelDecisions: number;
  policyDepartures: number;
  refusedByCode: number;
  usdcInWallets: number;
}

interface Numbers {
  generatedAt: string;
  sides: { customers: Side; ours: Side; total: Side };
  daily: Array<{ day: string; customers: number; ours: number; customersUsdc: number; oursUsdc: number }>;
  ourPayments: Array<{ at: string; amount: number; txHash: string; chain: string | null }>;
}

async function org(slug: string, mode: "live" | "sandbox", createdBy: string | null): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into public.orgs (slug, name, mode, created_by, created_at) values ($1, $1, $2, $3, '2026-09-20T00:00:00Z') returning id",
    [slug, mode, createdBy]
  );
  return result.rows[0].id;
}

async function counterparty(orgId: string, name: string, sample = false): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into public.counterparties (org_id, name, role, sample) values ($1, $2, 'vendor', $3) returning id",
    [orgId, name, sample]
  );
  return result.rows[0].id;
}

async function payment(
  orgId: string,
  fields: { amount: number; destination: string; status: string; provider: string; at: string; txHash?: string | null }
): Promise<void> {
  await db.query(
    `insert into public.payment_intents
       (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status, executed_at, tx_hash, chain)
     values ($1, 'invoice', gen_random_uuid(), gen_random_uuid()::text, $2, $3, $4, $5, $6, $7, $8, 'ARC-TESTNET')`,
    [
      orgId,
      fields.provider,
      fields.provider === "circle" ? "live" : "simulate",
      fields.amount,
      fields.destination,
      fields.status,
      fields.at,
      fields.txHash ?? null,
    ]
  );
}

const openNumbers = async (since: string | null): Promise<Numbers> =>
  (await db.query<{ n: Numbers }>("select public.open_numbers($1::timestamptz) as n", [since])).rows[0].n;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);

  teamUser = await createUser(db, "team@vestiarion.test");
  customerUser = await createUser(db, "owner@customer.test");
  await db.query("select public.set_platform_team_member('team@vestiarion.test', true)");

  const ours = await org("ours-co", "sandbox", teamUser);
  const customer = await org("cust-co", "live", customerUser);
  await org("orphan-co", "sandbox", null);
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner')", [
    ours,
    teamUser,
    customer,
    customerUser,
  ]);

  await db.query(
    "insert into public.accounts (org_id, name, kind, chain, token, circle_wallet_id, balance) values ($1, 'Operating', 'operating', 'ARC-TESTNET', 'USDC', 'w-1', 40), ($1, 'Unprovisioned', 'reserve', 'ARC-TESTNET', 'USDC', null, 99)",
    [customer]
  );
  const acme = await counterparty(customer, "Acme");
  const sample = await counterparty(customer, "Sample Vendor", true);

  await payment(customer, { amount: 5, destination: "0xAAA", status: "confirmed", provider: "circle", at: "2026-09-28T10:00:00Z", txHash: "0xc1" });
  await payment(customer, { amount: 3, destination: "0xaaa", status: "confirmed", provider: "circle", at: "2026-09-29T10:00:00Z", txHash: "0xc2" });
  await payment(customer, { amount: 9, destination: "0xBBB", status: "pending", provider: "circle", at: "2026-09-29T11:00:00Z" });
  await payment(customer, { amount: 7, destination: "sim:x", status: "confirmed", provider: "simulate", at: "2026-09-29T12:00:00Z" });
  await payment(ours, { amount: 2, destination: "0xAAA", status: "confirmed", provider: "circle", at: "2026-09-27T10:00:00Z", txHash: "0xh1" });
  await payment(ours, { amount: 1, destination: "0xCCC", status: "confirmed", provider: "circle", at: "2026-09-26T10:00:00Z", txHash: null });

  await db.query(
    `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, decided_at)
     values ($1, 'payable', $2, 5, '2026-10-01', 'paid', '2026-09-28T10:00:00Z'),
            ($1, 'payable', $3, 5, '2026-10-01', 'paid', '2026-09-28T10:00:00Z'),
            ($1, 'payable', $2, 5, '2026-10-01', 'pending', null)`,
    [customer, acme, sample]
  );
  await db.query(
    `insert into public.milestones (org_id, contractor_id, title, amount, status, settled_at)
     values ($1, $2, 'Shipped', 3, 'paid', '2026-09-29T10:00:00Z'),
            ($1, $3, 'Sample milestone', 3, 'paid', '2026-09-29T10:00:00Z'),
            ($1, $2, 'Not yet', 3, 'pending', null)`,
    [customer, acme, sample]
  );
  await db.query(
    `insert into public.cycle_runs (org_id, started_at, clock_mode, chain_mode, screening_mode,
       model_decision_count, reference_disagreement_count, guardrail_override_count)
     values ($1, '2026-09-28T10:00:00Z', 'real', 'live', 'simulate', 3, 1, 1)`,
    [customer]
  );
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("open_numbers (0037)", () => {
  it("counts only settled Arc payments, a customer's apart from ours, each payee wallet once", async () => {
    const { sides } = await openNumbers(null);
    expect(sides.customers).toMatchObject({ payments: 2, usdcPaid: 8, payees: 1 });
    expect(sides.ours).toMatchObject({ payments: 2, usdcPaid: 3, payees: 2 });
    // 0xAAA was paid by a customer and by us: once in the total.
    expect(sides.total).toMatchObject({ payments: 4, usdcPaid: 11, payees: 2 });
  });

  it("counts a workspace whose creator is gone, and the founding one, as ours, never a customer's", async () => {
    const { sides } = await openNumbers(null);
    expect(sides.customers.workspacesOpened).toBe(1);
    // founding (created by the migrations, no creator), ours-co, orphan-co
    expect(sides.ours.workspacesOpened).toBe(3);
    expect(sides.customers.liveWorkspaces).toBe(1);
    expect(sides.total.workspacesOpened).toBe(4);
  });

  it("counts people by whether they are on the team", async () => {
    const { sides } = await openNumbers(null);
    expect([sides.customers.people, sides.ours.people, sides.total.people]).toEqual([1, 1, 2]);
  });

  it("leaves sample data out of invoices and milestones", async () => {
    const { sides } = await openNumbers(null);
    expect(sides.customers.invoicesDecided).toBe(1);
    expect(sides.customers.milestonesReleased).toBe(1);
  });

  it("sums the agent's cycles and what its decisions were", async () => {
    const { sides } = await openNumbers(null);
    expect(sides.customers).toMatchObject({ cycles: 1, modelDecisions: 3, policyDepartures: 1, refusedByCode: 1 });
    expect(sides.ours).toMatchObject({ cycles: 0, modelDecisions: 0 });
  });

  it("counts USDC held in live workspaces' Circle wallets only", async () => {
    const { sides } = await openNumbers(null);
    expect(sides.customers.usdcInWallets).toBe(40);
    expect(sides.ours.usdcInWallets).toBe(0);
  });

  it("restricts the flows to the period and leaves the stocks alone", async () => {
    const { sides } = await openNumbers("2026-09-28T00:00:00Z");
    expect(sides.customers.payments).toBe(2);
    expect(sides.ours.payments).toBe(0);
    expect(sides.customers.liveWorkspaces).toBe(1);
    expect(sides.customers.usdcInWallets).toBe(40);
  });

  it("gives one row per day with payments, oldest first, split by side", async () => {
    const { daily } = await openNumbers(null);
    expect(daily).toEqual([
      { day: "2026-09-26", customers: 0, ours: 1, customersUsdc: 0, oursUsdc: 1 },
      { day: "2026-09-27", customers: 0, ours: 1, customersUsdc: 0, oursUsdc: 2 },
      { day: "2026-09-28", customers: 1, ours: 0, customersUsdc: 5, oursUsdc: 0 },
      { day: "2026-09-29", customers: 1, ours: 0, customersUsdc: 3, oursUsdc: 0 },
    ]);
  });

  it("lists only our own payments that carry a hash, never a customer's", async () => {
    const { ourPayments } = await openNumbers(null);
    expect(ourPayments).toHaveLength(1);
    expect(ourPayments[0]).toMatchObject({ amount: 2, txHash: "0xh1", chain: "ARC-TESTNET" });
    expect(new Date(ourPayments[0].at).toISOString()).toBe("2026-09-27T10:00:00.000Z");
  });

  it("runs for the service role", async () => {
    const result = await asServiceRole(db, (tx) => tx.query<{ n: Numbers }>("select public.open_numbers(null) as n"));
    expect(result.rows[0].n.sides.total.payments).toBe(4);
  });

  it("is closed to the browser roles, as is the team list", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.open_numbers(null)"))).rejects.toThrow(/permission denied/);
      await expect(asRole(db, role, (tx) => tx.query("select * from public.platform_team_members()"))).rejects.toThrow(/permission denied/);
      await expect(
        asRole(db, role, (tx) => tx.query("select public.set_platform_team_member('owner@customer.test', true)"))
      ).rejects.toThrow(/permission denied/);
      await expect(asRole(db, role, (tx) => tx.query("select * from public.platform_team"))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("the team list (0037)", () => {
  it("adds a person once, by email in any case, and removes them", async () => {
    const add = async () =>
      (await db.query<{ changed: boolean }>("select public.set_platform_team_member(' OWNER@customer.test ', true) as changed")).rows[0].changed;
    expect(await add()).toBe(true);
    expect(await add()).toBe(false);

    const members = await db.query<{ email: string }>("select email from public.platform_team_members()");
    expect(members.rows.map((row) => row.email)).toEqual(["team@vestiarion.test", "owner@customer.test"]);

    const removed = await db.query<{ changed: boolean }>(
      "select public.set_platform_team_member('owner@customer.test', false) as changed"
    );
    expect(removed.rows[0].changed).toBe(true);
  });

  it("refuses an email with no account", async () => {
    await expect(db.query("select public.set_platform_team_member('nobody@example.test', true)")).rejects.toThrow(/user_not_found/);
  });
});
