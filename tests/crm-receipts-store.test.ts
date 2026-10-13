import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import type { Connection } from "@/lib/connectors/connections";
import { runWith } from "@/lib/context";
import type { DealRecord } from "@/lib/deals/read";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

vi.mock("server-only", () => ({}));

const { dealFields, receiptStore, toWrite } = await import("@/lib/connectors/crm-receipts-store");
const { readDealCollections } = await import("@/lib/deals/collection-read");
type WriteDbRow = import("@/lib/connectors/crm-receipts-store").WriteDbRow;

/**
 * What a deal collected, from the rows as the store reads them (docs/superpowers/specs/2026-10-13-crm-receipts-design.md
 * R1): the deal's receivables, the allocations on them (a reversal undoes its row), the payments that brought them, and
 * the whole matches. Only money that arrived on Arc and was applied counts.
 */

const HASH = `0x${"ab".repeat(32)}`;

const deal = (lines: Array<{ id: string; status: "planned" | "released"; amountMinor: number; receivable?: string }>): DealRecord => ({
  facts: {
    id: "deal-1",
    status: "active",
    version: 1,
    totalMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0),
    currency: "USDC",
    startsOn: "2026-10-01",
    termsDays: 14,
    autoRelease: false,
    lines: lines.map((line, index) => ({
      id: line.id,
      position: index + 1,
      kind: "charge",
      label: `Line ${index + 1}`,
      invoiceOn: "2026-10-01",
      dueOn: "2026-10-15",
      amountMinor: line.amountMinor,
      roundingMinor: 0,
      status: line.status,
      addedIn: 1,
      endedIn: null,
      replaces: null,
      releasedAt: line.status === "released" ? "2026-10-01T00:00:00Z" : null,
      releasedVia: line.status === "released" ? "person" : null,
      receivable: line.receivable ? { id: line.receivable, status: "pending", dueDate: "2026-10-15" } : null,
    })),
  },
  title: "Website rebuild",
  customer: { id: "cp-1", name: "Northwind" },
  digits: 2,
  externalRef: "9001",
  template: "custom",
  createdBy: null,
  createdAt: "2026-10-01T00:00:00Z",
  autoReleaseBy: null,
  autoReleaseAt: null,
  versions: [],
});

const receivable = (id: string, amount: number, status = "pending") => ({
  id,
  deal_id: "deal-1",
  amount: amount.toFixed(6),
  currency: "USDC",
  status,
  due_date: "2026-10-15T12:00:00+00:00",
  original_currency: null,
  original_amount: null,
});

const transfer = (id: string, amount: number, invoiceId: string | null, receivedAt: string) => ({ id, invoice_id: invoiceId, amount: amount.toFixed(6), received_at: receivedAt, tx_hash: HASH, chain: "ARC-TESTNET" });

describe("dealFields", () => {
  it("counts live allocations and whole matches, undoes a reversed one, and leaves the planned line uninvoiced", () => {
    const fields = dealFields({
      deal: deal([
        { id: "l1", status: "released", amountMinor: 300000, receivable: "r1" },
        { id: "l2", status: "released", amountMinor: 200000, receivable: "r2" },
        { id: "l3", status: "planned", amountMinor: 500000 },
      ]),
      receivables: [receivable("r1", 3000, "received"), receivable("r2", 2000)],
      allocations: [
        { id: "a1", kind: "payment", invoice_id: "r2", transfer_id: "t2", amount: "800.000000", reverses: null },
        { id: "a2", kind: "payment", invoice_id: "r2", transfer_id: "t3", amount: "500.000000", reverses: null },
        { id: "a3", kind: "reversal", invoice_id: "r2", transfer_id: "t3", amount: "500.000000", reverses: "a2" },
      ],
      transfers: new Map([
        ["t2", transfer("t2", 800, null, "2026-10-12T09:00:00Z")],
        ["t3", transfer("t3", 500, null, "2026-10-12T12:00:00Z")],
      ]),
      wholeMatches: [transfer("t1", 3000, "r1", "2026-10-10T09:00:00Z")],
      today: "2026-10-13",
      evidence: "https://www.vestiarion.xyz/o/northstar/invoices/deals/deal-1",
    });
    expect(fields).toMatchObject({
      vestiarion_collected: "3800.00",
      vestiarion_still_owed: "1200.00",
      vestiarion_collection_status: "partly_paid",
      vestiarion_last_receipt_date: "2026-10-12",
      vestiarion_last_receipt_amount: "800.00",
      vestiarion_reconciliation: "reconciled",
    });
  });

  it("never counts an invoice marked received with no payment on Arc", () => {
    const fields = dealFields({
      deal: deal([{ id: "l1", status: "released", amountMinor: 300000, receivable: "r1" }]),
      receivables: [receivable("r1", 3000, "received")],
      allocations: [],
      transfers: new Map(),
      wholeMatches: [],
      today: "2026-10-13",
      evidence: "https://example.test/d",
    });
    expect(fields).toMatchObject({ vestiarion_collected: "0.00", vestiarion_still_owed: "0.00", vestiarion_reconciliation: "needs_review", vestiarion_last_receipt_date: "" });
  });
});

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a07";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

function scope(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((sent) => respond(sent) ?? { body: [] });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  return { fake, run };
}

const FIELDS = {
  vestiarion_collected: "2000.00",
  vestiarion_still_owed: "3000.00",
  vestiarion_currency: "USDC",
  vestiarion_collection_status: "partly_paid",
  vestiarion_last_receipt_date: "2026-10-12",
  vestiarion_last_receipt_amount: "2000.00",
  vestiarion_last_receipt_link: "",
  vestiarion_reconciliation: "reconciled",
  vestiarion_evidence_link: "https://example.test/o/acme/invoices/deals/deal-1",
};

const writeRow = (fields: Partial<WriteDbRow> = {}): WriteDbRow => ({
  id: "write-1",
  connection_id: "conn-1",
  crm_deal_id: "crm-1",
  deal_id: "deal-1",
  external_deal_id: "9001",
  fields: FIELDS,
  network: "arc-testnet",
  shadow: false,
  account_type: "DEVELOPER_TEST",
  account_test: true,
  state: "sending",
  reason: null,
  message: null,
  attempts: 2,
  next_attempt_at: null,
  sending_until: "2026-10-13T08:02:00.000Z",
  conflicts: null,
  overwrite: null,
  overwrite_by: null,
  overwrite_at: null,
  read_back: null,
  sent_at: null,
  written_at: null,
  created_at: "2026-10-13T08:00:00.000Z",
  ...fields,
});

describe("the outbox's store", () => {
  it("moves a run's own claim only while it is still that run's: a later claim of the same write is never moved by it", async () => {
    const { fake, run } = scope();
    const claimed = toWrite(writeRow());
    await run(() => receiptStore.move(claimed, ["sending"], "failed", { reason: "no_answer", message: "HubSpot did not answer.", sendingUntil: null, nextAttemptAt: "2026-10-13T08:03:00.000Z" }));
    const patch = fake.requests.find((sent) => sent.method === "PATCH");
    expect(patch?.params.get("state")).toBe("in.(sending)");
    expect(patch?.params.get("attempts")).toBe("eq.2");
  });

  it("names, as Vestiarion's own, only writes tried since the last one read back, and never the write in hand", async () => {
    const { fake, run } = scope((sent) => {
      if (sent.path !== "/rest/v1/crm_receipt_writes") return undefined;
      if (sent.params.get("state") === "eq.written") return { body: [{ created_at: "2026-10-12T10:00:00+00:00" }] };
      return {
        body: [
          { id: "write-3", fields: { ...FIELDS, vestiarion_collected: "2500.00" }, created_at: "2026-10-13T07:00:00+00:00" },
          { id: "write-0", fields: { ...FIELDS, vestiarion_collected: "1000.00" }, created_at: "2026-10-11T07:00:00+00:00" },
        ],
      };
    });
    const sent = await run(() => receiptStore.unacknowledged("crm-1", "write-4"));
    expect(sent.map((fields) => fields.vestiarion_collected)).toEqual(["2500.00"]);
    const tried = fake.requests.find((request) => request.params.get("attempts"));
    expect(tried?.params.get("crm_deal_id")).toBe("eq.crm-1");
    expect(tried?.params.get("attempts")).toBe("gt.0");
    expect(tried?.params.get("state")).toBe("in.(failed,superseded,conflict)");
    expect(tried?.params.get("id")).toBe("neq.write-4");
  });

  it("queues a newer write with a person's choice to write over what the CRM held, when it carries one", async () => {
    const { fake, run } = scope((sent) => (sent.method === "POST" ? { status: 201, body: [writeRow({ state: "queued", attempts: 0 })] } : undefined));
    const connection = { id: "conn-1", provider: "hubspot", externalOrgId: "48291736" } as Connection;
    const deal = { crmDealId: "crm-1", dealId: "deal-1", externalDealId: "9001", title: "Website rebuild", fields: FIELDS, network: "arc-testnet" as const, shadow: false };
    await run(() => receiptStore.insert(connection, deal, { overwrite: { vestiarion_still_owed: "0" }, overwriteBy: "user-1", overwriteAt: "2026-10-13T08:00:00.000Z" }));
    await run(() => receiptStore.insert(connection, deal, null));
    const [carried, plain] = fake.requests.filter((sent) => sent.method === "POST").map((sent) => sent.body as Record<string, unknown>);
    expect(carried).toMatchObject({ overwrite: { vestiarion_still_owed: "0" }, overwrite_by: "user-1", overwrite_at: "2026-10-13T08:00:00.000Z" });
    expect(plain).not.toHaveProperty("overwrite");
  });
});

describe("readDealCollections", () => {
  it("reads every page of a deal's receivables, so a large deal is never cut off", async () => {
    const deal = { facts: { id: "deal-1", status: "active", currency: "USDC", lines: [] }, digits: 2 } as unknown as DealRecord;
    const many = Array.from({ length: 1001 }, (_, index) => ({
      id: `r${String(index).padStart(4, "0")}`,
      deal_id: "deal-1",
      amount: "1.000000",
      currency: "USDC",
      status: "pending",
      due_date: "2026-10-20",
      original_currency: null,
      original_amount: null,
    }));
    const { fake, run } = scope((sent) => {
      if (sent.path !== "/rest/v1/invoices") return undefined;
      const [from, to] = [Number(sent.params.get("offset") ?? 0), Number(sent.params.get("offset") ?? 0) + Number(sent.params.get("limit") ?? 1000) - 1];
      return { body: many.slice(from, to + 1) };
    });
    const read = await run(() => readDealCollections([deal], "2026-10-13"));
    expect(read.get("deal-1")?.collection).toMatchObject({ invoicedMinor: 100_100, stillOwedMinor: 100_100, collectedMinor: 0 });
    expect(fake.requests.filter((sent) => sent.path === "/rest/v1/invoices")).toHaveLength(2);
  });
});
