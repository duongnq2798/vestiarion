import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { runApStage, type CycleLogLine } from "@/lib/agent/orchestrator";
import { CycleMetricsCollector } from "@/lib/agent/cycle-metrics";
import type { DecideParams } from "@/lib/agent/decide";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferParams, TransferResult } from "@/lib/circle";
import { BridgeFeeError, type BridgeFee } from "@/lib/circle/cctp";
import { paymentIdempotencyKey } from "@/lib/payments";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { paymentIntentsBackend } from "./support/payment-intents";

/**
 * The AP stage paying a payee on another chain (docs/superpowers/specs/2026-10-01-cctp-payouts-design.md
 * X2–X8): the agent is told the route and its fee; code holds a payout whose fee is above 10% of the
 * amount, one with no fee answer, and a EURC one; the fee counts against the money available; and a
 * bridged payment is in flight until its mint.
 */

const { decideMock } = vi.hoisted(() => ({ decideMock: vi.fn() }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/decide")>()),
  decide: decideMock,
}));

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000cc7b";
const INVOICE_ID = "018f8ce0-1557-7b54-a931-4d777f6bc701";
const PAYEE = "018f8ce0-1557-7b54-a931-4d777f6bc702";
const ACCOUNT_ID = "018f8ce0-1557-7b54-a931-4d777f6bc703";
const ADDRESS = "0x19801dAA2F1E5E5e707b7E57Ff664f3d27fFdd12";

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
  decideMock.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T09:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

const LEDGER_ROW = {
  seq: 1, id: "e1", ts: "2026-10-01T00:00:00Z", actor: "agent", domain: "ap", action: "x",
  summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
};

const BASE_FEE: BridgeFee = { feeUsdc: 0.054613, maxFeeUnits: BigInt(54613), domain: 6 };

function payee(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYEE, name: "Northwind on Base", risk_level: "low", payment_limit: "10", performance_score: null, performance_inputs: null,
    address: ADDRESS, address_changed_at: null, address_confirmed_at: null, chain: "BASE-SEPOLIA",
    ...overrides,
  };
}

function payable(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID, direction: "payable", status: "pending", amount: "1.5", currency: "USDC", memo: "Design review", po_reference: "PO-9001",
    goods_received: true, due_date: "2026-10-01T12:00:00+00:00", counterparty_id: PAYEE,
    agent_reasoning: null, tx_ref: null, decided_at: null, scheduled_for: null, paid_amount: null,
    early_pay_discount_pct: null, discount_due_date: null, created_at: "2026-10-01T08:00:00Z",
    counterparties: payee(),
    ...overrides,
  };
}

class Chain implements ChainProvider {
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.003;
  transfers: TransferParams[] = [];
  reconciled: string[] = [];
  constructor(private readonly minted: string | null = null) {}

  async transfer(params: TransferParams): Promise<TransferResult> {
    this.transfers.push(params);
    const bridged = params.destinationChain && params.destinationChain !== "ARC-TESTNET";
    return {
      providerTxId: bridged ? "cctp:burn-1" : "circle-tx-1", txHash: "0xburn", txRef: "0xburn", chain: "ARC-TESTNET",
      status: bridged && !this.minted ? "pending" : "confirmed",
      feeUsd: 0.003, feeSource: "chain_reported", providerMode: "live", settledInMs: 4000, providerState: "COMPLETE", failureReason: null,
      ...(bridged ? { destinationChain: params.destinationChain, bridgeFeeUsdc: 0.054613, mintTxHash: this.minted } : {}),
    };
  }
  async reconcileTransfer(providerTxId: string): Promise<TransferResult> {
    this.reconciled.push(providerTxId);
    return {
      providerTxId, txHash: "0xburn", txRef: "0xburn", chain: "ARC-TESTNET", status: this.minted ? "confirmed" : "pending",
      feeUsd: 0.003, feeSource: "chain_reported", providerMode: "live", settledInMs: 4000, providerState: "COMPLETE", failureReason: null,
      mintTxHash: this.minted,
    };
  }
  async getBalance(): Promise<BalanceSnapshot> { throw new Error("not used"); }
  async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
  async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
}

function apFake(options: { book: Array<Record<string, unknown>>; fee?: () => Promise<BridgeFee>; operatingBalance?: number; minted?: string | null; intent?: Record<string, unknown> }) {
  const intents = paymentIntentsBackend(ORG);
  if (options.intent) Object.assign(intents.insert({
    source_type: "invoice", source_id: INVOICE_ID, idempotency_key: paymentIdempotencyKey("invoice", INVOICE_ID),
    provider: "circle", provider_mode: "live", amount: 1.5, destination: ADDRESS,
  }), options.intent);
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") {
      return {
        body: {
          id: ORG, slug: "northwind", name: "Northwind", mode: "live",
          ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
          circle_api_key_enc: null, circle_entity_secret_enc: null,
        },
      };
    }
    if (request.path === "/rest/v1/rpc/append_ledger_entry") return { body: LEDGER_ROW };
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: false };
    if (request.path === "/rest/v1/invoices" && request.method === "GET") {
      const statuses = request.params.get("status")?.match(/^in\.\((.*)\)$/)?.[1].split(",");
      return { body: statuses ? options.book.filter((row) => statuses.includes(row.status as string)) : options.book };
    }
    if (request.path === "/rest/v1/invoices" && request.method === "PATCH") return { body: [] };
    if (request.path === "/rest/v1/milestones") return { body: [] };
    if (request.path === "/rest/v1/accounts" && request.method === "GET") {
      return { body: { id: ACCOUNT_ID, chain: "ARC-TESTNET", token: "USDC", balance: String(options.operatingBalance ?? 100), apy: "0" } };
    }
    if (request.path === "/rest/v1/accounts" && request.method === "PATCH") return { body: [] };
    if (request.path === "/rest/v1/counterparties") return { body: [{ risk_level: "low", address_changed_at: null, address_confirmed_at: null }] };
    // The AP stage's read of which payables have a payment in flight.
    const ids = request.params.get("source_id")?.match(/^in\.\((.*)\)$/)?.[1].split(",");
    if (request.path === "/rest/v1/payment_intents" && request.method === "GET" && ids) {
      return { body: intents.rows.filter((row) => ids.includes(row.source_id as string)) };
    }
    return intents.respond(request);
  });
  const chain = new Chain(options.minted ?? null);
  const bridgeFee = vi.fn(options.fee ?? (async () => BASE_FEE));
  const lines: CycleLogLine[] = [];
  const stage = () =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () =>
        runApStage({
          db: db(), provider: chain, operating: { id: ACCOUNT_ID }, operatingBalance: options.operatingBalance ?? 100, reserveApy: 0, reserveBalance: 0,
          metrics: new CycleMetricsCollector(), lines, bridgeFee, quoteEurc: async () => ({ usdcEstimated: 1.8, usdcMinimum: 1.7, rate: 1.2, source: "circle-stablecoin-quote", quotedAt: "2026-10-01T09:00:00Z" }),
        })
      )
    );
  return { fake, chain, lines, stage, bridgeFee };
}

function model(action: "pay" | "hold") {
  decideMock.mockImplementation(async (params: DecideParams<unknown>) => {
    const reference = params.fallback() as { action: string };
    const value = params.schema.parse({ action, reasoning: `The model says ${action}.`, confidence: 0.9 }) as { action: string };
    return { value, mode: "anthropic", reference, agreedWithReference: value.action === reference.action };
  });
}

const promptOf = () => JSON.parse((decideMock.mock.calls[0][0] as DecideParams<unknown>).userPrompt) as Record<string, Record<string, unknown>>;
const entries = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.path === "/rest/v1/rpc/append_ledger_entry").map((r) => r.body as { p_action: string; p_summary: string; p_detail: Record<string, unknown> });
const patches = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.path === "/rest/v1/invoices" && r.method === "PATCH").map((r) => r.body as Record<string, unknown>);

describe("a payee on Base Sepolia", () => {
  it("is paid through the bridge, with the route and its fee before the model and in the ledger, and is in flight until the mint", async () => {
    model("pay");
    const { fake, chain, stage, bridgeFee } = apFake({ book: [payable()] });

    await stage();

    expect(bridgeFee).toHaveBeenCalledWith("BASE-SEPOLIA", 1.5);
    expect(promptOf().payout).toEqual({ chain: "Base Sepolia", route: "cctp", feeUsdc: 0.054613, feePercent: 3.64, expectedSeconds: 30 });
    expect(chain.transfers[0]).toMatchObject({ destinationChain: "BASE-SEPOLIA", amount: 1.5, toAddress: ADDRESS });
    expect(patches(fake.requests)[0]).toMatchObject({ status: "matched", tx_ref: "0xburn" });
    expect(entries(fake.requests)[0].p_detail).toMatchObject({
      payout: { chain: "BASE-SEPOLIA", route: "cctp", domain: 6, feeUsdc: 0.054613 },
      guardrailRule: null,
    });
  });

  it("counts the fee against the money there is to pay with (X7)", async () => {
    model("pay");
    const { stage } = apFake({ book: [payable()], operatingBalance: 1.52 });
    await stage();
    expect((promptOf().timing as { shortfall: boolean }).shortfall).toBe(true);
  });
});

describe("a payout code holds", () => {
  it("is held when the fee is above 10% of the amount, whatever the model says (X4)", async () => {
    model("pay");
    const { fake, chain, stage } = apFake({
      book: [payable({ counterparties: payee({ chain: "ETH-SEPOLIA" }) })],
      fee: async () => ({ feeUsdc: 1.854162, maxFeeUnits: BigInt(1854162), domain: 0 }),
    });
    await stage();
    expect(chain.transfers).toEqual([]);
    expect(patches(fake.requests)[0]).toMatchObject({ status: "held" });
    expect(entries(fake.requests)[0].p_detail).toMatchObject({ guardrailRule: "bridge.fee_above_cap", guardrailBlocked: true });
    expect((entries(fake.requests)[0].p_detail.referenceDecision as { action: string }).action).toBe("hold");
  });

  it("is held when Iris gives no fee (X5)", async () => {
    model("pay");
    const { fake, chain, stage } = apFake({ book: [payable()], fee: async () => { throw new BridgeFeeError("Iris did not answer"); } });
    await stage();
    expect(chain.transfers).toEqual([]);
    expect(entries(fake.requests)[0].p_detail).toMatchObject({ guardrailRule: "bridge.fee_unavailable" });
  });

  it("is held when the invoice is in EURC: only USDC crosses (X6)", async () => {
    model("pay");
    const { fake, chain, stage, bridgeFee } = apFake({ book: [payable({ currency: "EURC" })] });
    await stage();
    expect(chain.transfers).toEqual([]);
    expect(bridgeFee).not.toHaveBeenCalled();
    expect(entries(fake.requests)[0].p_detail).toMatchObject({ guardrailRule: "bridge.unsupported_token" });
  });
});

describe("a payee on Arc", () => {
  it("is paid directly, as before, with no fee to ask for", async () => {
    model("pay");
    const { chain, stage, bridgeFee } = apFake({ book: [payable({ counterparties: payee({ chain: "ARC-TESTNET" }) })] });
    await stage();
    expect(bridgeFee).not.toHaveBeenCalled();
    expect(promptOf().payout).toEqual({ chain: "Arc testnet", route: "direct" });
    expect(chain.transfers[0].destinationChain ?? "ARC-TESTNET").toBe("ARC-TESTNET");
  });
});

describe("a bridged payment in flight (X8)", () => {
  it("is paid once Iris reports the mint, and the reconcile entry names it", async () => {
    const { fake, chain, stage } = apFake({
      book: [payable({ status: "matched", tx_ref: "0xburn" })],
      minted: "0xmint",
      intent: { provider_tx_id: "cctp:burn-1", tx_hash: "0xburn", status: "pending", destination_chain: "BASE-SEPOLIA" },
    });
    await stage();
    expect(chain.transfers).toEqual([]);
    expect(chain.reconciled).toEqual(["cctp:burn-1"]);
    expect(patches(fake.requests)[0]).toMatchObject({ status: "paid" });
    const [entry] = entries(fake.requests);
    expect(entry.p_action).toBe("ap_reconcile");
    expect(entry.p_detail).toMatchObject({ execution: { mintTxHash: "0xmint", destinationChain: "BASE-SEPOLIA" } });
  });
});
