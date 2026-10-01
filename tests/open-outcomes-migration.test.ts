import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0049 (docs/superpowers/specs/2026-10-01-open-outcomes-design.md):
 * `open_outcomes(p_since)`, how the agent's payment decisions turned out —
 * carried out or escalated (R3, R4), what people did with its flags (R5),
 * invoices paid on time and untouched (R6, R7), duplicates caught (R8) — split
 * like the other open numbers.
 */

interface Side {
  decisionsCarriedOut: number;
  decisionsEscalated: number;
  escalationsResolved: number;
  flagsResolved: number;
  flagsUpheld: number;
  invoicesPaidOnArc: number;
  invoicesPaidOnTime: number;
  invoicesPaidOnTimeUntouched: number;
  duplicatesCaught: number;
}
interface Outcomes {
  sides: { customers: Side; ours: Side; total: Side };
}

let db: PGlite;

async function org(slug: string, createdBy: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into public.orgs (slug, name, mode, created_by, created_at) values ($1, $1, 'live', $2, '2026-09-20T00:00:00Z') returning id",
    [slug, createdBy]
  );
  return result.rows[0].id;
}

async function counterparty(orgId: string, name: string, role: "vendor" | "contractor" = "vendor", sample = false): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into public.counterparties (org_id, name, role, sample) values ($1, $2, $3, $4) returning id",
    [orgId, name, role, sample]
  );
  return result.rows[0].id;
}

async function invoice(
  orgId: string,
  counterpartyId: string,
  fields: { due: string; status: string; reviewedBy?: string }
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, reviewed_by, scheduled_for)
     values ($1, 'payable', $2, 1, ($3 || 'T00:00:00Z')::timestamptz, $4, $5, ($6 || 'T00:00:00Z')::timestamptz) returning id`,
    [orgId, counterpartyId, fields.due, fields.status, fields.reviewedBy ?? null, fields.status === "scheduled" ? fields.due : null]
  );
  return result.rows[0].id;
}

async function milestone(orgId: string, contractorId: string, status: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into public.milestones (org_id, contractor_id, title, amount, status) values ($1, $2, 'Work', 1, $3) returning id",
    [orgId, contractorId, status]
  );
  return result.rows[0].id;
}

/** One ledger entry; entries must be written in time order, as the ledger itself is. */
async function entry(orgId: string, at: string, fields: { actor: "agent" | "human"; domain: string; action: string; detail: object }): Promise<void> {
  await db.query(
    `insert into public.ledger_entries (org_id, ts, actor, domain, action, summary, detail, body_hash, signature, prev_hash, hash)
     values ($1, $2, $3, $4, $5, $5, $6, 'b', 's', 'p', gen_random_uuid()::text)`,
    [orgId, at, fields.actor, fields.domain, fields.action, JSON.stringify(fields.detail)]
  );
}

/** An agent's decision on a payable, recorded under the action it proposed, with what actually happened. */
const apDecision = (orgId: string, at: string, invoiceId: string, proposed: string, resultingStatus: string, extra: object = {}) =>
  entry(orgId, at, {
    actor: "agent",
    domain: "ap",
    action: `ap_${proposed}`,
    detail: { invoiceId, decision: { action: proposed }, guardrailRule: null, execution: { resultingStatus }, ...extra },
  });

const strongMatch = { observed: { duplicateCheck: { matches: [{ otherInvoiceStatus: "paid", confidence: 0.95 }] } } };
const weakMatch = { observed: { duplicateCheck: { matches: [{ otherInvoiceStatus: "paid", confidence: 0.6 }] } } };

async function payment(orgId: string, invoiceId: string, at: string, fields: { provider?: "circle" | "simulate"; status?: string } = {}): Promise<void> {
  const provider = fields.provider ?? "circle";
  await db.query(
    `insert into public.payment_intents
       (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status, executed_at, tx_hash, chain)
     values ($1, 'invoice', $2, gen_random_uuid()::text, $3, $4, 1, '0xAAA', $5, $6, '0xtx', 'ARC-TESTNET')`,
    [orgId, invoiceId, provider, provider === "circle" ? "live" : "simulate", fields.status ?? "confirmed", at]
  );
}

const outcomes = async (since: string | null): Promise<Outcomes> =>
  (await db.query<{ n: Outcomes }>("select public.open_outcomes($1::timestamptz) as n", [since])).rows[0].n;

const numeric = (side: Side) => Object.fromEntries(Object.entries(side).map(([key, value]) => [key, Number(value)]));

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);

  const team = await createUser(db, "team@vestiarion.test");
  await db.query("select public.set_platform_team_member('team@vestiarion.test', true)");
  const owner = await createUser(db, "owner@customer.test");

  const ours = await org("ours-co", team);
  const cust = await org("cust-co", owner);
  const acme = await counterparty(cust, "Acme");
  const sample = await counterparty(cust, "Sample Vendor", "vendor", true);
  const kit = await counterparty(cust, "Kit", "contractor");
  const oursVendor = await counterparty(ours, "Ours Vendor");

  // Ours: one invoice the agent paid itself, on time.
  const inv20 = await invoice(ours, oursVendor, { due: "2026-09-30", status: "paid" });
  await apDecision(ours, "2026-09-27T10:00:00Z", inv20, "pay", "paid");
  await payment(ours, inv20, "2026-09-27T10:00:00Z");

  // 1: paid by the agent late on its due day (UTC): on time, untouched.
  const inv1 = await invoice(cust, acme, { due: "2026-09-28", status: "paid" });
  // 3: flagged, then a person paid it anyway: escalated, a flag overturned, paid on time but touched.
  const inv3 = await invoice(cust, acme, { due: "2026-09-30", status: "paid", reviewedBy: owner });
  // 4: the model proposed pay and code refused it; a person rejected the hold.
  const inv4 = await invoice(cust, acme, { due: "2026-09-30", status: "rejected", reviewedBy: owner });
  // 5: code refused a duplicate of a settled invoice; a person rejected it: a flag upheld, a duplicate caught.
  const inv5 = await invoice(cust, acme, { due: "2026-09-30", status: "rejected", reviewedBy: owner });
  // 6: the model flagged a strong duplicate, still flagged; flagged again after the period starts.
  const inv6 = await invoice(cust, acme, { due: "2026-09-30", status: "flagged" });
  // 7: the model flagged a strong duplicate and a person paid it: not caught.
  const inv7 = await invoice(cust, acme, { due: "2026-10-05", status: "paid", reviewedBy: owner });
  // 8: a weak flag, still flagged: escalated, not a caught duplicate.
  const inv8 = await invoice(cust, acme, { due: "2026-09-30", status: "flagged" });
  // 9: an information request a person returned to the agent.
  const inv9 = await invoice(cust, acme, { due: "2026-09-30", status: "pending", reviewedBy: owner });
  // 10: scheduled by the agent.
  const inv10 = await invoice(cust, acme, { due: "2026-10-03", status: "scheduled" });
  // 11: a wait, neither carried out nor escalated.
  const inv11 = await invoice(cust, acme, { due: "2026-10-03", status: "pending" });
  // 12: sample data, never counted.
  const inv12 = await invoice(cust, sample, { due: "2026-09-30", status: "paid" });
  // 13: paid in a sandbox (simulated): a decision carried out, not a payment on Arc.
  const inv13 = await invoice(cust, acme, { due: "2026-09-30", status: "paid" });
  // 2: paid by the agent the day after its due date (UTC).
  const inv2 = await invoice(cust, acme, { due: "2026-09-28", status: "paid" });
  // 14: its only payment failed on Arc: never counted as paid.
  const inv14 = await invoice(cust, acme, { due: "2026-09-30", status: "held" });
  const m1 = await milestone(cust, kit, "paid");
  const m2 = await milestone(cust, kit, "held");

  await apDecision(cust, "2026-09-28T10:00:00Z", inv2, "pay", "held"); // a hold before its later payment
  await payment(cust, inv14, "2026-09-28T10:30:00Z", { status: "failed" });
  await apDecision(cust, "2026-09-28T11:00:00Z", inv3, "flag_fraud", "flagged");
  await entry(cust, "2026-09-28T12:00:00Z", { actor: "human", domain: "ap", action: "approval_paid", detail: { invoiceId: inv3, overrode: "flagged" } });
  await payment(cust, inv3, "2026-09-28T12:00:00Z");
  await apDecision(cust, "2026-09-28T13:00:00Z", inv4, "pay", "held", { guardrailBlocked: true });
  await entry(cust, "2026-09-28T14:00:00Z", { actor: "human", domain: "ap", action: "approval_rejected", detail: { invoiceId: inv4 } });
  await apDecision(cust, "2026-09-28T15:00:00Z", inv5, "pay", "flagged", { guardrailRule: "invoice.duplicate_of_settled" });
  await entry(cust, "2026-09-28T16:00:00Z", { actor: "human", domain: "ap", action: "approval_rejected", detail: { invoiceId: inv5 } });
  await apDecision(cust, "2026-09-28T17:00:00Z", inv6, "flag_fraud", "flagged", strongMatch);
  await apDecision(cust, "2026-09-28T18:00:00Z", inv7, "flag_fraud", "flagged", strongMatch);
  await entry(cust, "2026-09-28T18:30:00Z", { actor: "human", domain: "ap", action: "approval_paid", detail: { invoiceId: inv7, overrode: "flagged" } });
  await payment(cust, inv7, "2026-09-28T18:30:00Z");
  await apDecision(cust, "2026-09-28T18:45:00Z", inv8, "flag_fraud", "flagged", weakMatch);
  await apDecision(cust, "2026-09-28T19:00:00Z", inv9, "request_info", "awaiting_info");
  await entry(cust, "2026-09-28T19:30:00Z", { actor: "human", domain: "ap", action: "approval_returned", detail: { invoiceId: inv9 } });
  await apDecision(cust, "2026-09-28T20:00:00Z", inv10, "schedule", "scheduled");
  await apDecision(cust, "2026-09-28T21:00:00Z", inv13, "pay", "paid");
  await payment(cust, inv13, "2026-09-28T21:00:00Z", { provider: "simulate" });
  await apDecision(cust, "2026-09-28T21:30:00Z", inv11, "wait", "pending");
  await apDecision(cust, "2026-09-28T22:00:00Z", inv12, "pay", "paid");
  await payment(cust, inv12, "2026-09-28T22:00:00Z");
  await entry(cust, "2026-09-28T22:30:00Z", {
    actor: "agent",
    domain: "contractor",
    action: "milestone_release",
    detail: { milestoneId: m1, decision: { action: "release" }, execution: { resultingStatus: "paid" } },
  });
  await entry(cust, "2026-09-28T23:00:00Z", {
    actor: "agent",
    domain: "contractor",
    action: "milestone_hold",
    detail: { milestoneId: m2, decision: { action: "hold" }, execution: { resultingStatus: "held" } },
  });
  // A treasury decision and a decision about an invoice that no longer exists never count.
  await entry(cust, "2026-09-28T23:10:00Z", { actor: "agent", domain: "treasury", action: "hold", detail: { decision: { action: "hold" } } });
  await apDecision(cust, "2026-09-28T23:20:00Z", "00000000-0000-4000-8000-000000000000", "pay", "paid");
  await apDecision(cust, "2026-09-28T23:30:00Z", inv1, "pay", "paid");
  await payment(cust, inv1, "2026-09-28T23:30:00Z");

  // After 2026-09-29: inv2 paid late, and inv6 flagged again (already caught before).
  await apDecision(cust, "2026-09-29T00:30:00Z", inv2, "pay", "paid");
  await payment(cust, inv2, "2026-09-29T00:30:00Z");
  await apDecision(cust, "2026-09-29T01:00:00Z", inv6, "flag_fraud", "flagged", strongMatch);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("open_outcomes (0049)", () => {
  it("classifies payment decisions by what happened, not by what was proposed", async () => {
    const { sides } = await outcomes(null);
    // Carried out: inv1, inv2 (paid), inv10 (scheduled), inv13 (simulated pay), m1. Escalated: inv2's first
    // hold, inv3, inv4 (pay refused by code), inv5, inv6 twice, inv7, inv8, inv9, m2.
    expect(numeric(sides.customers)).toMatchObject({ decisionsCarriedOut: 5, decisionsEscalated: 10 });
    expect(numeric(sides.ours)).toMatchObject({ decisionsCarriedOut: 1, decisionsEscalated: 0 });
    expect(numeric(sides.total)).toMatchObject({ decisionsCarriedOut: 6, decisionsEscalated: 10 });
  });

  it("measures agreement on flags only: rejected upholds, paid overturns, returned is neither", async () => {
    const { sides } = await outcomes(null);
    // Resolutions: inv3 paid (flag), inv4 rejected (hold), inv5 rejected (flag), inv7 paid (flag), inv9 returned.
    expect(numeric(sides.customers)).toMatchObject({ escalationsResolved: 5, flagsResolved: 3, flagsUpheld: 1 });
    expect(numeric(sides.total)).toMatchObject({ escalationsResolved: 5, flagsResolved: 3, flagsUpheld: 1 });
  });

  it("counts invoices paid on Arc testnet by their confirmed live payment, on time by UTC day", async () => {
    const { sides } = await outcomes(null);
    // inv1 (on its due day), inv2 (a day late), inv3, inv7. Not inv12 (sample), inv13 (simulated) or inv14 (failed).
    expect(numeric(sides.customers)).toMatchObject({ invoicesPaidOnArc: 4, invoicesPaidOnTime: 3, invoicesPaidOnTimeUntouched: 1 });
    expect(numeric(sides.ours)).toMatchObject({ invoicesPaidOnArc: 1, invoicesPaidOnTime: 1, invoicesPaidOnTimeUntouched: 1 });
  });

  it("counts confirmed duplicates that were never paid, once each", async () => {
    const { sides } = await outcomes(null);
    // inv5 (code rule) and inv6 (strong match, flagged twice). Not inv7 (paid since) or inv8 (weak).
    expect(numeric(sides.customers)).toMatchObject({ duplicatesCaught: 2 });
  });

  it("counts each figure in the period of its decision, resolution or payment", async () => {
    const { sides } = await outcomes("2026-09-29T00:00:00Z");
    expect(numeric(sides.customers)).toEqual({
      decisionsCarriedOut: 1,
      decisionsEscalated: 1,
      escalationsResolved: 0,
      flagsResolved: 0,
      flagsUpheld: 0,
      invoicesPaidOnArc: 1,
      invoicesPaidOnTime: 0,
      invoicesPaidOnTimeUntouched: 0,
      // inv6 was first caught before the period.
      duplicatesCaught: 0,
    });
    expect(numeric(sides.ours)).toMatchObject({ decisionsCarriedOut: 0, invoicesPaidOnArc: 0 });
  });

  it("runs for the service role only", async () => {
    const result = await asServiceRole(db, (tx) => tx.query<{ n: Outcomes }>("select public.open_outcomes(null) as n"));
    expect(Number(result.rows[0].n.sides.total.decisionsCarriedOut)).toBe(6);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.open_outcomes(null)"))).rejects.toThrow(/permission denied/);
    }
  });
});
