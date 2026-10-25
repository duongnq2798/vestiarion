import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntryInput, LedgerRow } from "@/lib/ledger";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { buildChain } from "./support/ledger-chain";
import type { FakeReply, RecordedRequest } from "./support/fake-supabase";
import { API_ORG, apiConfig, apiWorld, callRoute, readKey, WORKSPACE, writesIn } from "./support/evidence-api";
import { samplePack } from "./support/close-pack-fixtures";

/**
 * A month's close pack through the API (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md
 * EA1-EA3, EA5, EA7, EA8): the signed JSON the Monthly close pack page downloads, members by user id; a month that does
 * not read refused before anything is read; over 4 MB refused; and, unlike the download, no `close_pack_exported`.
 */

const active = crypto.generateKeyPairSync("ed25519");
const { readSpy } = vi.hoisted(() => ({ readSpy: vi.fn() }));
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
vi.mock("@/lib/close-pack/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/close-pack/read")>();
  readSpy.mockImplementation(actual.readClosePack);
  return { ...actual, readClosePack: readSpy };
});

import { GET } from "@/app/api/v1/close-packs/[month]/route";
import { API_DOCUMENT_MAX_BYTES } from "@/lib/api/evidence";
import { closePackDocument } from "@/lib/close-pack/export";
import { closePackMonth } from "@/lib/close-pack/month";
import { readClosePack } from "@/lib/close-pack/read";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { authenticateApiKey } from "@/lib/platform/api-keys";
import { publicOrigin } from "@/lib/public-origin";

const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b1";
const APPROVER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b2";
const CP = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003b1";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001b1";
const PAYEE = "0x1111111111111111111111111111111111111111";
const TX = `0x${"1".repeat(64)}`;
const EMAILS = ["owner@northstar.test", "approver@northstar.test"];
const NOW = new Date("2026-02-05T09:00:00Z");

const INPUTS: LedgerEntryInput[] = [
  { actor: "human", domain: "compliance", action: "create_counterparty", summary: "Added Northwind", detail: { by: OWNER, counterpartyId: CP, address: PAYEE } },
  { actor: "human", domain: "compliance", action: "counterparty_address_confirmed", summary: "Confirmed", detail: { by: APPROVER, counterpartyId: CP, address: PAYEE, chain: "ARC-TESTNET", via: "confirm" } },
  { actor: "human", domain: "ap", action: "create_invoice", summary: "Added a bill", detail: { by: OWNER, invoiceId: INVOICE, counterpartyId: CP, amount: 10, currency: "USDC", invoiceNumber: "INV-1" } },
  { actor: "human", domain: "ap", action: "approval_paid", summary: "Approved and paid", detail: { by: APPROVER, invoiceId: INVOICE, counterpartyId: CP, amount: 10, currency: "USDC", txRef: TX, status: "paid" } },
];
const ROWS: Array<LedgerRow & { org_id: string }> = buildChain(INPUTS, active.privateKey, ledgerKeyId(active.publicKey)).map((row) => ({ ...row, org_id: API_ORG }));

const INTENT = {
  id: "pay-1", org_id: API_ORG, source_type: "invoice", source_id: INVOICE, status: "confirmed", provider: "circle", provider_mode: "live", provider_tx_id: "circle-1",
  provider_state: "COMPLETE", failure_reason: null, last_error: null, amount: "10.000000", token: "USDC", destination: PAYEE, tx_hash: TX, chain: "ARC-TESTNET",
  destination_chain: null, mint_tx_hash: null, bridge_fee: null, payout_route: null, network: "arc-testnet", fee_usd: "0.004", fee_source: "chain_reported",
  transfer_attempt: 1, previous_attempts: [], batch_key: null, created_at: "2026-01-05T10:00:00Z", updated_at: "2026-01-05T10:00:05Z",
  submitted_at: "2026-01-05T10:00:00Z", executed_at: "2026-01-05T10:00:05Z", confirmed_at: "2026-01-05T10:00:05Z",
};
const INVOICE_ROW = {
  id: INVOICE, org_id: API_ORG, direction: "payable", counterparty_id: CP, amount: "10.000000", currency: "USDC", paid_amount: null, memo: null, po_reference: null,
  due_date: "2026-01-10", status: "paid", tx_ref: TX, settled_at: "2026-01-05T10:00:06Z",
};

const values = (filter: string | null) =>
  filter?.startsWith("in.(") ? filter.slice(4, -1).split(",").map((one) => one.replace(/^"|"$/g, "")) : filter?.startsWith("eq.") ? [filter.slice(3)] : null;

/** The ledger as PostgREST would filter it: by action and by the detail field a read names. */
function ledger(request: RecordedRequest): LedgerRow[] {
  if (request.params.get("select") === "seq,hash") return ROWS.slice(-1);
  if (request.params.get("select") === "ts") return [];
  let rows: LedgerRow[] = ROWS;
  const actions = values(request.params.get("action"));
  if (actions) rows = rows.filter((row) => actions.includes(row.action));
  for (const field of ["invoiceId", "milestoneId", "counterpartyId", "subjectId"]) {
    const wanted = values(request.params.get(`detail->>${field}`));
    if (wanted) rows = rows.filter((row) => wanted.includes(String(row.detail[field])));
  }
  return rows;
}

function workspace(options: { payTo?: "missing" } = {}) {
  return apiWorld((request: RecordedRequest): FakeReply => {
    switch (request.path) {
      case "/rest/v1/payment_intents":
        return { body: [INTENT] };
      case "/rest/v1/invoices":
        if ((request.params.get("select") ?? "").includes("document_pay_to")) {
          return options.payTo === "missing" ? { status: 400, body: { code: "42703", message: "column invoices.document_pay_to does not exist" } } : { body: [] };
        }
        return { body: [INVOICE_ROW] };
      case "/rest/v1/counterparties":
        return { body: [{ id: CP, org_id: API_ORG, name: "Northwind Supplies", address: PAYEE, chain: "ARC-TESTNET", sample: false }] };
      case "/rest/v1/ledger_entries":
        return { body: ledger(request) };
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

const closePack = (world: ReturnType<typeof workspace>, month: string) => callRoute(world, GET, `/api/v1/close-packs/${month}`, { month });
type Answer = { data: Record<string, unknown> & { month: { key: string; ended: boolean }; rows: Array<{ checks: { payTo: { kind: string; text: string } }; approval: { approvals: Array<{ who: unknown }> } }> } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const key = readKey();
  vi.mocked(authenticateApiKey).mockReset();
  vi.mocked(authenticateApiKey).mockImplementation(async () => key);
});
afterEach(() => vi.useRealTimers());

describe("GET /api/v1/close-packs/{month} (evidence API EA1, EA2)", () => {
  it("answers the page's signed JSON for the month, read with members by id", async () => {
    const world = workspace();
    const response = await closePack(world, "2026-01");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { data } = (await response.json()) as Answer;
    expect(data.format).toBe("vestiarion-close-pack/1");
    expect(data.month).toMatchObject({ key: "2026-01", ended: true });
    expect(data.rows).toHaveLength(1);

    const expected = await runWith({ config: apiConfig, db: world.client, fetch: world.fetch }, () =>
      withOrg(API_ORG, async () => closePackDocument(await readClosePack({ month: closePackMonth("2026-01", NOW)!, workspace: WORKSPACE, people: "id" }), { origin: publicOrigin() }))
    );
    expect(data).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("names every member by user id, with no email anywhere in the answer (EA3)", async () => {
    const response = await closePack(workspace(), "2026-01");
    const text = await response.text();
    for (const email of EMAILS) expect(text).not.toContain(email);
    const { data } = JSON.parse(text) as Answer;
    expect(data.rows[0].approval.approvals.map((approval) => approval.who)).toEqual([{ kind: "member", userId: APPROVER, email: null, roleNow: "approver" }]);
  });

  it("reads this month so far", async () => {
    const { data } = (await (await closePack(workspace(), "2026-02")).json()) as Answer;
    expect(data.month).toMatchObject({ key: "2026-02", ended: false });
  });

  it.each(["2026-13", "202610", "2019-12", "2026-03"])("refuses %s before any request to the workspace (EA5)", async (month) => {
    const world = workspace();
    const response = await closePack(world, month);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "month must be YYYY-MM, and not a month still to come" } });
    expect(world.requests).toEqual([]);
  });

  it("answers 200 before migration 0136, the pay-to check not applying", async () => {
    const response = await closePack(workspace({ payTo: "missing" }), "2026-01");
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as Answer;
    expect(data.rows[0].checks.payTo.kind).toBe("not_applicable");
  });

  it("records no close_pack_exported, and writes nothing (EA8)", async () => {
    const world = workspace();
    await closePack(world, "2026-01");
    expect(writesIn(world.requests)).toEqual([]);
    expect(JSON.stringify(world.requests.map((request) => request.body ?? null))).not.toContain("close_pack_exported");
  });
});

describe("a close pack over 4 MB (evidence API EA7)", () => {
  /** A pack whose answer is exactly `bytes` long: the sample pack, its workspace's name padded. */
  function packOf(bytes: number) {
    const pack = samplePack();
    const empty = JSON.stringify({ data: closePackDocument({ ...pack, workspace: { ...pack.workspace, name: "" } }, { origin: publicOrigin() }) });
    return { ...pack, workspace: { ...pack.workspace, name: "x".repeat(bytes - new TextEncoder().encode(empty).length) } };
  }

  it("refuses one over the cap with the page to download it from, and answers one at the cap", async () => {
    readSpy.mockResolvedValueOnce(packOf(API_DOCUMENT_MAX_BYTES + 1));
    const over = await closePack(workspace(), "2026-01");
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "This month's close pack is over 4 MB, more than one answer carries. Download it from the workspace's Monthly close pack page.",
      },
    });

    readSpy.mockResolvedValueOnce(packOf(API_DOCUMENT_MAX_BYTES));
    const at = await closePack(workspace(), "2026-01");
    expect(at.status).toBe(200);
    expect(new TextEncoder().encode(await at.text()).length).toBe(API_DOCUMENT_MAX_BYTES);
  });
});
