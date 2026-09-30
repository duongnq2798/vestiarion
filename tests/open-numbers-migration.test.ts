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
  daily: Array<{ day: string; customers: number; ours: number; oursUsdc: number }>;
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
  fields: {
    amount: number;
    destination: string;
    status: string;
    provider: string;
    at: string;
    txHash?: string | null;
    milestoneId?: string;
  }
): Promise<void> {
  await db.query(
    `insert into public.payment_intents
       (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status, executed_at, tx_hash, chain)
     values ($1, $9, coalesce($10::uuid, gen_random_uuid()), gen_random_uuid()::text, $2, $3, $4, $5, $6, $7, $8, 'ARC-TESTNET')`,
    [
      orgId,
      fields.provider,
      fields.provider === "circle" ? "live" : "simulate",
      fields.amount,
      fields.destination,
      fields.status,
      fields.at,
      fields.txHash ?? null,
      fields.milestoneId ? "milestone" : "invoice",
      fields.milestoneId ?? null,
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
  const reviewer = await createUser(db, "reviewer@elsewhere.test");
  const heir = await createUser(db, "heir@customer.test");
  await db.query("select public.set_platform_team_member('team@vestiarion.test', true)");

  const ours = await org("ours-co", "sandbox", teamUser);
  const customer = await org("cust-co", "live", customerUser);
  // A customer's live workspace whose creator deleted their account (0023 sets created_by null); another owner remains.
  const orphan = await org("orphan-co", "live", null);
  await db.query(
    `insert into public.memberships (org_id, user_id, role)
     values ($1, $2, 'owner'), ($1, $3, 'viewer'), ($4, $5, 'owner'), ($6, $7, 'owner')`,
    [ours, teamUser, reviewer, customer, customerUser, orphan, heir]
  );

  await db.query(
    `insert into public.accounts (org_id, name, kind, chain, token, circle_wallet_id, balance, balance_synced_at)
     values ($1, 'Operating', 'operating', 'ARC-TESTNET', 'USDC', 'w-1', 40, '2026-09-29T10:00:00Z'),
            ($1, 'Unprovisioned', 'reserve', 'ARC-TESTNET', 'USDC', null, 99, null),
            ($1, 'Base', 'chain', 'BASE-SEPOLIA', 'USDC', 'w-2', 7, '2026-09-29T10:00:00Z'),
            ($1, 'Seeded, never read', 'operating', 'ARC-TESTNET', 'USDC', 'w-3', 18500, null)`,
    [customer]
  );
  const acme = await counterparty(customer, "Acme");
  const sample = await counterparty(customer, "Sample Vendor", true);
  const milestones = await db.query<{ id: string; title: string }>(
    `insert into public.milestones (org_id, contractor_id, title, amount, status, settled_at)
     values ($1, $2, 'Shipped', 3, 'paid', '2026-09-20T10:00:00Z'),
            ($1, $2, 'Paid in a sandbox', 3, 'paid', '2026-09-29T10:00:00Z'),
            ($1, $3, 'Sample milestone', 3, 'paid', '2026-09-29T10:00:00Z'),
            ($1, $2, 'Not yet', 3, 'pending', null)
     returning id, title`,
    [customer, acme, sample]
  );
  const shipped = milestones.rows.find((row) => row.title === "Shipped")!.id;

  await payment(customer, { amount: 5, destination: "0xAAA", status: "confirmed", provider: "circle", at: "2026-09-28T10:00:00Z", txHash: "0xc1" });
  await payment(customer, {
    amount: 3,
    destination: "0xaaa",
    status: "confirmed",
    provider: "circle",
    at: "2026-09-29T10:00:00Z",
    txHash: "0xc2",
    milestoneId: shipped,
  });
  await payment(customer, { amount: 9, destination: "0xBBB", status: "pending", provider: "circle", at: "2026-09-29T11:00:00Z" });
  await payment(customer, { amount: 7, destination: "sim:x", status: "confirmed", provider: "simulate", at: "2026-09-29T12:00:00Z" });
  await payment(ours, { amount: 2, destination: "0xAAA", status: "confirmed", provider: "circle", at: "2026-09-27T10:00:00Z", txHash: "0xh1" });
  await payment(ours, { amount: 1, destination: "0xCCC", status: "confirmed", provider: "circle", at: "2026-09-26T10:00:00Z", txHash: null });
  await payment(orphan, { amount: 4, destination: "0xDDD", status: "confirmed", provider: "circle", at: "2026-09-25T10:00:00Z", txHash: "0xorphan" });

  await db.query(
    `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, decided_at)
     values ($1, 'payable', $2, 5, '2026-10-01', 'paid', '2026-09-28T10:00:00Z'),
            ($1, 'payable', $3, 5, '2026-10-01', 'paid', '2026-09-28T10:00:00Z'),
            ($1, 'payable', $2, 5, '2026-10-01', 'pending', null)`,
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
    expect(sides.ours).toMatchObject({ payments: 3, usdcPaid: 7, payees: 3 });
    // 0xAAA was paid by a customer and by us: once in the total.
    expect(sides.total).toMatchObject({ payments: 5, usdcPaid: 15, payees: 3 });
  });

  it("counts a workspace whose creator is gone, and the founding one, as ours, never a customer's", async () => {
    const { sides } = await openNumbers(null);
    expect(sides.customers.workspacesOpened).toBe(1);
    // founding (created by the migrations, no creator), ours-co, orphan-co
    expect(sides.ours.workspacesOpened).toBe(3);
    expect(sides.customers.liveWorkspaces).toBe(1);
    expect(sides.ours.liveWorkspaces).toBe(2); // founding (live in the migrations) and orphan-co
    expect(sides.total.workspacesOpened).toBe(4);
  });

  it("counts as customers only people off the team who belong to a customer's workspace", async () => {
    const { sides } = await openNumbers(null);
    // customers: the customer. ours: the team member, the reviewer invited to ours-co, the orphan's heir. total: each once.
    expect([sides.customers.people, sides.ours.people, sides.total.people]).toEqual([1, 3, 4]);
  });

  it("leaves sample data out of invoices", async () => {
    const { sides } = await openNumbers(null);
    expect(sides.customers.invoicesDecided).toBe(1);
  });

  it("counts a milestone as paid only when a settled Arc payment paid it, at that payment's time", async () => {
    expect((await openNumbers(null)).sides.customers.milestonesReleased).toBe(1);
    expect((await openNumbers("2026-09-29T00:00:00Z")).sides.customers.milestonesReleased).toBe(1);
    expect((await openNumbers("2026-09-30T00:00:00Z")).sides.customers.milestonesReleased).toBe(0);
  });

  it("sums the agent's cycles and what its decisions were", async () => {
    const { sides } = await openNumbers(null);
    expect(sides.customers).toMatchObject({ cycles: 1, modelDecisions: 3, policyDepartures: 1, refusedByCode: 1 });
    expect(sides.ours).toMatchObject({ cycles: 0, modelDecisions: 0 });
  });

  it("counts USDC in live workspaces' Circle wallets on Arc testnet, once read from the chain", async () => {
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
    // A customer's amounts never appear by day: with few customers a day's figure could point to one transfer.
    expect(daily).toEqual([
      { day: "2026-09-25", customers: 0, ours: 1, oursUsdc: 4 },
      { day: "2026-09-26", customers: 0, ours: 1, oursUsdc: 1 },
      { day: "2026-09-27", customers: 0, ours: 1, oursUsdc: 2 },
      { day: "2026-09-28", customers: 1, ours: 0, oursUsdc: 0 },
      { day: "2026-09-29", customers: 1, ours: 0, oursUsdc: 0 },
    ]);
  });

  it("lists only payments from workspaces the team opened, with a hash, never a customer's or a former customer's", async () => {
    const numbers = await openNumbers(null);
    const { ourPayments } = numbers;
    for (const hash of ["0xc1", "0xc2", "0xorphan"]) expect(JSON.stringify(numbers)).not.toContain(hash);
    expect(ourPayments).toHaveLength(1);
    expect(ourPayments[0]).toMatchObject({ amount: 2, txHash: "0xh1", chain: "ARC-TESTNET" });
    expect(new Date(ourPayments[0].at).toISOString()).toBe("2026-09-27T10:00:00.000Z");
  });

  it("runs for the service role", async () => {
    const result = await asServiceRole(db, (tx) => tx.query<{ n: Numbers }>("select public.open_numbers(null) as n"));
    expect(result.rows[0].n.sides.total.payments).toBe(5);
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
