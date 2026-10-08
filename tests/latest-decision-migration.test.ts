import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, appendSignedForOrg, asRole, asServiceRole, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0087 (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md R1, R2, R4): `latest_team_decision()`,
 * the newest decision the agent made in one of the team's own live workspaces, for the landing page. Never a customer's,
 * a sandbox's, a workspace whose creator left, or one about a sample payee; and only the fields the page may show.
 */

interface Latest {
  orgId: string;
  seq: number;
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
  bodyHash: string;
  signature: string;
  prevHash: string;
  hash: string;
  signingKeyId: string | null;
}

const { privateKey } = crypto.generateKeyPairSync("ed25519");
const TX = `0x${"ab".repeat(32)}`;

let db: PGlite;
let team: string;
let customer: string;

const latest = async (): Promise<Latest | null> => (await db.query<{ l: Latest | null }>("select public.latest_team_decision() as l")).rows[0].l;

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
function decision(counterpartyId: string, fields: { action?: string; execution?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  const action = fields.action ?? "pay";
  return {
    actor: "agent" as const,
    domain: "ap" as const,
    action: `ap_${action}`,
    summary: `${action.toUpperCase()} INV-7 from Northwind Supply (0.35 USDC): the model's reasoning, with names`,
    detail: {
      invoiceId: crypto.randomUUID(),
      counterpartyId,
      currency: "USDC",
      decision: { action, reasoning: "Northwind's bill matches PO-7.", confidence: 0.9, payOn: "2026-10-10" },
      decisionMode: "deepseek",
      referenceDecision: { action },
      agreedWithReference: true,
      guardrailBlocked: false,
      guardrailRule: null,
      observed: { amount: 0.35, paymentLimit: 5, riskLevel: "clear" },
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

describe("latest_team_decision (0087)", () => {
  it("is null before the team's workspaces have decided anything", async () => {
    expect(await latest()).toBeNull();
  });

  it("is the newest agent decision in a team member's live workspace, with only the fields the page may show", async () => {
    const ours = await org("ours-live", team);
    const supplier = await payee(ours, "Northwind Supply");
    await appendSignedForOrg(db, ours, decision(supplier, { action: "hold", execution: { txRef: null, resultingStatus: "held" } }), privateKey);
    const row = await appendSignedForOrg(db, ours, decision(supplier), privateKey);
    // A person's own entry after it is not a decision of the agent's.
    await appendSignedForOrg(db, ours, { actor: "human", domain: "ap", action: "approval_paid", summary: "Approved", detail: {} }, privateKey);

    const found = await latest();
    expect(found).toMatchObject({
      orgId: ours,
      seq: Number(row.seq),
      action: "ap_pay",
      network: "arc-testnet",
      amount: 0.35,
      currency: "USDC",
      decisionMode: "deepseek",
      agreedWithReference: true,
      guardrailBlocked: false,
      guardrailRule: null,
      heldBecause: null,
      resultingStatus: "paid",
      txRef: TX,
      payOn: "2026-10-10",
      verdict: null,
      bodyHash: row.body_hash,
      signature: row.signature,
      prevHash: row.prev_hash,
      hash: row.hash,
    });
    // Never the entry's summary, the model's reasoning, or a name or id of the bill or payee.
    const text = JSON.stringify(found);
    for (const secret of ["Northwind", "PO-7", "reasoning", "INV-7", supplier, "invoiceId", "counterpartyId", "summary"]) expect(text).not.toContain(secret);
  });

  it("never shows a customer's, a sandbox's, a former member's, or a sample payee's decision, however new", async () => {
    const before = await latest();
    const theirs = await org("customer-live", customer);
    await appendSignedForOrg(db, theirs, decision(await payee(theirs, "Their supplier")), privateKey);
    const sandbox = await org("ours-sandbox", team, "sandbox");
    await appendSignedForOrg(db, sandbox, decision(await payee(sandbox, "Sandbox supplier")), privateKey);
    const orphan = await org("creator-left", null);
    await appendSignedForOrg(db, orphan, decision(await payee(orphan, "Orphan supplier")), privateKey);
    const ours = await org("ours-sample", team);
    await appendSignedForOrg(db, ours, decision(await payee(ours, "Sample supplier", true)), privateKey);

    expect((await latest())?.seq).toBe(before?.seq);
  });

  it("names the network, why a hold held, and a person's verdict on it", async () => {
    const mainnet = await org("ours-mainnet", team, "live", "arc-mainnet");
    const supplier = await payee(mainnet, "Mainnet supplier");
    const row = await appendSignedForOrg(
      db,
      mainnet,
      decision(supplier, { execution: { txRef: null, resultingStatus: "held", heldBecause: "shadow_verdict" }, extra: { shadow: true } }),
      privateKey
    );
    await db.query(
      "insert into public.decision_verdicts (org_id, entry_seq, subject, subject_id, agent_action, verdict, reason) values ($1, $2, 'invoice', gen_random_uuid(), 'pay', 'agree', 'Matches what we ordered from them')",
      [mainnet, row.seq]
    );

    const found = await latest();
    expect(found).toMatchObject({ network: "arc-mainnet", resultingStatus: "held", heldBecause: "shadow_verdict", txRef: null, verdict: "agree" });
    // The person's own reason stays in the workspace.
    expect(JSON.stringify(found)).not.toContain("ordered from them");
  });

  it("is the service role's alone", async () => {
    await expect(asRole(db, "anon", (tx) => tx.query("select public.latest_team_decision()"))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select public.latest_team_decision()"))).rejects.toThrow(/permission denied/);
    const served = await asServiceRole(db, (tx) => tx.query<{ l: Latest | null }>("select public.latest_team_decision() as l"));
    expect(served.rows[0].l?.network).toBe("arc-mainnet");
  });
});
