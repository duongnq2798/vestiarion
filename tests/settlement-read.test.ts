import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { INTENT_COLUMNS, readInvoicePayments, readPaymentsInFlight } from "@/lib/settlement-read";
import type { IntentRecord } from "@/lib/settlement-facts";
import { carriesOrg, fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * The reads behind a payment's lifecycle (docs/superpowers/specs/2026-10-11-settlement-lifecycle-design.md L8): named
 * columns, the workspace's own rows, a page at a time; Treasury's are the payments not confirmed and the confirmed ones
 * of the bills it shows in flight.
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
  it("reads every intent not confirmed, and the confirmed ones of the bills shown in flight", async () => {
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
