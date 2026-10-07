import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0086 (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S8): `open_verdicts(p_since, p_network)`,
 * how often people agreed with the agent in shadow mode, split like the other open numbers: the verdicts given since
 * the period's start on payables that are not sample data, and how many agreed.
 */

interface Side {
  verdictsGiven: number;
  verdictsAgreed: number;
}
interface Verdicts {
  sides: { customers: Side; ours: Side; total: Side };
}

let db: PGlite;
let seq = 0;

async function org(slug: string, createdBy: string, network = "arc-testnet"): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into public.orgs (slug, name, mode, created_by, created_at, network) values ($1, $1, 'live', $2, '2026-09-20T00:00:00Z', $3) returning id",
    [slug, createdBy, network]
  );
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

async function verdict(orgId: string, invoiceId: string, given: "agree" | "disagree", at: string): Promise<void> {
  seq += 1;
  await db.query(
    "insert into public.decision_verdicts (org_id, entry_seq, subject, subject_id, agent_action, verdict, reason, decided_at) values ($1, $2, 'invoice', $3, 'ap_pay', $4, $5, $6)",
    [orgId, seq, invoiceId, given, given === "disagree" ? "Not our bill" : null, at]
  );
}

const verdicts = async (since: string | null, network = "arc-testnet"): Promise<Verdicts> =>
  (await db.query<{ n: Verdicts }>("select public.open_verdicts($1::timestamptz, $2) as n", [since, network])).rows[0].n;

const numeric = (side: Side) => ({ verdictsGiven: Number(side.verdictsGiven), verdictsAgreed: Number(side.verdictsAgreed) });

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);

  const team = await createUser(db, "team@vestiarion.test");
  await db.query("select public.set_platform_team_member('team@vestiarion.test', true)");
  const owner = await createUser(db, "owner@customer.test");

  const ours = await org("ours-co", team);
  const cust = await org("cust-co", owner);
  const onMainnet = await org("cust-main", owner, "arc-mainnet");

  const acme = await payable(cust, "Acme");
  const acmeAgain = await payable(cust, "Acme Two");
  const sample = await payable(cust, "Sample Vendor", true);
  await verdict(cust, acme, "agree", "2026-10-07T09:00:00Z");
  await verdict(cust, acmeAgain, "agree", "2026-10-08T09:00:00Z");
  await verdict(cust, acmeAgain, "disagree", "2026-10-08T10:00:00Z");
  // A sample payee's bill is never counted.
  await verdict(cust, sample, "agree", "2026-10-08T11:00:00Z");
  await verdict(ours, await payable(ours, "Our vendor"), "agree", "2026-10-08T09:00:00Z");
  await verdict(onMainnet, await payable(onMainnet, "Mainnet vendor"), "disagree", "2026-10-08T09:00:00Z");
});

afterAll(async () => {
  await db.close();
});

describe("open_verdicts (0086)", () => {
  it("counts the verdicts given and agreed, customers apart from ours, never on sample data", async () => {
    const { sides } = await verdicts(null);
    expect(numeric(sides.customers)).toEqual({ verdictsGiven: 3, verdictsAgreed: 2 });
    expect(numeric(sides.ours)).toEqual({ verdictsGiven: 1, verdictsAgreed: 1 });
    expect(numeric(sides.total)).toEqual({ verdictsGiven: 4, verdictsAgreed: 3 });
  });

  it("counts from the period's start", async () => {
    const { sides } = await verdicts("2026-10-08T00:00:00Z");
    expect(numeric(sides.customers)).toEqual({ verdictsGiven: 2, verdictsAgreed: 1 });
  });

  it("counts each network apart", async () => {
    const { sides } = await verdicts(null, "arc-mainnet");
    expect(numeric(sides.customers)).toEqual({ verdictsGiven: 1, verdictsAgreed: 0 });
    expect(numeric(sides.total)).toEqual({ verdictsGiven: 1, verdictsAgreed: 0 });
  });

  it("runs for the service role only", async () => {
    const result = await asServiceRole(db, (tx) => tx.query<{ n: Verdicts }>("select public.open_verdicts(null, 'arc-testnet') as n"));
    expect(Number(result.rows[0].n.sides.total.verdictsGiven)).toBe(4);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.open_verdicts(null, 'arc-testnet')"))).rejects.toThrow(/permission denied/);
    }
  });
});
