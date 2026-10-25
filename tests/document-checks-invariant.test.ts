import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferParams, TransferResult } from "@/lib/circle";
import { ARC_TESTNET } from "@/lib/network";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { paymentIntentsBackend } from "./support/payment-intents";

/**
 * The invariant of docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md (DK7, DK8): a bill whose
 * purchase order came from its vendor's document is never paid or scheduled without a person. Driven end to end over one
 * workspace's rows: the document checks stage reads the vendor's real PDF with the rule-based reader, 0144's
 * check_document_request (as this fake applies it) adds the purchase order and the marker, the follow-up reopens the bill
 * (its own tests: tests/follow-up.test.ts), and the real AP stage then decides it, with the written policy, the
 * guardrails, the payment path and a really signed entry, and holds it. Nothing is sent.
 */

const { storage } = vi.hoisted(() => ({ storage: { download: vi.fn() } }));
vi.mock("@/lib/dal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/dal")>()), platformStorage: () => storage }));

import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { checkReceivedDocuments } from "@/lib/agent/document-checks";
import { CycleMetricsCollector } from "@/lib/agent/cycle-metrics";
import { onChainLimitGate } from "@/lib/agent/onchain-limit";
import { runApStage, type CycleLogLine } from "@/lib/agent/orchestrator";

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000d0c5";
const INVOICE = "018f8ce0-1557-7b54-a931-4d777f6bd001";
const VENDOR = "018f8ce0-1557-7b54-a931-4d777f6bd002";
const REQUEST = "018f8ce0-1557-7b54-a931-4d777f6bd003";
const ACCOUNT = "018f8ce0-1557-7b54-a931-4d777f6bd004";
const ADDRESS = "0x5aF3107A4000000000000000000000000000b0b0";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const LEDGER_ROW = {
  seq: 1, id: "e1", ts: "2026-10-02T00:00:00Z", actor: "agent", domain: "ap", action: "x",
  summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
};

/** INV-2207 from Northwind Hosting: purchase order PO-1042, total due 200.00 USDC, to be paid to ADDRESS. */
const PDF = new Uint8Array(readFileSync(path.join(process.cwd(), "tests", "fixtures", "invoice-document", "northwind-inv-2207.pdf")));
const PDF_SHA = crypto.createHash("sha256").update(PDF).digest("hex");

class Chain implements ChainProvider {
  readonly network = ARC_TESTNET;
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.003;
  transfers: TransferParams[] = [];
  async transfer(params: TransferParams): Promise<TransferResult> {
    this.transfers.push(params);
    return {
      providerTxId: "circle-tx-1", txHash: "0xhash", txRef: "0xhash", chain: "ARC-TESTNET", status: "confirmed",
      feeUsd: 0.003, feeSource: "chain_reported", providerMode: "live", settledInMs: 4000, providerState: "COMPLETE", failureReason: null,
    };
  }
  async reconcileTransfer(): Promise<TransferResult> { throw new Error("not used"); }
  async getBalance(): Promise<BalanceSnapshot> { throw new Error("not used"); }
  async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
  async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
}

/** One workspace: Northwind Hosting's bill waiting for its purchase order, and the PDF Northwind sent for it. */
function workspace(setting: "on" | "shadow") {
  const bill: Record<string, unknown> = {
    id: INVOICE, direction: "payable", status: "awaiting_info", amount: "200.000000", currency: "USDC", memo: "INV-2207", po_reference: null,
    goods_received: true, due_date: "2026-10-01T12:00:00+00:00", counterparty_id: VENDOR, agent_reasoning: "No purchase order on file.",
    tx_ref: null, decided_at: "2026-09-30T09:00:00+00:00", scheduled_for: null, paid_amount: null, early_pay_discount_pct: null, discount_due_date: null,
    created_at: "2026-09-30T08:00:00+00:00",
    counterparties: {
      id: VENDOR, name: "Northwind Hosting", role: "vendor", risk_level: "low", payment_limit: "1000", performance_score: null, performance_inputs: null,
      address: ADDRESS, address_changed_at: null, address_confirmed_at: null, chain: null, purchase_order_required: true, notice_email: "billing@northwind.example",
    },
  };
  const request: Record<string, unknown> = {
    id: REQUEST, invoice_id: INVOICE, counterparty_id: VENDOR, status: "answered", po_reference: "PO-1042", answered_at: "2026-10-01T09:00:00Z",
    file_path: `${ORG}/document-requests/${REQUEST}/${PDF_SHA}`, file_sha256: PDF_SHA, file_type: "application/pdf", file_size: PDF.byteLength,
    source: "vendor", checked_at: null, po_written: false,
  };
  const intents = paymentIntentsBackend(ORG);
  const fake = fakeSupabase((sent: RecordedRequest): FakeReply => {
    if (sent.path === "/rest/v1/orgs") {
      return {
        body: {
          id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", circle_api_key_enc: null, circle_entity_secret_enc: null,
          ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
        },
      };
    }
    if (sent.path === "/rest/v1/approval_policies") return { body: [{ document_requests: setting, two_approvals_above: null, payee_lock: false, payee_lock_cooling_hours: 0 }] };
    if (sent.path === "/rest/v1/rpc/agent_paused") return { body: false };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: LEDGER_ROW };
    if (sent.path === "/rest/v1/document_requests") {
      if (sent.params.get("checked_at") === "is.null") return { body: request.checked_at === null ? [request] : [] };
      if (sent.params.get("checked_at") === "not.is.null") return { body: request.checked_at === null ? [] : [request] };
      if (sent.params.get("po_written") === "eq.true") return { body: request.po_written ? [request] : [] };
      return { body: [] };
    }
    // 0144's check_document_request, as it applies a check: once, and the purchase order compare-and-set on the bill.
    if (sent.path === "/rest/v1/rpc/check_document_request") {
      const args = sent.body as { p_outcome: string; p_document_po: string | null; p_write_po: boolean; p_shadow: boolean };
      if (request.checked_at !== null) return { body: "already_checked" };
      if (args.p_write_po) {
        if (bill.status !== "awaiting_info" || bill.po_reference !== null || intents.rows.length > 0) return { body: "bill_moved" };
        bill.po_reference = args.p_document_po;
      }
      Object.assign(request, { checked_at: "2026-10-02T09:00:01Z", check_outcome: args.p_outcome, check_shadow: args.p_shadow, po_written: args.p_write_po });
      return { body: args.p_write_po ? "written" : "checked" };
    }
    if (sent.path === "/rest/v1/invoices" && sent.method === "GET") {
      const status = sent.params.get("status");
      const statuses = status?.match(/^in\.\((.*)\)$/)?.[1].split(",") ?? (status?.startsWith("eq.") ? [status.slice(3)] : undefined);
      return { body: !statuses || statuses.includes(bill.status as string) ? [bill] : [] };
    }
    if (sent.path === "/rest/v1/invoices" && sent.method === "PATCH") {
      Object.assign(bill, sent.body as Record<string, unknown>);
      return { body: [] };
    }
    if (sent.path === "/rest/v1/accounts" && sent.method === "GET") return { body: { id: ACCOUNT, chain: "ARC-TESTNET", token: "USDC", balance: "1000", apy: "0" } };
    return intents.respond(sent);
  });
  const chain = new Chain();
  const inOrg = <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn));
  const check = () => inOrg(() => checkReceivedDocuments(db(), { now: Date.now(), allowRead: () => true }));
  const lines: CycleLogLine[] = [];
  const decide = () =>
    inOrg(() =>
      runApStage({
        db: db(), provider: chain, operating: { id: ACCOUNT }, operatingBalance: 1000, reserveApy: 0.045, reserveBalance: 0,
        metrics: new CycleMetricsCollector(), lines, onChainLimit: onChainLimitGate({ read: async () => null }),
      })
    );
  const signed = () =>
    fake.requests.filter((r) => r.path === "/rest/v1/rpc/append_ledger_entry").map((r) => r.body as { p_action: string; p_detail: Record<string, unknown> });
  return { bill, request, intents, chain, check, decide, signed };
}

const saved = process.env.VESTIARION_MASTER_KEYS;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T09:00:00.000Z"));
  storage.download.mockReset().mockImplementation(async () => ({ data: new Blob([PDF]), error: null }));
});
afterEach(() => {
  vi.useRealTimers();
  if (saved === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = saved;
});

describe("a bill completed by its vendor's document (document checks DK7, DK8)", () => {
  it("gets its purchase order from the check, and is then held by the AP stage for a person, with nothing sent", async () => {
    const world = workspace("on");

    await world.check();
    expect(world.bill).toMatchObject({ status: "awaiting_info", po_reference: "PO-1042", goods_received: true });
    expect(world.request).toMatchObject({ check_outcome: "matched", po_written: true });
    // The follow-up reopens it: "purchase order PO-1042 has since been supplied".
    world.bill.status = "pending";

    await world.decide();

    expect(world.chain.transfers).toEqual([]);
    expect(world.intents.rows).toEqual([]);
    expect(world.bill).toMatchObject({ status: "held", tx_ref: null, scheduled_for: null, paid_amount: null });
    expect(world.bill.agent_reasoning).toContain(
      "[guardrail override: its purchase order came from Northwind Hosting's document, which code checked against the bill — payment refused before execution; held for a person to approve]"
    );
    const [checked, decided] = world.signed();
    expect(checked).toMatchObject({ p_action: "document_checked", p_detail: { outcome: "matched", poWritten: true, poReference: "PO-1042", reader: "heuristic" } });
    expect(decided).toMatchObject({
      p_action: "ap_pay",
      p_detail: {
        decisionMode: "heuristic",
        guardrailBlocked: true,
        guardrailRule: "invoice.vendor_document",
        vendorDocument: { requestId: REQUEST, source: "vendor", fileSha256: PDF_SHA },
        execution: { resultingStatus: "held" },
      },
    });
  });

  it("stays held each time it is decided again, until a person approves it", async () => {
    const world = workspace("on");
    await world.check();
    world.bill.status = "pending";
    await world.decide();
    for (const again of [1, 2]) {
      // Returned to the agent, or reopened by the follow-up: decided again, held again.
      world.bill.status = "pending";
      await world.decide();
      expect(world.bill.status, String(again)).toBe("held");
    }
    expect(world.chain.transfers).toEqual([]);
    // Checked once: the next cycle reads nothing more.
    await world.check();
    expect(world.signed().filter((entry) => entry.p_action === "document_checked")).toHaveLength(1);
  });

  it("in shadow, adds nothing: the bill keeps waiting for its purchase order, and is never decided", async () => {
    const world = workspace("shadow");
    await world.check();
    expect(world.bill).toMatchObject({ status: "awaiting_info", po_reference: null });
    expect(world.request).toMatchObject({ check_outcome: "matched", po_written: false, check_shadow: true });
    await world.decide();
    expect(world.chain.transfers).toEqual([]);
    expect(world.bill.status).toBe("awaiting_info");
  });

  it("pays the same bill on its own when a person typed its purchase order instead, as before", async () => {
    // The control: the hold comes from the document's marker, not from anything else about this bill.
    const world = workspace("on");
    world.bill.po_reference = "PO-1042";
    world.bill.status = "pending";
    await world.decide();
    expect(world.chain.transfers.map((transfer) => transfer.amount)).toEqual([200]);
  });
});
