import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0089 (docs/superpowers/specs/2026-10-09-activation-funnel-design.md): `open_funnel(p_since, p_network)`, how
 * far the workspaces opened since a day got, split like the other open numbers: opened, a real bill, the agent's decision
 * on it, a confirmed payment, payments on two days or more, a verdict, two people. Counts of workspaces only.
 */

interface Side {
  opened: number;
  withRealBill: number;
  withDecision: number;
  withPayment: number;
  paidOnTwoDays: number;
  withVerdict: number;
  withTwoPeople: number;
}
interface Funnel {
  sides: { customers: Side; ours: Side; total: Side };
}

let db: PGlite;
let seq = 0;
// What the migrations alone leave (a workspace they seed counts as ours): measured before the rows below are added.
let baseline: { all: Funnel; sinceOct4: Funnel };

async function org(slug: string, createdBy: string, opened: string, network = "arc-testnet"): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into public.orgs (slug, name, mode, created_by, created_at, network) values ($1, $1, 'live', $2, $3, $4) returning id",
    [slug, createdBy, opened, network]
  );
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [result.rows[0].id, createdBy]);
  return result.rows[0].id;
}

async function payable(orgId: string, name: string, sample = false): Promise<string> {
  const counterparty = await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role, sample) values ($1, $2, 'vendor', $3) returning id", [
    orgId,
    name,
    sample,
  ]);
  const invoice = await db.query<{ id: string }>(
    "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status) values ($1, 'payable', $2, 1, '2026-10-10T00:00:00Z', 'held') returning id",
    [orgId, counterparty.rows[0].id]
  );
  return invoice.rows[0].id;
}

async function decision(orgId: string, invoiceId: string, at: string): Promise<void> {
  seq += 1;
  await db.query(
    `insert into public.ledger_entries (org_id, ts, actor, domain, action, summary, detail, body_hash, signature, prev_hash, hash)
     values ($1, $2, 'agent', 'ap', 'ap_pay', 'pay', $3, 'b', 's', 'p', gen_random_uuid()::text)`,
    [orgId, at, JSON.stringify({ invoiceId, decision: { action: "pay" }, execution: { resultingStatus: "held" } })]
  );
}

async function payment(orgId: string, invoiceId: string, at: string, provider: "circle" | "simulate" = "circle"): Promise<void> {
  await db.query(
    `insert into public.payment_intents
       (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status, executed_at, tx_hash, chain)
     values ($1, 'invoice', $2, gen_random_uuid()::text, $3, $4, 1, '0xAAA', 'confirmed', $5, '0xtx', 'ARC-TESTNET')`,
    [orgId, invoiceId, provider, provider === "circle" ? "live" : "simulate", at]
  );
}

async function verdict(orgId: string, invoiceId: string): Promise<void> {
  seq += 1;
  await db.query(
    "insert into public.decision_verdicts (org_id, entry_seq, subject, subject_id, agent_action, verdict, reason, decided_at) values ($1, $2, 'invoice', $3, 'ap_pay', 'agree', null, '2026-10-08T09:00:00Z')",
    [orgId, seq, invoiceId]
  );
}

const funnel = async (since: string | null, network = "arc-testnet"): Promise<Funnel> =>
  (await db.query<{ n: Funnel }>("select public.open_funnel($1::timestamptz, $2) as n", [since, network])).rows[0].n;

const numeric = (side: Side) => Object.fromEntries(Object.entries(side).map(([key, value]) => [key, Number(value)]));

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  baseline = { all: await funnel(null), sinceOct4: await funnel("2026-10-04T00:00:00Z") };

  const team = await createUser(db, "team@vestiarion.test");
  await db.query("select public.set_platform_team_member('team@vestiarion.test', true)");
  const owner = await createUser(db, "owner@customer.test");
  const colleague = await createUser(db, "colleague@customer.test");

  // Opened and nothing else, as two sandboxes were.
  await org("idle", owner, "2026-09-29T23:30:00Z");
  // Only sample data: no real bill.
  const sampleOnly = await org("sample-only", owner, "2026-09-30T10:00:00Z");
  const sampleBill = await payable(sampleOnly, "Sample Vendor", true);
  await decision(sampleOnly, sampleBill, "2026-09-30T10:01:00Z");
  await payment(sampleOnly, sampleBill, "2026-09-30T10:02:00Z");
  // A real bill and a decision, never paid.
  const decidedOnly = await org("decided-only", owner, "2026-10-01T13:13:00Z");
  await decision(decidedOnly, await payable(decidedOnly, "Hetzner"), "2026-10-01T13:20:00Z");
  // Paid once, and a simulated payment on another day, which does not count.
  const paidOnce = await org("paid-once", owner, "2026-10-04T12:36:00Z");
  const once = await payable(paidOnce, "Courier");
  await decision(paidOnce, once, "2026-10-04T12:38:00Z");
  await payment(paidOnce, once, "2026-10-04T12:39:00Z");
  await payment(paidOnce, await payable(paidOnce, "Courier Two"), "2026-10-06T09:00:00Z", "simulate");
  // Paid on two days, with verdicts and a second person.
  const regular = await org("regular", owner, "2026-10-08T13:08:00Z");
  const first = await payable(regular, "Contabo");
  const second = await payable(regular, "DigitalOcean");
  await decision(regular, first, "2026-10-08T13:10:00Z");
  await payment(regular, first, "2026-10-08T13:15:00Z");
  await payment(regular, second, "2026-10-09T08:00:00Z");
  await verdict(regular, first);
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'approver')", [regular, colleague]);

  // Ours, paid, and a customer's workspace on Arc mainnet.
  const ours = await org("ours", team, "2026-09-30T00:00:00Z");
  const ourBill = await payable(ours, "Our vendor");
  await decision(ours, ourBill, "2026-09-30T01:00:00Z");
  await payment(ours, ourBill, "2026-09-30T02:00:00Z");
  await org("cust-main", owner, "2026-10-07T00:00:00Z", "arc-mainnet");
});

afterAll(async () => {
  await db.close();
});

describe("open_funnel (0089)", () => {
  it("counts how far each workspace got, customers apart from ours, never on sample data", async () => {
    const { sides } = await funnel(null);
    expect(numeric(sides.customers)).toEqual({
      opened: 5,
      withRealBill: 3,
      withDecision: 3,
      withPayment: 2,
      paidOnTwoDays: 1,
      withVerdict: 1,
      withTwoPeople: 1,
    });
    expect(Number(sides.ours.opened) - Number(baseline.all.sides.ours.opened)).toBe(1);
    expect(Number(sides.ours.withPayment) - Number(baseline.all.sides.ours.withPayment)).toBe(1);
    expect(Number(sides.total.opened) - Number(baseline.all.sides.total.opened)).toBe(6);
    expect(Number(sides.total.withPayment) - Number(baseline.all.sides.total.withPayment)).toBe(3);
  });

  it("counts the workspaces opened since the period's start", async () => {
    const { sides } = await funnel("2026-10-04T00:00:00Z");
    expect(numeric(sides.customers)).toEqual({ opened: 2, withRealBill: 2, withDecision: 2, withPayment: 2, paidOnTwoDays: 1, withVerdict: 1, withTwoPeople: 1 });
    expect(Number(sides.ours.opened)).toBe(Number(baseline.sinceOct4.sides.ours.opened));
  });

  it("counts each network apart", async () => {
    const { sides } = await funnel(null, "arc-mainnet");
    expect(numeric(sides.customers)).toEqual({ opened: 1, withRealBill: 0, withDecision: 0, withPayment: 0, paidOnTwoDays: 0, withVerdict: 0, withTwoPeople: 0 });
  });

  it("runs for the service role only", async () => {
    const result = await asServiceRole(db, (tx) => tx.query<{ n: Funnel }>("select public.open_funnel(null, 'arc-testnet') as n"));
    expect(Number(result.rows[0].n.sides.total.opened) - Number(baseline.all.sides.total.opened)).toBe(6);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.open_funnel(null, 'arc-testnet')"))).rejects.toThrow(/permission denied/);
    }
  });
});
