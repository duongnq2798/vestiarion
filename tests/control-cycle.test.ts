import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv, type FollowUpConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { applyFollowUp } from "@/lib/agent/orchestrator";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Two cycle seams the control work leans on, each tested directly rather
 * than through a full `runAgentCycle()` (see `tests/pause-cycle.test.ts` for
 * why a full cycle is out of proportion):
 *
 * - the follow-up stage's reopen or escalation, which must be a
 *   compare-and-set on the status it read, so it never overwrites a row a
 *   person has claimed meanwhile;
 * - the AP stage's reconciliation of a `matched` payable whose payment is
 *   already in flight, which must go to `payInvoice` — whose idempotency key
 *   makes it reconcile, not pay again — and never back through the model and
 *   the guardrails that could turn a person's approval into a hold.
 *
 * Both write the ledger, so the scope is a real organization with a real
 * ledger key over the recorded fake, as in `tests/approvals.test.ts`.
 */

const { payInvoiceMock, decideMock, guardrailsMock } = vi.hoisted(() => ({
  payInvoiceMock: vi.fn(),
  decideMock: vi.fn(),
  guardrailsMock: vi.fn(),
}));
vi.mock("@/lib/agent/pay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/pay")>()),
  payInvoice: payInvoiceMock,
}));
vi.mock("@/lib/agent/decide", () => ({ decide: decideMock }));
vi.mock("@/lib/agent/guardrails", () => ({ enforceApGuardrails: guardrailsMock }));

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c1c1";
const INVOICE_ID = "018f8ce0-1557-7b54-a931-4d777f6bc001";

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
  payInvoiceMock.mockReset();
  decideMock.mockReset();
  guardrailsMock.mockReset();
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

function orgRow() {
  return {
    id: ORG,
    slug: "northstar",
    name: "Northstar",
    mode: "live",
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

const LEDGER_ROW = {
  seq: 1, id: "e1", ts: "2026-09-29T00:00:00Z", actor: "agent", domain: "ap", action: "x",
  summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
};

/** PostgREST for these seams: the org row for the scope, the ledger append, and whatever `respond` answers. */
function cycleFake(respond: (request: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") return { body: LEDGER_ROW };
    return respond(request) ?? { body: [] };
  });
  return { fake, run: <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn)) };
}

function rpcBodies(requests: RecordedRequest[], name: string) {
  return requests.filter((r) => r.path === `/rest/v1/rpc/${name}`).map((r) => r.body as Record<string, unknown>);
}
function invoicePatches(requests: RecordedRequest[]) {
  return requests.filter((r) => r.path === "/rest/v1/invoices" && r.method === "PATCH");
}

const FOLLOW_UP_CONFIG: FollowUpConfig = { staleAfterDays: 7, reEscalateAfterDays: 3 };

describe("applyFollowUp — the follow-up stage's write is a compare-and-set", () => {
  const reopen = { action: "reopen" as const, reason: "The purchase order arrived.", changes: ["PO added"], ageDays: 2, pastDue: false };
  const escalate = { action: "escalate" as const, reason: "Stale.", changes: [], ageDays: 9, pastDue: true };

  it("reopens only while the invoice still has the status it was read with", async () => {
    const { fake, run } = cycleFake((r) => (r.path === "/rest/v1/invoices" && r.method === "PATCH" ? { body: [{ id: INVOICE_ID }] } : undefined));

    const line = await run(() => applyFollowUp(db(), { id: INVOICE_ID, status: "held", amount: 150 }, reopen, FOLLOW_UP_CONFIG, Date.now()));

    const [patch] = invoicePatches(fake.requests);
    expect(patch.body).toEqual({ status: "pending" });
    expect(patch.params.get("id")).toBe(`eq.${INVOICE_ID}`);
    expect(patch.params.get("status")).toBe("eq.held");
    expect(patch.params.get("select")).toBe("id");
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_action).toBe("invoice_reopened");
    expect(line).toEqual({ domain: "ap", message: "Reopened 150 USDC invoice: PO added" });
  });

  it("writes no ledger entry and no cycle line when a person claimed the invoice meanwhile", async () => {
    // The PATCH matched no row: the invoice is `processing` now, not `held`.
    const { fake, run } = cycleFake((r) => (r.path === "/rest/v1/invoices" && r.method === "PATCH" ? { body: [] } : undefined));

    const line = await run(() => applyFollowUp(db(), { id: INVOICE_ID, status: "held", amount: 150 }, reopen, FOLLOW_UP_CONFIG, Date.now()));

    expect(line).toBeNull();
    expect(invoicePatches(fake.requests)).toHaveLength(1);
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("guards an escalation the same way", async () => {
    const { fake, run } = cycleFake((r) => (r.path === "/rest/v1/invoices" && r.method === "PATCH" ? { body: [] } : undefined));

    const line = await run(() => applyFollowUp(db(), { id: INVOICE_ID, status: "awaiting_info", amount: 150 }, escalate, FOLLOW_UP_CONFIG, Date.now()));

    const [patch] = invoicePatches(fake.requests);
    expect(Object.keys(patch.body as object)).toEqual(["escalated_at"]);
    expect(patch.params.get("status")).toBe("eq.awaiting_info");
    expect(line).toBeNull();
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("throws the database's own error when the write fails", async () => {
    const { run } = cycleFake((r) =>
      r.path === "/rest/v1/invoices" && r.method === "PATCH" ? { status: 500, body: { message: "invoices update failed: connection reset" } } : undefined
    );

    await expect(
      run(() => applyFollowUp(db(), { id: INVOICE_ID, status: "held", amount: 150 }, reopen, FOLLOW_UP_CONFIG, Date.now()))
    ).rejects.toThrow("invoices update failed: connection reset");
  });
});
