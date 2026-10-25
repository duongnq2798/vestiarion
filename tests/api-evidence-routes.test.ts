import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntryInput } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { buildChain } from "./support/ledger-chain";
import type { FakeReply, RecordedRequest } from "./support/fake-supabase";
import { API_ORG, apiConfig, apiWorld, callRoute, inWorkspace, OTHER_ORG, readKey, WORKSPACE, writesIn } from "./support/evidence-api";

/**
 * One payment's evidence through the API (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md
 * EA1-EA3, EA5, EA6, EA8): the file the evidence page downloads, in `{ data }`, with members named by user id; a bad or
 * foreign id answered 404 before anything is read; one brake per key across the five evidence reads; nothing written.
 */

const active = crypto.generateKeyPairSync("ed25519");
vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/platform/api-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/api-keys")>()),
  authenticateApiKey: vi.fn(),
  touchApiKeyUsed: vi.fn(async () => {}),
}));
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  ledgerVerificationKeyring: () => ({ active: active.publicKey, retired: [] }),
}));
vi.mock("@/lib/receipts/onchain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/receipts/onchain")>()),
  readOnChain: vi.fn(async () => ({ state: "matches", block: 64 })),
}));
vi.mock("@/lib/evidence-links/check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/evidence-links/check")>()),
  checkEvidenceLinks: vi.fn(async () => new Map()),
}));

import { GET as getClosePack } from "@/app/api/v1/close-packs/[month]/route";
import { GET as getInvoiceEvidence } from "@/app/api/v1/invoices/[id]/evidence/route";
import { GET as getInvoiceReceipt } from "@/app/api/v1/invoices/[id]/receipt/route";
import { GET as getMilestoneEvidence } from "@/app/api/v1/milestones/[id]/evidence/route";
import { GET as getPayeeLockEvidence } from "@/app/api/v1/payee-lock/evidence/route";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { evidenceDocument } from "@/lib/evidence-export";
import { readEvidence } from "@/lib/evidence-read";
import { ledgerVerificationKeyring } from "@/lib/ledger";
import { exportKeys } from "@/lib/ledger-export";
import { authenticateApiKey } from "@/lib/platform/api-keys";
import { takeApiEvidenceToken } from "@/lib/rate-limit";

const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f1";
const APPROVER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f2";
const LEFT = "9a8b7c6d-4a4f-4a7e-9b1e-0000000000f3";
const CP = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003f1";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001f1";
const MILESTONE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000002f1";
const PAYEE = "0x221B000000000000000000000000000000001bc3";
const TX = `0x${"79".repeat(32)}`;
const EMAILS = ["owner@northstar.test", "approver@northstar.test"];

const INPUTS: LedgerEntryInput[] = [
  { actor: "human", domain: "compliance", action: "create_counterparty", summary: "Added Harbor Print", detail: { by: LEFT, counterpartyId: CP, address: PAYEE } },
  { actor: "human", domain: "compliance", action: "counterparty_address_confirmed", summary: "Confirmed", detail: { by: APPROVER, counterpartyId: CP, address: PAYEE } },
  { actor: "human", domain: "ap", action: "create_invoice", summary: "Added a bill", detail: { by: OWNER, invoiceId: INVOICE, counterpartyId: CP, amount: 12.5, currency: "USDC", poReference: "PO-1", goodsReceived: true } },
  { actor: "human", domain: "ap", action: "approval_paid", summary: "Approved and paid", detail: { by: APPROVER, invoiceId: INVOICE, counterpartyId: CP, amount: 12.5, currency: "USDC", amountPaid: 12.5, txRef: TX, status: "paid" } },
  { actor: "human", domain: "contractor", action: "create_milestone", summary: "Added a milestone", detail: { by: OWNER, milestoneId: MILESTONE, counterpartyId: CP, amount: 25, verificationSource: "https://github.com/acme/app/pull/12" } },
];
const ROWS = buildChain(INPUTS, active.privateKey, ledgerKeyId(active.publicKey)).map((row) => ({ ...row, org_id: API_ORG }));
const [GIVEN, CONFIRMED, CREATED, PAID, MILESTONE_ADDED] = ROWS;

const INVOICE_ROW = {
  id: INVOICE, org_id: API_ORG, direction: "payable", counterparty_id: CP, amount: "12.500000", currency: "USDC", memo: "October paper", po_reference: "PO-1",
  goods_received: true, due_date: "2026-10-15T00:00:00Z", status: "paid", tx_ref: TX, paid_amount: "12.500000",
};
const MILESTONE_ROW = {
  id: MILESTONE, org_id: API_ORG, contractor_id: CP, title: "Fix the login redirect", amount: "25", status: "pending", verified: false, verification_method: "unverified",
  verification_status: "unverified", verification_source: null, verification_checked_at: null, verified_at: null, verification_detail: {}, tx_ref: null,
};
const INTENT = {
  status: "confirmed", provider: "circle", provider_mode: "live", token: "USDC", amount: "12.500000", destination: PAYEE, tx_hash: TX, chain: "ARC-TESTNET",
  destination_chain: null, mint_tx_hash: null, bridge_fee: null, payout_route: null, confirmed_at: "2026-01-01T00:03:30Z", network: "arc-testnet",
  provider_tx_id: "circle-1", provider_state: "COMPLETE", failure_reason: null, last_error: null,
};

interface World {
  invoice?: Record<string, unknown> | null;
  milestone?: Record<string, unknown> | null;
}

function workspace(world: World = {}) {
  return apiWorld((request: RecordedRequest): FakeReply => {
    const list = (row: unknown) => ({ body: row ? [row] : [] });
    switch (request.path) {
      case "/rest/v1/invoices":
        return list(world.invoice === undefined ? INVOICE_ROW : world.invoice);
      case "/rest/v1/milestones":
        return list(world.milestone === undefined ? MILESTONE_ROW : world.milestone);
      case "/rest/v1/counterparties":
        return list({ id: CP, org_id: API_ORG, name: "Harbor Print", address: PAYEE, chain: "ARC-TESTNET", risk_level: "clear", purchase_order_required: true, sample: false });
      case "/rest/v1/rpc/ledger_entries_for_targets": {
        const body = request.body as { p_invoice_ids: string[] };
        return { body: body.p_invoice_ids.length > 0 ? [CREATED, PAID] : [MILESTONE_ADDED] };
      }
      case "/rest/v1/ledger_entries":
        return { body: request.params.get("domain") === "eq.compliance" ? [CONFIRMED, GIVEN] : [] };
      case "/rest/v1/payment_intents":
        return list(request.params.get("source_type") === "eq.invoice" ? INTENT : null);
      case "/rest/v1/compliance_checks":
        return list({ risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: "2026-01-01T00:00:30Z" });
      case "/rest/v1/rpc/org_members":
        return {
          body: [
            { user_id: OWNER, email: EMAILS[0], role: "owner", joined_at: "2025-12-01T00:00:00Z" },
            { user_id: APPROVER, email: EMAILS[1], role: "approver", joined_at: "2025-12-01T00:00:00Z" },
          ],
        };
      default:
        return { body: [] };
    }
  });
}

let key = readKey();
beforeEach(() => {
  key = readKey();
  vi.mocked(authenticateApiKey).mockReset();
  vi.mocked(authenticateApiKey).mockImplementation(async () => key);
});

const invoiceEvidence = (world: ReturnType<typeof workspace>, id = INVOICE) => callRoute(world, getInvoiceEvidence, `/api/v1/invoices/${id}/evidence`, { id });
const milestoneEvidence = (world: ReturnType<typeof workspace>, id = MILESTONE) => callRoute(world, getMilestoneEvidence, `/api/v1/milestones/${id}/evidence`, { id });

describe("GET /api/v1/invoices/{id}/evidence (evidence API EA1, EA2)", () => {
  it("answers the evidence page's download, in { data }, with no-store", async () => {
    const world = workspace();
    const response = await invoiceEvidence(world);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    const { data } = (await response.json()) as { data: Record<string, unknown> & { exportedAt: string } };
    expect(data.format).toBe("vestiarion-evidence/1");

    // The same builder over the same rows, members by id (EA2, EA3).
    const expected = await runWith({ config: apiConfig, db: world.client, fetch: world.fetch }, () =>
      withOrg(API_ORG, async () => {
        const read = (await readEvidence("invoice", INVOICE, { people: "id" }))!;
        return evidenceDocument({ chain: read.chain, workspace: WORKSPACE, keys: exportKeys(ledgerVerificationKeyring()), now: new Date(data.exportedAt) });
      })
    );
    expect(data).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("names members by user id and never by email, and one who left as a former member (EA3)", async () => {
    const response = await invoiceEvidence(workspace());
    const text = await response.text();
    for (const email of EMAILS) expect(text).not.toContain(email);
    const { data } = JSON.parse(text) as { data: { steps: Array<{ id: string; facts: Array<{ who: string | null; entries: number[] }> }> } };
    const facts = data.steps.flatMap((step) => step.facts.map((fact) => ({ step: step.id, ...fact })));
    expect(facts.find((fact) => fact.step === "people" && fact.entries.includes(PAID.seq))?.who).toBe(APPROVER);
    expect(facts.find((fact) => fact.step === "payee" && fact.entries.includes(GIVEN.seq))?.who).toBe("a former member");
    expect(facts.find((fact) => fact.step === "agreed")?.who).toBe(OWNER);
  });

  it("answers a receivable, and an id that is not a UUID, with the same 404; the second reads nothing (EA5)", async () => {
    const receivable = await invoiceEvidence(workspace({ invoice: { ...INVOICE_ROW, direction: "receivable" } }));
    expect(receivable.status).toBe(404);
    expect(await receivable.json()).toEqual({ error: { code: "not_found", message: `Payable invoice "${INVOICE}" was not found.` } });

    const world = workspace();
    const malformed = await invoiceEvidence(world, "not-a-uuid");
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({ error: { code: "not_found", message: 'Payable invoice "not-a-uuid" was not found.' } });
    expect(world.requests.filter((request) => request.path === "/rest/v1/invoices")).toEqual([]);
  });

  it("reads only in the key's workspace, so another workspace's id is not found (EA5)", async () => {
    const world = workspace();
    await invoiceEvidence(world);
    expect(world.requests.length).toBeGreaterThan(0);
    for (const request of world.requests) {
      expect(inWorkspace(request), `${request.method} ${request.path}`).toBe(true);
      expect(inWorkspace(request, OTHER_ORG), `${request.method} ${request.path}`).toBe(false);
    }
    const unknown = await invoiceEvidence(workspace({ invoice: null }));
    expect(unknown.status).toBe(404);
  });
});

describe("GET /api/v1/milestones/{id}/evidence (evidence API EA1)", () => {
  it("answers a milestone of the workspace", async () => {
    const response = await milestoneEvidence(workspace());
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: { format: string; subject: { kind: string; id: string } } };
    expect(data.format).toBe("vestiarion-evidence/1");
    expect(data.subject).toMatchObject({ kind: "milestone", id: MILESTONE });
  });

  it("answers one the workspace does not hold, or a malformed id, with a 404", async () => {
    const unknown = await milestoneEvidence(workspace({ milestone: null }));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: { code: "not_found", message: `Milestone "${MILESTONE}" was not found.` } });
    const malformed = await milestoneEvidence(workspace(), "m-1");
    expect((await malformed.json()).error.message).toBe('Milestone "m-1" was not found.');
  });
});

describe("the evidence reads' brake (evidence API EA6)", () => {
  it("lets ten through at once per key, then one every 6 seconds, each key apart", () => {
    const now = 1_000_000;
    for (let read = 0; read < 10; read += 1) expect(takeApiEvidenceToken("key-a", now)).toBe(true);
    expect(takeApiEvidenceToken("key-a", now)).toBe(false);
    expect(takeApiEvidenceToken("key-b", now)).toBe(true);
    expect(takeApiEvidenceToken("key-a", now + 5_999)).toBe(false);
    expect(takeApiEvidenceToken("key-a", now + 6_000 + 5_999)).toBe(true);
    expect(takeApiEvidenceToken("key-a", now + 6_000 + 5_999)).toBe(false);
  });

  it("shares one bucket across the five reads: the eleventh answers 429 with Retry-After 60, and another key still reads", async () => {
    const world = workspace({ invoice: null, milestone: null });
    const reads = [
      () => invoiceEvidence(world),
      () => milestoneEvidence(world),
      () => callRoute(world, getInvoiceReceipt, `/api/v1/invoices/${INVOICE}/receipt`, { id: INVOICE }),
      () => callRoute(world, getPayeeLockEvidence, "/api/v1/payee-lock/evidence?from=2026-10-01&to=2026-10-31", {}),
      () => callRoute(world, getClosePack, "/api/v1/close-packs/2026-01", { month: "2026-01" }),
    ];
    for (const read of [...reads, ...reads]) expect((await read()).status).not.toBe(429);

    const limited = await reads[4]();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: { code: "rate_limited", message: "Too many evidence reads from this key. Try again in a minute." } });

    key = readKey();
    expect((await reads[4]()).status).toBe(200);
  });

  it("takes no token for a month that does not read or an id that is not a UUID", async () => {
    const world = workspace();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect((await callRoute(world, getClosePack, "/api/v1/close-packs/2026-13", { month: "2026-13" })).status).toBe(400);
      expect((await invoiceEvidence(world, "not-a-uuid")).status).toBe(404);
      expect((await callRoute(world, getPayeeLockEvidence, "/api/v1/payee-lock/evidence?from=2026-10-32", {})).status).toBe(400);
    }
    expect(world.requests).toEqual([]);
    expect((await invoiceEvidence(world)).status).toBe(200);
  });
});

describe("the evidence reads write nothing (evidence API EA8)", () => {
  it("send no write and append no ledger entry, whatever they answer", async () => {
    const world = workspace();
    await invoiceEvidence(world);
    await milestoneEvidence(world);
    await invoiceEvidence(world, "not-a-uuid");
    await callRoute(world, getInvoiceReceipt, `/api/v1/invoices/${INVOICE}/receipt`, { id: INVOICE });
    await callRoute(world, getPayeeLockEvidence, "/api/v1/payee-lock/evidence", {});
    await callRoute(world, getClosePack, "/api/v1/close-packs/2026-01", { month: "2026-01" });
    expect(world.requests.length).toBeGreaterThan(0);
    expect(writesIn(world.requests)).toEqual([]);
    expect(world.requests.some((request) => request.path === "/rest/v1/rpc/append_ledger_entry")).toBe(false);
  });
});
