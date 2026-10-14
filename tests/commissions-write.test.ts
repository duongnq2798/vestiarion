import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { createCommissionPayable, endCommissionPlan, setCommissionPlan } from "@/lib/commands/commissions";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import { CommissionError } from "@/lib/commissions/model";
import { recordCommissions } from "@/lib/commissions/record";
import { createPayable } from "@/lib/commissions/write";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Commissions recorded and written, over the recorded fake (docs/superpowers/specs/2026-10-14-commissions-design.md C5,
 * C10, C12, C13): each row `record_commissions` answers is signed once, as `commission_accrued` or
 * `commission_adjusted`, naming the receivable as `receivableId`; nothing is recorded before 0118 runs; a payable made
 * from a review is signed as the `create_invoice` every payable has, then `commission_payable_created`; and only an
 * owner or admin, from the console, sets a plan or makes a payable.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-0000000c0333";
const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1";
const PAT = "018f8ce0-1557-7b54-a931-4d777f6bc101";
const INVOICE = "018f8ce0-1557-7b54-a931-4d777f6bc102";
const DEAL = "018f8ce0-1557-7b54-a931-4d777f6bc103";
const PLAN = "018f8ce0-1557-7b54-a931-4d777f6bc104";
const ACCRUAL = "018f8ce0-1557-7b54-a931-4d777f6bc105";
const ADJUSTMENT = "018f8ce0-1557-7b54-a931-4d777f6bc106";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const saved = process.env.VESTIARION_MASTER_KEYS;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
});
afterEach(() => {
  if (saved === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = saved;
});

const LEDGER_ROW = {
  seq: 1, id: "e1", ts: "2026-10-14T00:00:00Z", actor: "agent", domain: "ap", action: "x",
  summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
};

function lineRow(fields: Record<string, unknown>) {
  return {
    id: ACCRUAL, kind: "accrual", plan_id: PLAN, beneficiary_id: PAT, invoice_id: INVOICE, deal_id: DEAL, source: "payment",
    allocation_id: "alloc-1", transfer_id: "transfer-1", adjusts: null, basis: "net", base_amount: "300.000000", rate_bps: 1000,
    amount: "30.000000", currency: "USDC", applied_at: "2026-09-10T10:00:00+00:00", due_at: "2026-10-10T10:00:00+00:00", reason: null, payout_id: null,
    ...fields,
  };
}

const ADJUSTED = lineRow({
  id: ADJUSTMENT, kind: "adjustment", adjusts: ACCRUAL, allocation_id: "reversal-1", amount: "-30.000000", reason: "allocation_reversed",
  applied_at: "2026-10-12T08:00:00+00:00", due_at: "2026-10-12T08:00:00+00:00",
});

function world(
  answers: { record?: FakeReply | ((call: number) => FakeReply); payout?: FakeReply; end?: FakeReply; lines?: unknown[] | ((request: RecordedRequest) => unknown[]) } = {}
) {
  let recordCalls = 0;
  const fake = fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/rpc/record_commissions" && typeof answers.record === "function") {
      recordCalls += 1;
      return answers.record(recordCalls);
    }
    if (request.path === "/rest/v1/commission_lines" && typeof answers.lines === "function") return { body: answers.lines(request) };
    if (request.path === "/rest/v1/orgs") {
      return {
        body: {
          id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox",
          ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
          circle_api_key_enc: null, circle_entity_secret_enc: null,
        },
      };
    }
    if (request.path === "/rest/v1/rpc/record_commissions") return (answers.record as FakeReply | undefined) ?? { body: [] };
    if (request.path === "/rest/v1/rpc/create_commission_payout") return answers.payout ?? { body: {} };
    if (request.path === "/rest/v1/rpc/end_commission_plan") return answers.end ?? { body: {} };
    if (request.path === "/rest/v1/counterparties") return { body: [{ id: PAT, name: "Pat Referrals" }] };
    if (request.path === "/rest/v1/invoices") return { body: [{ id: INVOICE, memo: "INV-1042 Website rebuild" }] };
    if (request.path === "/rest/v1/commission_lines") return { body: answers.lines ?? [] };
    if (request.path === "/rest/v1/commission_plans") return { body: [{ id: PLAN, reference: "Referral agreement 2026" }] };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") return { body: LEDGER_ROW };
    return { body: [] };
  });
  const run = <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn));
  const entries = () =>
    fake.requests
      .filter((request) => request.path === "/rest/v1/rpc/append_ledger_entry")
      .map((request) => request.body as { p_actor: string; p_domain: string; p_action: string; p_summary: string; p_detail: Record<string, unknown> });
  return { fake, run, entries };
}

describe("recordCommissions", () => {
  it("signs each row the database recorded, once, naming the receivable as receivableId", async () => {
    const { fake, run, entries } = world({ record: { body: [lineRow({}), ADJUSTED] } });
    const result = await run(() => recordCommissions(db()));
    expect(result.lines.map((line) => line.kind)).toEqual(["accrual", "adjustment"]);
    expect(fake.requests.filter((request) => request.path === "/rest/v1/rpc/record_commissions")[0].body).toEqual({ p_org_id: ORG });
    const [accrued, adjusted] = entries();
    expect(accrued).toMatchObject({
      p_actor: "agent",
      p_domain: "ap",
      p_action: "commission_accrued",
      p_summary: "Commission of 30.00 USDC for Pat Referrals on INV-1042 Website rebuild: 300.00 USDC received × 10% = 30.00 USDC, due 2026-10-10",
      p_detail: { lineId: ACCRUAL, receivableId: INVOICE, dealId: DEAL, source: "payment", base: 300, rateBps: 1000, ratePercent: "10%", amount: 30, currency: "USDC", formula: "300.00 USDC received × 10% = 30.00 USDC" },
    });
    expect(accrued.p_detail).not.toHaveProperty("invoiceId");
    expect(adjusted).toMatchObject({
      p_action: "commission_adjusted",
      p_detail: { lineId: ADJUSTMENT, adjusts: ACCRUAL, reversalId: "reversal-1", amount: -30, carriedForward: true, reason: "allocation_reversed" },
    });
    expect(adjusted.p_summary).toBe("Commission of Pat Referrals on INV-1042 Website rebuild adjusted by −30.00 USDC: the payment was reversed, carried to the next payable");
    expect(result.log).toHaveLength(2);
  });

  it("records nothing, and says nothing, before migration 0118 runs", async () => {
    const { run, entries } = world({ record: { status: 404, body: { code: "PGRST202", message: "Could not find the function public.record_commissions(p_org_id) in the schema cache" } } });
    expect(await run(() => recordCommissions(db()))).toEqual({ lines: [], log: [] });
    expect(entries()).toHaveLength(0);
  });

  it("throws any other failure, for the cycle to log and try again", async () => {
    const { run } = world({ record: { status: 500, body: { code: "XX000", message: "connection reset" } } });
    await expect(run(() => recordCommissions(db()))).rejects.toThrow("connection reset");
  });

  it("calls again while an answer may have left rows, each statement taking 300 at most, and signs every row", async () => {
    const many = Array.from({ length: 300 }, (_, index) => lineRow({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));
    const { fake, run, entries } = world({ record: (call) => ({ body: call === 1 ? many : call === 2 ? [lineRow({ id: ADJUSTMENT })] : [] }) });
    const result = await run(() => recordCommissions(db()));
    expect(fake.requests.filter((request) => request.path === "/rest/v1/rpc/record_commissions")).toHaveLength(2);
    expect(result.lines).toHaveLength(301);
    expect(entries()).toHaveLength(301);
    // Names are read a hundred ids at a time at most.
    for (const request of fake.requests.filter((sent) => sent.params.get("id")?.startsWith("in."))) {
      expect((request.params.get("id") as string).split(",").length).toBeLessThanOrEqual(100);
    }
  });
});

describe("createPayable", () => {
  it("makes the payable through the database, then signs its create_invoice and commission_payable_created", async () => {
    const payout = { payoutId: "payout-1", invoiceId: "bill-1", statement: "CS-0A1B2C3D", amount: 30, currency: "USDC", lineCount: 1, accrued: 30, adjusted: 0 };
    const { fake, run, entries } = world({ payout: { body: payout }, lines: [lineRow({ due_at: "2026-10-10T10:00:00+00:00" })] });
    const made = await run(() => createPayable({ actorId: OWNER, beneficiaryId: PAT, currency: "USDC", lineIds: [ACCRUAL] }));
    expect(made).toMatchObject({ invoiceId: "bill-1", statement: "CS-0A1B2C3D", amount: 30, partner: "Pat Referrals" });
    expect(fake.requests.find((request) => request.path === "/rest/v1/rpc/create_commission_payout")?.body).toEqual({
      p_org_id: ORG,
      p_beneficiary_id: PAT,
      p_currency: "USDC",
      p_line_ids: [ACCRUAL],
      p_memo: "Commissions on money received: 1 commission under Referral agreement 2026",
      p_by: OWNER,
    });
    const [invoice, created] = entries();
    expect(invoice).toMatchObject({
      p_actor: "human",
      p_action: "create_invoice",
      p_detail: { by: OWNER, invoiceId: "bill-1", counterpartyId: PAT, amount: 30, currency: "USDC", poReference: "CS-0A1B2C3D", goodsReceived: true, via: "commission" },
    });
    expect(created).toMatchObject({
      p_action: "commission_payable_created",
      p_detail: { by: OWNER, payoutId: "payout-1", statement: "CS-0A1B2C3D", payableId: "bill-1", beneficiaryId: PAT, amount: 30, lineIds: [ACCRUAL], accrued: 30, adjusted: 0 },
    });
  });

  it("reads the database's refusals in plain words, and signs nothing", async () => {
    const { run, entries } = world({
      payout: { status: 400, body: { code: "P0001", message: "commission_changed: the commissions due changed since they were read" } },
      lines: [lineRow({})],
    });
    const attempt = run(() => createPayable({ actorId: OWNER, beneficiaryId: PAT, currency: "USDC", lineIds: [ACCRUAL] }));
    await expect(attempt).rejects.toBeInstanceOf(CommissionError);
    await expect(attempt).rejects.toThrow("The commissions due changed since this page was read. Reload the page to see them as they are now.");
    expect(entries()).toHaveLength(0);
  });

  it("refuses lines it cannot find any more as changed, before writing anything", async () => {
    const { fake, run } = world({ lines: [] });
    await expect(run(() => createPayable({ actorId: OWNER, beneficiaryId: PAT, currency: "USDC", lineIds: [ACCRUAL] }))).rejects.toThrow(/changed since this page was read/);
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/create_commission_payout")).toBe(false);
  });

  it("reads a payable's many lines a hundred ids at a time, so no address grows too long", async () => {
    const ids = Array.from({ length: 250 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    const payout = { payoutId: "payout-1", invoiceId: "bill-1", statement: "CS-0A1B2C3D", amount: 250, currency: "USDC", lineCount: 250, accrued: 250, adjusted: 0 };
    const { fake, run } = world({
      payout: { body: payout },
      lines: (request) => (request.params.get("id")?.slice(4, -1).split(",") ?? []).map((one) => ({ id: one, kind: "accrual" })),
    });
    const made = await run(() => createPayable({ actorId: OWNER, beneficiaryId: PAT, currency: "USDC", lineIds: ids }));
    expect(made.lineCount).toBe(250);
    const reads = fake.requests.filter((request) => request.path === "/rest/v1/commission_lines");
    expect(reads.map((request) => (request.params.get("id") as string).split(",").length)).toEqual([100, 100, 50]);
    expect(fake.requests.find((request) => request.path === "/rest/v1/rpc/create_commission_payout")?.body).toMatchObject({ p_line_ids: ids });
  });
});

describe("who may set a plan and make a payable (C13)", () => {
  const actor = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: OWNER, role: "owner", mode: "live", surface: { kind: "console" }, ...fields });
  const DRAFT = { beneficiaryId: PAT, rateBps: 1000, basis: "net" as const, scope: "all_deals" as const, dealIds: [], holdDays: 30, reference: null, memberId: null };

  it("is an owner's or admin's, from the console only", () => {
    for (const command of ["commission.set_plan", "commission.end_plan", "commission.create_payable"] as const) {
      expect(COMMAND_PERMISSIONS[command]).toBe("records.write");
      for (const surface of ["api", "slack", "telegram", "github"] as const) expect(SURFACE_COMMANDS[surface]).not.toContain(command);
    }
  });

  it.each(["approver", "accountant", "viewer"] as const)("refuses an %s every commission command, before anything is read", async (role) => {
    const fake = fakeSupabase();
    const outcomes = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), async () => [
      await setCommissionPlan(actor({ role }), { draft: DRAFT, replaces: null }),
      await endCommissionPlan(actor({ role }), { planId: PLAN }),
      await createCommissionPayable(actor({ role }), { beneficiaryId: PAT, currency: "USDC", lineIds: [ACCRUAL] }),
    ]);
    for (const outcome of outcomes) expect(outcome).toMatchObject({ ok: false, code: "forbidden" });
    expect(fake.requests).toHaveLength(0);
  });

  it("says the database's refusal of a partner acting on their own plan in its own words, and signs nothing", async () => {
    const { run, entries } = world({ end: { status: 400, body: { code: "P0001", message: "commission_beneficiary: a partner does not end their own commission plan" } } });
    const outcome = await run(() => endCommissionPlan(actor(), { planId: PLAN }));
    expect(outcome).toEqual({ ok: false, code: "beneficiary", message: "This commission is yours, so someone else sets its plan and creates its payable." });
    expect(entries()).toHaveLength(0);
  });
});
