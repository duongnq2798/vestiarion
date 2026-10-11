import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, appendSignedForOrg, asRole, asServiceRole, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0100 (docs/superpowers/specs/2026-10-11-landing-recent-decisions-design.md D1, D2): `recent_team_decisions()`,
 * the agent's newest decisions in the team's own live workspaces, one per bill, for the landing's list under its latest
 * decision, and how many decisions each network saw in the past week. Never a customer's, a sandbox's, a workspace whose
 * creator left, or one about a sample payee; only the fields the page may show; no signature and no workspace id.
 */

interface Decision {
  seq: number;
  ts: string;
  action: string;
  network: string;
  amount: number | null;
  currency: string;
  decisionMode: string | null;
  agreedWithReference: boolean | null;
  guardrailBlocked: boolean | null;
  guardrailRule: string | null;
  heldBecause: string | null;
  resultingStatus: string | null;
  txRef: string | null;
  payOn: string | null;
  verdict: string | null;
  paidTxHash: string | null;
  paymentFailed: boolean;
}

interface Recent {
  decisions: Decision[];
  pastWeek: { "arc-mainnet": number; "arc-testnet": number };
}

const { privateKey } = crypto.generateKeyPairSync("ed25519");
const TX = `0x${"ab".repeat(32)}`;

let db: PGlite;
let team: string;
let customer: string;

const recent = async (limit?: number): Promise<Recent> =>
  (await db.query<{ r: Recent }>(limit === undefined ? "select public.recent_team_decisions() as r" : "select public.recent_team_decisions($1) as r", limit === undefined ? [] : [limit]))
    .rows[0].r;

async function org(slug: string, createdBy: string | null, mode: "live" | "sandbox" = "live", network = "arc-testnet"): Promise<string> {
  const result = await db.query<{ id: string }>("insert into public.orgs (slug, name, mode, created_by, network) values ($1, $1, $2, $3, $4) returning id", [
    slug,
    mode,
    createdBy,
    network,
  ]);
  return result.rows[0].id;
}

async function payee(orgId: string, name: string, sample = false): Promise<string> {
  const result = await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role, sample) values ($1, $2, 'vendor', $3) returning id", [
    orgId,
    name,
    sample,
  ]);
  return result.rows[0].id;
}

/** An AP decision, written the way the AP stage writes one (src/lib/agent/orchestrator.ts). */
function decision(
  counterpartyId: string,
  fields: { action?: string; invoiceId?: string; amount?: number; execution?: Record<string, unknown>; extra?: Record<string, unknown> } = {}
) {
  const action = fields.action ?? "pay";
  return {
    actor: "agent" as const,
    domain: "ap" as const,
    action: `ap_${action}`,
    summary: `${action.toUpperCase()} INV-7 from Northwind Supply: the model's reasoning, with names`,
    detail: {
      invoiceId: fields.invoiceId ?? crypto.randomUUID(),
      counterpartyId,
      currency: "USDC",
      decision: { action, reasoning: "Northwind's bill matches PO-7.", confidence: 0.9 },
      decisionMode: "deepseek",
      referenceDecision: { action },
      agreedWithReference: true,
      guardrailBlocked: false,
      guardrailRule: null,
      observed: { amount: fields.amount ?? 0.35, paymentLimit: 5, riskLevel: "clear" },
      execution: { txRef: TX, resultingStatus: "paid", ...fields.execution },
      ...fields.extra,
    },
  };
}

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  team = await createUser(db, "team@vestiarion.test");
  await db.query("select public.set_platform_team_member('team@vestiarion.test', true)");
  customer = await createUser(db, "owner@customer.test");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("recent_team_decisions (0100)", () => {
  it("is an empty list, with nothing counted, before the team's workspaces have decided anything", async () => {
    expect(await recent()).toEqual({ decisions: [], pastWeek: { "arc-mainnet": 0, "arc-testnet": 0 } });
  });

  it("lists the team's decisions newest first, one per bill, its newest, with only the fields the page may show", async () => {
    const ours = await org("ours-live", team);
    const supplier = await payee(ours, "Northwind Supply");
    const bill = crypto.randomUUID();
    // The agent held the bill twice for cash, then paid it: one row, the payment.
    await appendSignedForOrg(db, ours, decision(supplier, { action: "hold", invoiceId: bill, execution: { txRef: null, resultingStatus: "held", heldBecause: "cash_shortfall" } }), privateKey);
    await appendSignedForOrg(db, ours, decision(supplier, { action: "hold", invoiceId: bill, execution: { txRef: null, resultingStatus: "held", heldBecause: "cash_shortfall" } }), privateKey);
    const paid = await appendSignedForOrg(db, ours, decision(supplier, { invoiceId: bill }), privateKey);
    const refused = await appendSignedForOrg(
      db,
      ours,
      decision(supplier, { amount: 0.5, execution: { txRef: null, resultingStatus: "held" }, extra: { guardrailBlocked: true, guardrailRule: "bridge.fee_above_cap" } }),
      privateKey
    );
    // A person's own entry is not a decision of the agent's.
    await appendSignedForOrg(db, ours, { actor: "human", domain: "ap", action: "approval_paid", summary: "Approved", detail: {} }, privateKey);

    const found = await recent();
    expect(found.decisions.map((row) => Number(row.seq))).toEqual([Number(refused.seq), Number(paid.seq)]);
    expect(found.decisions[0]).toMatchObject({ action: "ap_pay", amount: 0.5, guardrailBlocked: true, guardrailRule: "bridge.fee_above_cap", resultingStatus: "held", txRef: null });
    expect(found.decisions[1]).toMatchObject({
      action: "ap_pay",
      network: "arc-testnet",
      amount: 0.35,
      currency: "USDC",
      decisionMode: "deepseek",
      agreedWithReference: true,
      guardrailBlocked: false,
      heldBecause: null,
      resultingStatus: "paid",
      txRef: TX,
      verdict: null,
      paidTxHash: null,
      paymentFailed: false,
    });
    // Every decision counts this week, the two holds included; the list shows one row per bill.
    expect(found.pastWeek).toEqual({ "arc-mainnet": 0, "arc-testnet": 4 });
    // Never the entry's summary, the model's reasoning, a name or id, the workspace, or the signed chain.
    const text = JSON.stringify(found);
    for (const secret of ["Northwind", "PO-7", "reasoning", "INV-7", supplier, bill, ours, "invoiceId", "counterpartyId", "summary", "orgId", "signature", paid.hash]) {
      expect(text).not.toContain(secret);
    }
  });

  it("never lists or counts a customer's, a sandbox's, a former member's, or a sample payee's decision, however new", async () => {
    const before = await recent();
    const theirs = await org("customer-live", customer);
    await appendSignedForOrg(db, theirs, decision(await payee(theirs, "Their supplier")), privateKey);
    const sandbox = await org("ours-sandbox", team, "sandbox");
    await appendSignedForOrg(db, sandbox, decision(await payee(sandbox, "Sandbox supplier")), privateKey);
    const orphan = await org("creator-left", null);
    await appendSignedForOrg(db, orphan, decision(await payee(orphan, "Orphan supplier")), privateKey);
    const ours = await org("ours-sample", team);
    await appendSignedForOrg(db, ours, decision(await payee(ours, "Sample supplier", true)), privateKey);

    expect(await recent()).toEqual(before);
  });

  it("names each decision's network and counts each network's week on its own", async () => {
    const mainnet = await org("ours-mainnet", team, "live", "arc-mainnet");
    const supplier = await payee(mainnet, "Mainnet supplier");
    const row = await appendSignedForOrg(db, mainnet, decision(supplier, { amount: 0.12 }), privateKey);

    const found = await recent();
    expect(found.decisions[0]).toMatchObject({ seq: Number(row.seq), network: "arc-mainnet", amount: 0.12 });
    expect(found.pastWeek).toEqual({ "arc-mainnet": 1, "arc-testnet": 4 });
  });

  it("counts only the past 7 days, and still lists an older decision", async () => {
    const ours = await org("ours-older", team);
    const row = await appendSignedForOrg(db, ours, decision(await payee(ours, "Older supplier")), privateKey);
    await db.query("update public.ledger_entries set ts = now() - interval '8 days' where seq = $1", [row.seq]);

    const found = await recent(12);
    expect(found.decisions.map((decision) => Number(decision.seq))).toContain(Number(row.seq));
    expect(found.pastWeek).toEqual({ "arc-mainnet": 1, "arc-testnet": 4 });
  });

  it("gives a person's verdict and the transaction of the payment that followed, once it confirmed", async () => {
    const ours = await org("ours-agreed", team);
    const supplier = await payee(ours, "Agreed supplier");
    const entry = decision(supplier, { execution: { txRef: null, resultingStatus: "held", heldBecause: "shadow_verdict" } });
    const row = await appendSignedForOrg(db, ours, entry, privateKey);
    await db.query(
      "insert into public.decision_verdicts (org_id, entry_seq, subject, subject_id, agent_action, verdict, reason) values ($1, $2, 'invoice', gen_random_uuid(), 'pay', 'agree', 'Matches what we ordered from them')",
      [ours, row.seq]
    );
    await db.query(
      `insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status, tx_hash, chain)
       values ($1, 'invoice', $2, gen_random_uuid()::text, 'circle', 'live', 0.35, '0xAAA', 'confirmed', $3, 'ARC-TESTNET')`,
      [ours, entry.detail.invoiceId, `0x${"cd".repeat(32)}`]
    );

    const found = await recent();
    expect(found.decisions[0]).toMatchObject({ seq: Number(row.seq), heldBecause: "shadow_verdict", verdict: "agree", paidTxHash: `0x${"cd".repeat(32)}` });
    expect(JSON.stringify(found)).not.toContain("ordered from them");
  });

  it("says a payment failed when one did and none confirmed", async () => {
    const ours = await org("ours-failed", team);
    const supplier = await payee(ours, "Failed supplier");
    const entry = decision(supplier, { execution: { txRef: null, resultingStatus: "matched" } });
    const row = await appendSignedForOrg(db, ours, entry, privateKey);
    await db.query(
      `insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status, tx_hash, chain)
       values ($1, 'invoice', $2, gen_random_uuid()::text, 'circle', 'live', 0.35, '0xAAA', 'failed', null, 'ARC-TESTNET')`,
      [ours, entry.detail.invoiceId]
    );
    expect((await recent()).decisions[0]).toMatchObject({ seq: Number(row.seq), resultingStatus: "matched", paymentFailed: true, paidTxHash: null });
    // Retried, and confirmed: paid, not failed.
    await db.query("update public.payment_intents set status = 'confirmed', tx_hash = $2 where source_id = $1", [entry.detail.invoiceId, `0x${"ef".repeat(32)}`]);
    expect((await recent()).decisions[0]).toMatchObject({ seq: Number(row.seq), paymentFailed: false, paidTxHash: `0x${"ef".repeat(32)}` });
  });

  it("never lists or counts a decision made where payments are simulated", async () => {
    const before = await recent(12);
    const ours = await org("ours-simulated", team);
    await appendSignedForOrg(db, ours, decision(await payee(ours, "Simulated supplier"), { execution: { txRef: "sim_1", chainMode: "simulate" } }), privateKey);
    expect(await recent(12)).toEqual(before);
  });

  it("returns at most the number asked for, between 1 and 12", async () => {
    expect((await recent(2)).decisions).toHaveLength(2);
    expect((await recent(0)).decisions).toHaveLength(1);
    const all = (await recent(100)).decisions;
    expect(all.length).toBeGreaterThan(2);
    expect(all.length).toBeLessThanOrEqual(12);
    expect((await recent()).decisions.length).toBeLessThanOrEqual(6);
  });

  it("is the service role's alone", async () => {
    await expect(asRole(db, "anon", (tx) => tx.query("select public.recent_team_decisions()"))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select public.recent_team_decisions(3)"))).rejects.toThrow(/permission denied/);
    const served = await asServiceRole(db, (tx) => tx.query<{ r: Recent }>("select public.recent_team_decisions(3) as r"));
    expect(served.rows[0].r.decisions.length).toBeGreaterThan(0);
  });
});
