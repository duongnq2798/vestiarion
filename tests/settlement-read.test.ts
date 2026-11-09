import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { INTENT_COLUMNS, readIntentsFor, readInvoicePayments, readPaymentsInFlight } from "@/lib/settlement-read";
import type { IntentRecord } from "@/lib/settlement-facts";
import { carriesOrg, fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * The reads behind a payment's lifecycle (docs/superpowers/specs/2026-10-11-settlement-lifecycle-design.md L8): named
 * columns, the workspace's own rows, a page at a time; Treasury's are the payments not confirmed and the confirmed ones
 * of the bills someone comes back to.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d5e71";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const row = (id: string, over: Record<string, unknown> = {}) => ({
  source_type: "invoice",
  source_id: id,
  amount: "12.500000",
  token: null,
  status: "pending",
  provider: "circle",
  provider_mode: "live",
  provider_tx_id: "circle-1",
  provider_state: "SENT",
  failure_reason: null,
  last_error: null,
  tx_hash: null,
  mint_tx_hash: null,
  destination_chain: null,
  transfer_attempt: 1,
  previous_attempts: [],
  submitted_at: "2026-10-11T10:00:00Z",
  executed_at: "2026-10-11T10:00:02Z",
  confirmed_at: null,
  created_at: "2026-10-11T09:59:59Z",
  updated_at: "2026-10-11T10:00:02Z",
  batch_key: null,
  network: "arc-testnet",
  ...over,
});

describe("the columns", () => {
  it("are exactly the ones the lifecycle reads, with the source, amount and token", () => {
    const record: Record<keyof IntentRecord, true> = {
      status: true, provider: true, provider_mode: true, provider_tx_id: true, provider_state: true, failure_reason: true, last_error: true, tx_hash: true,
      mint_tx_hash: true, destination_chain: true, transfer_attempt: true, previous_attempts: true, submitted_at: true, executed_at: true, confirmed_at: true,
      created_at: true, updated_at: true, batch_key: true, network: true,
    };
    expect(INTENT_COLUMNS.split(", ").sort()).toEqual([...Object.keys(record), "source_type", "source_id", "amount", "token"].sort());
  });
});

describe("readInvoicePayments", () => {
  it("reads every invoice's intent in the workspace's scope, by invoice id, with its amount as a number and USDC by default", async () => {
    const fake = fakeSupabase((request: RecordedRequest) => (request.path === "/rest/v1/payment_intents" ? { body: [row("inv-1"), row("inv-2", { token: "EURC" })] } : { body: [] }));
    const read = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => readInvoicePayments(db()));
    expect([...read.keys()]).toEqual(["inv-1", "inv-2"]);
    expect(read.get("inv-1")).toMatchObject({ amount: 12.5, token: "USDC", provider_state: "SENT" });
    expect(read.get("inv-2")?.token).toBe("EURC");
    const [request] = fake.requests;
    expect(request.params.get("select")).toBe(INTENT_COLUMNS.replaceAll(" ", ""));
    expect(request.params.get("source_type")).toBe("eq.invoice");
    expect(carriesOrg(request, ORG)).toBe(true);
  });

  it("pages through a long-lived workspace's payments", async () => {
    const fake = fakeSupabase((request) => {
      const offset = Number(request.params.get("offset") ?? 0);
      return { body: offset === 0 ? Array.from({ length: 1000 }, (_, index) => row(`inv-${index}`)) : [row("inv-last")] };
    });
    const read = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => readInvoicePayments(db()));
    expect(read.size).toBe(1001);
    expect(fake.requests).toHaveLength(2);
  });

  it("throws a read that failed, for the page to catch", async () => {
    const fake = fakeSupabase(() => ({ status: 500, body: { message: "down" } }));
    await expect(runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => readInvoicePayments(db()))).rejects.toThrow("down");
  });
});

describe("readPaymentsInFlight", () => {
  it("reads every intent not confirmed, and the confirmed ones of the bills it is given", async () => {
    const fake = fakeSupabase((request) => {
      if (request.params.get("status") === "neq.confirmed") return { body: [row("inv-1"), row("ms-1", { source_type: "milestone" })] };
      if (request.params.get("status") === "eq.confirmed") return { body: [row("inv-9", { status: "confirmed" })] };
      return { body: [] };
    });
    const read = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => readPaymentsInFlight(db(), ["inv-9", "inv-9", "ms-3"]));
    expect(read.map((payment) => [payment.source_type, payment.source_id, payment.status])).toEqual([
      ["invoice", "inv-1", "pending"],
      ["milestone", "ms-1", "pending"],
      ["invoice", "inv-9", "confirmed"],
    ]);
    const confirmed = fake.requests.find((request) => request.params.get("status") === "eq.confirmed");
    expect(confirmed?.params.get("source_id")).toBe("in.(inv-9,ms-3)");
    expect(fake.requests.every((request) => carriesOrg(request, ORG))).toBe(true);
  });

  it("asks for no confirmed intent when no bill is shown in flight", async () => {
    const fake = fakeSupabase(() => ({ body: [] }));
    await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => readPaymentsInFlight(db(), []));
    expect(fake.requests.map((request) => request.params.get("status"))).toEqual(["neq.confirmed"]);
  });
});

describe("readIntentsFor (counterparty page CL9, CL13)", () => {
  const run = <T>(fake: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  const asked = (request: RecordedRequest) => (request.params.get("source_id") ?? "").replace(/^in\.\(|\)$/g, "").split(",");

  it("reads one counterparty's intents by the ids of what they pay, each kind on its own, with where each was sent kept apart", async () => {
    const fake = fakeSupabase((request) =>
      request.params.get("source_type") === "eq.invoice"
        ? { body: [{ ...row("inv-1", { status: "confirmed" }), destination: "0xAbC0000000000000000000000000000000000001" }] }
        : { body: [{ ...row("ms-1", { source_type: "milestone" }), destination: "blindpay:ba_1" }] }
    );
    const read = await run(fake, () => readIntentsFor(db(), { invoiceIds: ["inv-1", "inv-1"], milestoneIds: ["ms-1"] }));
    expect([...read.payments.keys()]).toEqual(["inv-1", "ms-1"]);
    expect(read.payments.get("inv-1")).toMatchObject({ source_type: "invoice", amount: 12.5, token: "USDC", status: "confirmed" });
    // The destination is never on the record the lifecycle reads.
    expect(read.payments.get("inv-1")).not.toHaveProperty("destination");
    expect(read.destinations).toEqual(new Map([["inv-1", "0xAbC0000000000000000000000000000000000001"], ["ms-1", "blindpay:ba_1"]]));
    for (const request of fake.requests) {
      expect(request.params.get("select")).toBe(`${INTENT_COLUMNS},destination`.replaceAll(" ", ""));
      expect(carriesOrg(request, ORG)).toBe(true);
    }
    expect(fake.requests.map((request) => [request.params.get("source_type"), asked(request)])).toEqual([
      ["eq.invoice", ["inv-1"]],
      ["eq.milestone", ["ms-1"]],
    ]);
  });

  it("names a hundred ids a read at most, and reads nothing for none", async () => {
    const fake = fakeSupabase(() => ({ body: [] }));
    const invoices = Array.from({ length: 230 }, (_, index) => `inv-${index}`);
    await run(fake, () => readIntentsFor(db(), { invoiceIds: invoices, milestoneIds: ["ms-1"] }));
    expect(fake.requests.map((request) => asked(request).length)).toEqual([100, 100, 30, 1]);
    const none = fakeSupabase(() => ({ body: [] }));
    expect(await run(none, () => readIntentsFor(db(), {}))).toEqual({ payments: new Map(), destinations: new Map() });
    expect(none.requests).toHaveLength(0);
  });

  it("throws a read that failed, for the page to say the part was not read", async () => {
    const fake = fakeSupabase(() => ({ status: 500, body: { message: "down" } }));
    await expect(run(fake, () => readIntentsFor(db(), { invoiceIds: ["inv-1"] }))).rejects.toThrow("down");
  });
});
