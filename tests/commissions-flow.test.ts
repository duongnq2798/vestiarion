import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { runApStage, type CycleLogLine } from "@/lib/agent/orchestrator";
import { onChainLimitGate } from "@/lib/agent/onchain-limit";
import { CycleMetricsCollector } from "@/lib/agent/cycle-metrics";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferParams, TransferResult } from "@/lib/circle";
import { commissionMicros, formulaWords, reviewCommissions } from "@/lib/commissions/model";
import { toLine, type LineDbRow } from "@/lib/commissions/read";
import { ARC_TESTNET } from "@/lib/network";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { paymentIntentsBackend } from "./support/payment-intents";
import { applyMigrations, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Commissions end to end (docs/superpowers/specs/2026-10-14-commissions-design.md C3-C11). On a real Postgres (PGlite)
 * with every migration: an owner sets a partner's plan; a customer's part payment on Arc is applied to an invoice of
 * the deal; the commission is recorded once, however often the recording runs; past its hold window a person reviews
 * it and creates the payable; the rest of the invoice paid later earns its own part, held; a payment reversed after the
 * payout is carried to the next payable; and the partner cannot approve their own payout. Then the payable exactly as
 * the database wrote it goes through the agent's AP stage, over the recorded fake the AP stage's own tests use: the
 * rule-based policy decides, every guardrail runs, and the agent pays it to the partner on Arc.
 */

let pg: PGlite;
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const PAT_ADDRESS = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";

beforeAll(async () => {
  pg = await createDatabase();
  await applyMigrations(pg);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

const one = async (sql: string, params: unknown[]) => (await pg.query<{ id: string }>(sql, params)).rows[0].id;

/** Northstar: a customer, a referral partner who is also a member, an owner, and a deal of 1,000.00 USDC released. */
async function northstar() {
  const orgId = await createOrg(pg, `northstar-${crypto.randomUUID().slice(0, 8)}`);
  const owner = await createUser(pg, `owner-${crypto.randomUUID()}@example.com`);
  const partnerMember = await createUser(pg, `pat-${crypto.randomUUID()}@example.com`);
  await pg.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'approver')", [orgId, owner, partnerMember]);
  const acme = await one("insert into public.counterparties (org_id, name, role) values ($1, 'Acme Corp', 'client') returning id", [orgId]);
  const pat = await one(
    "insert into public.counterparties (org_id, name, role, address, risk_level, payment_limit) values ($1, 'Pat Referrals', 'vendor', $2, 'clear', 1000) returning id",
    [orgId, PAT_ADDRESS]
  );
  const deal = {
    counterpartyId: acme, title: "Website rebuild", currency: "USDC", minorDigits: 2, totalMinor: 100_000, startsOn: "2026-09-01", termsDays: 14,
    externalRef: null, template: "custom", autoRelease: false, idempotencyKey: `key-${crypto.randomUUID()}`, createdBy: owner, changes: [],
  };
  const rows = [{ position: 1, label: "All of it", invoiceOn: "2026-09-01", dueOn: "2026-09-15", amountMinor: 100_000, roundingMinor: 0 }];
  const dealId = await asTenant(pg, orgId, async (tx) =>
    (await tx.query<{ r: { id: string } }>("select public.create_deal($1, $2::jsonb, $3::jsonb) as r", [orgId, JSON.stringify(deal), JSON.stringify(rows)])).rows[0].r.id
  );
  const line = await one("select id from public.deal_lines where deal_id = $1", [dealId]);
  await pg.query("update public.deal_lines set status = 'released', released_at = now(), released_via = 'person' where id = $1", [line]);
  const invoice = await one(
    "insert into public.invoices (org_id, direction, counterparty_id, amount, memo, due_date, deal_id, deal_line_id) values ($1, 'receivable', $2, 1000, 'INV-1042 Website rebuild', now(), $3, $4) returning id",
    [orgId, acme, dealId, line]
  );
  return { orgId, owner, partnerMember, acme, pat, dealId, invoice };
}

let transfers = 0;
async function paymentOnArc(orgId: string, amount: number, daysBack: number): Promise<string> {
  transfers += 1;
  return one(
    "insert into public.incoming_transfers (org_id, circle_tx_id, tx_hash, amount, token, chain, received_at) values ($1, $2, $3, $4, 'USDC', 'ARC-TESTNET', $5) returning id",
    [orgId, `circle-flow-${transfers}`, `0x${String(transfers).padStart(64, "f")}`, amount, daysAgo(daysBack)]
  );
}

/** A person applying the payment to the invoice, some days ago, as allocations write it. */
async function applied(orgId: string, invoice: string, transfer: string, amount: number, daysBack: number): Promise<string> {
  return one(
    "insert into public.receivable_allocations (org_id, kind, invoice_id, transfer_id, amount, currency, basis, created_at) values ($1, 'payment', $2, $3, $4, 'USDC', 'person', $5) returning id",
    [orgId, invoice, transfer, amount, daysAgo(daysBack)]
  );
}

const recordCommissions = async (orgId: string) =>
  (await asTenant(pg, orgId, async (tx) => (await tx.query<LineDbRow>("select * from public.record_commissions($1)", [orgId])).rows)).map((row) =>
    toLine({ ...row, applied_at: String(new Date(row.applied_at).toISOString()), due_at: String(new Date(row.due_at).toISOString()) })
  );

describe("commissions on a real database, from plan to payable", () => {
  it("accrues a part payment once, pays it after its hold window, holds the rest, and carries a reversal forward", async () => {
    const w = await northstar();

    // The owner set Pat's plan 40 days ago: 10% net on every deal, 30 days' hold, Pat named as the member who is Pat.
    const planId = await one(
      `insert into public.commission_plans (org_id, beneficiary_id, beneficiary_member, rate_bps, basis, scope, hold_days, reference, started_at, created_by)
       values ($1, $2, $3, 1000, 'net', 'all_deals', 30, 'Referral agreement 2026', $4, $5) returning id`,
      [w.orgId, w.pat, w.partnerMember, daysAgo(40), w.owner]
    );

    // Acme paid 400.00 of the 1,000.00 invoice on Arc 35 days ago, applied the same day: a part payment.
    const first = await applied(w.orgId, w.invoice, await paymentOnArc(w.orgId, 400, 35), 400, 35);
    const [accrual] = await recordCommissions(w.orgId);
    expect(accrual).toMatchObject({ kind: "accrual", planId, allocationId: first, base: 400_000_000, amount: commissionMicros(400_000_000, 1000) });
    expect(formulaWords(accrual)).toBe("400.00 USDC received × 10% = 40.00 USDC");
    // The same event again records nothing: the cycle and a person's application may both run it.
    expect(await recordCommissions(w.orgId)).toHaveLength(0);
    expect(await recordCommissions(w.orgId)).toHaveLength(0);

    // The rest, 600.00, arrived today: it earns its own part, held for 30 days.
    await applied(w.orgId, w.invoice, await paymentOnArc(w.orgId, 600, 0), 600, 0);
    const [rest] = await recordCommissions(w.orgId);
    expect(rest.amount).toBe(60_000_000);
    expect((await pg.query<{ status: string }>("select status from public.invoices where id = $1", [w.invoice])).rows[0].status).toBe("received");

    // The review: 40.00 due now, 60.00 held.
    const lines = (await pg.query<LineDbRow>("select * from public.commission_lines where org_id = $1", [w.orgId])).rows.map((row) =>
      toLine({ ...row, applied_at: new Date(row.applied_at).toISOString(), due_at: new Date(row.due_at).toISOString() })
    );
    const [review] = reviewCommissions(lines, [], new Date());
    expect(review).toMatchObject({ dueTotal: 40_000_000, heldTotal: 60_000_000, payable: true });

    // Pat cannot create the payable for their own commission; the owner can, for exactly the lines shown.
    const create = (by: string) =>
      asTenant(pg, w.orgId, async (tx) =>
        (
          await tx.query<{ r: { invoiceId: string; statement: string; amount: number } }>(
            "select public.create_commission_payout($1, $2, 'USDC', $3::uuid[], 'Commissions on money received: 1 commission under Referral agreement 2026', $4) as r",
            [w.orgId, w.pat, review.due.map((line) => line.id), by]
          )
        ).rows[0].r
      );
    await expect(create(w.partnerMember)).rejects.toThrow(/commission_beneficiary/);
    const payout = await create(w.owner);
    expect(payout.amount).toBe(40);
    await expect(create(w.owner)).rejects.toThrow(/commission_changed/);

    // The agent holds it for a person (say, a first payment); Pat cannot approve it, the owner made it, so another
    // approver must: the claim refuses both, in its own words.
    await pg.query("update public.invoices set status = 'held' where id = $1", [payout.invoiceId]);
    const claim = (by: string) =>
      asTenant(pg, w.orgId, (tx) => tx.query("select * from public.claim_invoice_decision($1, $2, $3, 'approve')", [w.orgId, payout.invoiceId, by]));
    await expect(claim(w.partnerMember)).rejects.toThrow(/beneficiary_approval/);
    await expect(claim(w.owner)).rejects.toThrow(/self_approval/);
    await pg.query("update public.invoices set status = 'pending' where id = $1", [payout.invoiceId]);

    // The first payment is then reversed (applied to the wrong invoice): the commission paid on it comes off the next one.
    await one(
      "insert into public.receivable_allocations (org_id, kind, invoice_id, transfer_id, amount, currency, reverses, reason) select org_id, 'reversal', invoice_id, transfer_id, amount, currency, id, 'Applied to the wrong invoice' from public.receivable_allocations where id = $1 returning id",
      [first]
    );
    const [adjustment] = await recordCommissions(w.orgId);
    expect(adjustment).toMatchObject({ kind: "adjustment", adjusts: accrual.id, amount: -40_000_000, reason: "allocation_reversed" });
    expect(adjustment.dueAt).toBe(adjustment.appliedAt);
    expect((await pg.query<{ amount: string }>("select amount from public.invoices where id = $1", [payout.invoiceId])).rows[0].amount).toBe("40.000000");

    // Nothing was pulled back: the payable stands, and the next review nets −40.00 against the 60.00 when it falls due.
    const after = (await pg.query<LineDbRow>("select * from public.commission_lines where org_id = $1", [w.orgId])).rows.map((row) =>
      toLine({ ...row, applied_at: new Date(row.applied_at).toISOString(), due_at: new Date(row.due_at).toISOString() })
    );
    const payouts = (await pg.query<{ id: string; invoice_id: string; created_at: Date }>("select * from public.commission_payouts where org_id = $1", [w.orgId])).rows.map((row) => ({
      id: row.id, beneficiaryId: w.pat, invoiceId: row.invoice_id, statement: payout.statement, currency: "USDC" as const, amount: 40_000_000, lineCount: 1,
      createdBy: w.owner, createdAt: row.created_at.toISOString(), invoiceStatus: "pending",
    }));
    expect(reviewCommissions(after, payouts, new Date())[0]).toMatchObject({ dueTotal: -40_000_000, carriedForward: -40_000_000, payable: false });
    expect(reviewCommissions(after, payouts, new Date(Date.now() + 31 * DAY))[0]).toMatchObject({ dueTotal: 20_000_000, payable: true });

    payableFromDatabase = (
      await pg.query<Record<string, unknown>>(
        "select id, direction, status, amount, memo, po_reference, goods_received, due_date, counterparty_id, currency, created_at, created_by from public.invoices where id = $1",
        [payout.invoiceId]
      )
    ).rows[0];
    expect(payableFromDatabase).toMatchObject({ direction: "payable", status: "pending", amount: "40.000000", po_reference: payout.statement, goods_received: true, counterparty_id: w.pat });
    partnerId = w.pat;
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The payable the database wrote, decided and paid by the agent's AP stage, as any bill.

let payableFromDatabase: Record<string, unknown> | null = null;
let partnerId = "";

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-0000000c0331";
const ACCOUNT_ID = "018f8ce0-1557-7b54-a931-4d777f6bc005";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;

beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

const LEDGER_ROW = {
  seq: 1, id: "e1", ts: "2026-10-14T00:00:00Z", actor: "agent", domain: "ap", action: "x",
  summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
};

class Chain implements ChainProvider {
  readonly network = ARC_TESTNET;
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.003;
  transfers: TransferParams[] = [];
  async transfer(params: TransferParams): Promise<TransferResult> {
    this.transfers.push(params);
    return {
      providerTxId: `circle-tx-${this.transfers.length}`, txHash: "0xcommission", txRef: "0xcommission", chain: "ARC-TESTNET", status: "confirmed",
      feeUsd: 0.003, feeSource: "chain_reported", providerMode: "live", settledInMs: 4000, providerState: "COMPLETE", failureReason: null,
    };
  }
  async reconcileTransfer(): Promise<TransferResult> { throw new Error("not used"); }
  async getBalance(): Promise<BalanceSnapshot> { throw new Error("not used"); }
  async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
  async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
}

/** The payable as the AP stage reads it: the database's row, with its counterparty embedded. */
function billRow(row: Record<string, unknown>): Record<string, unknown> {
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
  return {
    ...row,
    due_date: iso(row.due_date),
    created_at: iso(row.created_at),
    agent_reasoning: null, tx_ref: null, decided_at: null, scheduled_for: null, paid_amount: null,
    early_pay_discount_pct: null, discount_due_date: null, project_id: null,
    counterparties: {
      id: partnerId, name: "Pat Referrals", role: "vendor", risk_level: "low", payment_limit: "1000", performance_score: null, performance_inputs: null,
      address: PAT_ADDRESS, address_changed_at: null, address_confirmed_at: null, purchase_order_required: true,
    },
  };
}

describe("the commission payable, decided by the agent", () => {
  it("is paid to the partner on Arc by the AP stage, under every guardrail, with its purchase order and goods received", async () => {
    expect(payableFromDatabase, "the database part ran first").not.toBeNull();
    const book = [billRow(payableFromDatabase as Record<string, unknown>)];
    const intents = paymentIntentsBackend(ORG);
    const fake = fakeSupabase((request: RecordedRequest) => {
      if (request.path === "/rest/v1/orgs") {
        return {
          body: {
            id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox",
            ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
            circle_api_key_enc: null, circle_entity_secret_enc: null,
          },
        };
      }
      if (["/rest/v1/approval_policies", "/rest/v1/agent_budgets", "/rest/v1/shadow_modes"].includes(request.path)) return { body: [] };
      if (request.path === "/rest/v1/ledger_entries" && request.method === "GET" && request.params.has("actor")) return { body: [] };
      if (request.path === "/rest/v1/rpc/append_ledger_entry") return { body: LEDGER_ROW };
      if (request.path === "/rest/v1/rpc/agent_paused") return { body: false };
      if (request.path === "/rest/v1/invoices" && request.method === "GET") {
        const statuses = request.params.get("status")?.match(/^in\.\((.*)\)$/)?.[1].split(",");
        return { body: statuses ? book.filter((row) => statuses.includes(row.status as string)) : book };
      }
      if (request.path === "/rest/v1/invoices" && request.method === "PATCH") return { body: [] };
      if (request.path === "/rest/v1/milestones") return { body: [] };
      if (request.path === "/rest/v1/accounts" && request.method === "GET") return { body: { id: ACCOUNT_ID, chain: "ARC-TESTNET", token: "USDC", balance: "1000", apy: "0" } };
      if (request.path === "/rest/v1/accounts" && request.method === "PATCH") return { body: [] };
      return intents.respond(request);
    });
    const chain = new Chain();
    const lines: CycleLogLine[] = [];
    await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () =>
        runApStage({
          db: db(),
          provider: chain,
          operating: { id: ACCOUNT_ID },
          operatingBalance: 1000,
          reserveApy: 0,
          reserveBalance: 0,
          metrics: new CycleMetricsCollector(),
          lines,
          onChainLimit: onChainLimitGate({ read: async () => null }),
        })
      )
    );
    expect(chain.transfers).toHaveLength(1);
    expect(chain.transfers[0]).toMatchObject({ amount: 40, toAddress: PAT_ADDRESS });
    const decision = fake.requests
      .filter((request) => request.path === "/rest/v1/rpc/append_ledger_entry")
      .map((request) => (request.body as { p_action: string; p_detail: Record<string, unknown> }))
      .find((entry) => entry.p_action === "ap_pay");
    expect(decision?.p_detail).toMatchObject({ invoiceId: (payableFromDatabase as { id: string }).id, guardrailBlocked: false, guardrailRule: null, execution: { resultingStatus: "paid" } });
  });
});
