import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { ChainProvider, TransferResult } from "@/lib/circle/types";
import { MAINNET_NOT_CONNECTED } from "@/lib/mainnet";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * The transfer watch (docs/superpowers/specs/2026-10-06-stuck-transfer-alert-design.md D1–D5, D9, D10): every 5 minutes
 * it finds the live payments whose current attempt was sent more than the network's stuckAfterMinutes ago, asks Circle
 * again, read-only, and signs a `payment_stuck` entry for each still unconfirmed, once per attempt. It sends, retries,
 * settles and holds nothing.
 */

const { ledgerMock } = vi.hoisted(() => ({ ledgerMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: ledgerMock }));

const { watchStuckTransfers } = await import("@/lib/agent/transfer-watch");

const A = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a000";
const B = "5d0f3a2e-8c1b-4f7a-9e6d-00000000b000";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a1";
const MILESTONE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000002b2";
const VENDOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003c3";
const TX = `0x${"ab".repeat(32)}`;
const NOW = Date.parse("2026-10-06T08:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const intent = (overrides: Record<string, unknown> = {}) => ({
  org_id: A,
  source_type: "invoice",
  source_id: INVOICE,
  idempotency_key: "pay-invoice-1",
  provider_tx_id: "circle-tx-1",
  tx_hash: TX,
  amount: "12.500000",
  token: "USDC",
  status: "pending",
  transfer_attempt: 1,
  submitted_at: minutesAgo(20),
  network: "arc-testnet",
  provider_state: "SENT",
  ...overrides,
});

interface World {
  intents?: Array<Record<string, unknown>>;
  told?: Array<Record<string, unknown>>;
  orgs?: Array<{ id: string; slug: string; network?: string }>;
  failNamesFor?: string;
}

function world(input: World = {}) {
  const orgs = input.orgs ?? [{ id: A, slug: "acme" }];
  return fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/payment_intents" && request.method === "GET") {
      // A tenant read, in one workspace's scope.
      return { body: (input.intents ?? [intent()]).filter((row) => request.params.get("org_id") === `eq.${row.org_id}`) };
    }
    if (request.path === "/rest/v1/orgs") {
      const id = request.params.get("id") ?? "";
      if (!id.startsWith("eq.")) return { body: orgs.map(({ id: orgId, slug }) => ({ id: orgId, slug })) };
      const org = orgs.find((candidate) => `eq.${candidate.id}` === id) ?? orgs[0];
      return { body: { id: org.id, slug: org.slug, name: org.slug, mode: "live", network: org.network ?? "arc-testnet", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
    }
    if (request.path === "/rest/v1/ledger_entries") return { body: input.told ?? [] };
    if (input.failNamesFor && request.params.get("org_id") === `eq.${input.failNamesFor}`) return { status: 500, body: { message: "names unavailable" } };
    if (request.path === "/rest/v1/invoices") return { body: [{ id: INVOICE, counterparty_id: VENDOR }] };
    if (request.path === "/rest/v1/milestones") return { body: [{ id: MILESTONE, contractor_id: VENDOR, title: "Landing page" }] };
    if (request.path === "/rest/v1/counterparties") return { body: [{ id: VENDOR, name: "Jiren" }] };
    return { body: [] };
  });
}

function provider(answer: Partial<TransferResult> | Error = { status: "pending", providerState: "STUCK" }) {
  const reconcileTransfer = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return { providerTxId: "circle-tx-1", txHash: TX, txRef: TX, status: "pending", providerMode: "live", ...answer } as TransferResult;
  });
  return { reconcileTransfer, provider: () => ({ reconcileTransfer }) as unknown as ChainProvider };
}

const run = (fake: ReturnType<typeof fakeSupabase>, deps: Parameters<typeof watchStuckTransfers>[0] = {}) =>
  runWith({ config, db: fake.client, fetch: fake.fetch }, () => watchStuckTransfers({ now: () => NOW, ...deps }));

const appended = () => ledgerMock.mock.calls.map((call) => call[0] as { actor: string; domain: string; action: string; summary: string; detail: Record<string, unknown> });
const writes = (fake: ReturnType<typeof fakeSupabase>) =>
  fake.requests.filter((request) => request.method !== "GET" && ["/rest/v1/payment_intents", "/rest/v1/invoices", "/rest/v1/milestones"].includes(request.path));

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  process.env.SITE_URL = "https://www.vestiarion.xyz";
});
afterEach(() => vi.restoreAllMocks());

describe("the transfer watch (stuck-transfer alert)", () => {
  it("reads only live payments in flight sent before the shortest wait of any network (D1, D9)", async () => {
    const fake = world({ intents: [] });
    expect(await run(fake, { provider: provider().provider })).toEqual([]);
    const read = fake.requests.find((request) => request.path === "/rest/v1/payment_intents")!;
    expect(read.params.get("status")).toBe("in.(submitting,pending)");
    expect(read.params.get("provider_mode")).toBe("eq.live");
    expect(read.params.get("submitted_at")).toBe(`lt.${minutesAgo(15)}`);
  });

  it("signs a payment Circle still shows unconfirmed 20 minutes after it was sent, once, and writes nothing else (D5)", async () => {
    const circle = provider({ status: "pending", providerState: "STUCK" });
    const fake = world();
    expect(await run(fake, { provider: circle.provider })).toEqual([{ slug: "acme", inFlight: 1, told: 1 }]);
    expect(circle.reconcileTransfer).toHaveBeenCalledWith("circle-tx-1");
    expect(appended()).toEqual([
      {
        actor: "agent",
        domain: "ap",
        action: "payment_stuck",
        summary: "Payment of 12.5 USDC to Jiren not confirmed 20 min after it was sent on Arc testnet",
        detail: {
          invoiceId: INVOICE,
          counterpartyId: VENDOR,
          amount: 12.5,
          currency: "USDC",
          idempotencyKey: "pay-invoice-1",
          attempt: 1,
          submittedAt: minutesAgo(20),
          minutes: 20,
          circleAsked: true,
          sendAnswered: true,
          providerState: "STUCK",
          txHash: TX,
          network: "arc-testnet",
        },
      },
    ]);
    expect(writes(fake)).toEqual([]);
  });

  it("does not tell a payment sent 10 minutes ago, one already told, or one Circle now shows settled (D1, D5, D10)", async () => {
    await run(world({ intents: [intent({ submitted_at: minutesAgo(10) })] }), { provider: provider().provider });
    await run(world({ told: [{ detail: { idempotencyKey: "pay-invoice-1" } }] }), { provider: provider().provider });
    await run(world(), { provider: provider({ status: "confirmed", providerState: "COMPLETE" }).provider });
    await run(world(), { provider: provider({ status: "failed", providerState: "FAILED" }).provider });
    expect(appended()).toEqual([]);
  });

  it("looks a told attempt up by its key among payment_stuck entries", async () => {
    const fake = world({ told: [{ detail: { idempotencyKey: "pay-invoice-1" } }] });
    await run(fake, { provider: provider().provider });
    const lookup = fake.requests.find((request) => request.path === "/rest/v1/ledger_entries")!;
    expect(lookup.params.get("action")).toBe("eq.payment_stuck");
    expect(lookup.params.get("detail->>idempotencyKey")).toBe("in.(pay-invoice-1)");
  });

  it("tells a retried payment's new attempt, though its first was told (Review Focus 1)", async () => {
    const fake = world({ intents: [intent({ idempotency_key: "pay-invoice-1-attempt-2", transfer_attempt: 2 })], told: [] });
    await run(fake, { provider: provider().provider });
    expect(appended().map((entry) => [entry.detail.idempotencyKey, entry.detail.attempt])).toEqual([["pay-invoice-1-attempt-2", 2]]);
  });

  it("tells a send Circle never answered, without asking Circle (D4)", async () => {
    const circle = provider();
    await run(world({ intents: [intent({ status: "submitting", provider_tx_id: null, tx_hash: null, provider_state: null })] }), { provider: circle.provider });
    expect(circle.reconcileTransfer).not.toHaveBeenCalled();
    expect(appended()[0].detail).toMatchObject({ circleAsked: false, sendAnswered: false, providerState: null, txHash: null });
  });

  it("tells from the age alone where no provider can be had, or Circle does not answer (D4, Review Focus 2, 3)", async () => {
    await run(world(), { provider: () => { throw new Error(MAINNET_NOT_CONNECTED); } });
    await run(world(), { provider: provider(new Error("no answer from Circle getTransaction within 10000 ms")).provider });
    expect(appended().map((entry) => entry.detail.circleAsked)).toEqual([false, false]);
    expect(appended().map((entry) => entry.detail.providerState)).toEqual([null, null]);
  });

  it("signs a milestone's payment under the contractor's domain", async () => {
    await run(world({ intents: [intent({ source_type: "milestone", source_id: MILESTONE, idempotency_key: "pay-milestone-1" })] }), { provider: provider().provider });
    expect(appended()[0]).toMatchObject({ domain: "contractor", action: "payment_stuck", detail: { milestoneId: MILESTONE, counterpartyId: VENDOR } });
    expect(appended()[0].detail).not.toHaveProperty("invoiceId");
  });

  it("names Arc mainnet for a payment made there, by its own network's wait", async () => {
    await run(world({ intents: [intent({ network: "arc-mainnet" })], orgs: [{ id: A, slug: "acme", network: "arc-mainnet" }] }), { provider: provider().provider });
    expect(appended()[0].summary).toBe("Payment of 12.5 USDC to Jiren not confirmed 20 min after it was sent on Arc mainnet");
    expect(appended()[0].detail.network).toBe("arc-mainnet");
  });

  it("tells each payment of a batch on its own (Review Focus 4)", async () => {
    const batch = [intent({ idempotency_key: "batch-1-a" }), intent({ idempotency_key: "batch-1-b", source_type: "milestone", source_id: MILESTONE })];
    expect(await run(world({ intents: batch }), { provider: provider().provider })).toEqual([{ slug: "acme", inFlight: 2, told: 2 }]);
  });

  it("keeps one workspace's failure its own", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = world({
      intents: [intent({ org_id: A }), intent({ org_id: B, idempotency_key: "pay-b-1" })],
      orgs: [{ id: A, slug: "acme" }, { id: B, slug: "beta" }],
      failNamesFor: A,
    });
    const results = await run(fake, { provider: provider().provider });
    expect(results).toEqual([
      { slug: "acme", inFlight: 1, told: 0, error: expect.any(String) },
      { slug: "beta", inFlight: 1, told: 1 },
    ]);
  });
});

describe("the email (stuck-transfer alert D6)", () => {
  const settings = { apiKey: "re_test", from: "Vestiarion <no-reply@vestiarion.xyz>" };

  it("emails each deciding member with email notices on, once for each payment told", async () => {
    const send = vi.fn(async () => ({ sent: true as const, id: "re_1" }));
    const recipients = vi.fn(async () => [{ email: "owner@acme.test" }, { email: "approver@acme.test" }]);
    await run(world(), { provider: provider().provider, mail: { settings, send, recipients } });
    expect(recipients).toHaveBeenCalledWith(A);
    expect(send.mock.calls.map((call) => (call as unknown as [{ to: string; subject: string; text: string }])[0].to)).toEqual(["owner@acme.test", "approver@acme.test"]);
    const message = (send.mock.calls[0] as unknown as [{ subject: string; text: string }])[0];
    expect(message.subject).toBe("A payment of 12.50 USDC to Jiren has not confirmed");
    expect(message.text).toContain(`https://www.vestiarion.xyz/o/acme/invoices#trail-${INVOICE}`);
    expect(message.text).toContain(`https://explorer.testnet.arc.io/tx/${TX}`);
  });

  it("sends none when no one is to be told, or email is not set up, and the entry stands (Review Focus 5)", async () => {
    const send = vi.fn(async () => ({ sent: true as const, id: "re_1" }));
    await run(world(), { provider: provider().provider, mail: { settings, send, recipients: async () => [] } });
    await run(world(), { provider: provider().provider, mail: { settings: null, send, recipients: async () => [{ email: "owner@acme.test" }] } });
    expect(send).not.toHaveBeenCalled();
    expect(appended()).toHaveLength(2);
  });

  it("logs a failed send, and goes on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn(async () => ({ sent: false as const, reason: "resend 500" }));
    const results = await run(world(), { provider: provider().provider, mail: { settings, send, recipients: async () => [{ email: "owner@acme.test" }] } });
    expect(results).toEqual([{ slug: "acme", inFlight: 1, told: 1 }]);
    expect(warn).toHaveBeenCalled();
  });
});
