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
import type { BridgeFee } from "@/lib/circle/cctp";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { paymentIntentsBackend } from "./support/payment-intents";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";
import { homeChain } from "@/lib/payee-chains";

/**
 * The agent's timing of a bill paid to a vendor's bank account through BlindPay (docs/superpowers/specs/
 * 2026-10-16-bank-payouts-design.md B6, B13). On Arc testnet BlindPay takes its test token, USDB, so the bill is timed
 * against the operating wallet's USDB alone, the model is told it, and a hold for want of it is not one the follow-up
 * reopens when USDC comes in. A pay is held for a person under payout.bank_needs_person. On Arc mainnet, where BlindPay
 * takes USDC, nothing changes.
 */

const { decideMock } = vi.hoisted(() => ({ decideMock: vi.fn() }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/decide")>()),
  decide: decideMock,
}));

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000ba01";
const INVOICE_ID = "018f8ce0-1557-7b54-a931-4d777f6bba01";
const PAYEE = "018f8ce0-1557-7b54-a931-4d777f6bba02";
const ACCOUNT_ID = "018f8ce0-1557-7b54-a931-4d777f6bba03";

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
  vi.stubEnv("BLINDPAY_API_KEY", "test-key-not-real");
  vi.stubEnv("BLINDPAY_INSTANCE_ID", "in_TestInstanceAB");
  decideMock.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T09:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

const LEDGER_ROW = {
  seq: 1, id: "e1", ts: "2026-10-16T00:00:00Z", actor: "agent", domain: "ap", action: "x",
  summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
};

function payable(chain = "ARC-TESTNET") {
  return {
    id: INVOICE_ID, direction: "payable", status: "pending", amount: "10", currency: "USDC", memo: "Taller order", po_reference: "PO-1",
    goods_received: true, due_date: "2026-10-16T12:00:00+00:00", counterparty_id: PAYEE,
    agent_reasoning: null, tx_ref: null, decided_at: null, scheduled_for: null, paid_amount: null,
    early_pay_discount_pct: null, discount_due_date: null, created_at: "2026-10-16T08:00:00Z",
    counterparties: {
      id: PAYEE, name: "Taller Norte", risk_level: "low", payment_limit: "1000", performance_score: null, performance_inputs: null,
      address: null, address_changed_at: null, address_confirmed_at: null, chain,
    },
  };
}

class Chain implements ChainProvider {
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.003;
  transfers: TransferParams[] = [];
  constructor(readonly network: typeof ARC_TESTNET | typeof ARC_MAINNET = ARC_TESTNET) {}
  async transfer(params: TransferParams): Promise<TransferResult> {
    this.transfers.push(params);
    throw new Error("a bank payout is never paid by the agent");
  }
  async reconcileTransfer(): Promise<TransferResult> { throw new Error("not used"); }
  async getBalance(): Promise<BalanceSnapshot> { throw new Error("not used"); }
  async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
  async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
}

function apFake(options: { usdb: number | null; usdc?: number; network?: typeof ARC_TESTNET | typeof ARC_MAINNET }) {
  const intents = paymentIntentsBackend(ORG);
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") {
      return {
        body: {
          id: ORG, slug: "pinecrest", name: "Pinecrest", mode: "live",
          ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
          circle_api_key_enc: null, circle_entity_secret_enc: null,
        },
      };
    }
    if (request.path === "/rest/v1/rpc/append_ledger_entry") return { body: LEDGER_ROW };
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: false };
    if (request.path === "/rest/v1/invoices" && request.method === "GET") {
      const statuses = request.params.get("status")?.match(/^in\.\((.*)\)$/)?.[1].split(",");
      const book = [payable(homeChain((options.network ?? ARC_TESTNET).id).id)];
      return { body: statuses ? book.filter((row) => statuses.includes(row.status)) : book };
    }
    if (request.path === "/rest/v1/invoices" && request.method === "PATCH") return { body: [] };
    if (request.path === "/rest/v1/milestones") return { body: [] };
    if (request.path === "/rest/v1/counterparty_bank_accounts") {
      return {
        body: [{ id: "row-1", counterparty_id: PAYEE, external_id: "ba_TestAccount01", bank_code: "012", last4: "9716", beneficiary_name: "Ana Lopez", status: "approved", added_at: "2026-10-16T08:00:00Z" }],
      };
    }
    if (request.path === "/rest/v1/accounts" && request.method === "GET") {
      return { body: { id: ACCOUNT_ID, chain: "ARC-TESTNET", token: "USDC", balance: String(options.usdc ?? 2.61), apy: "0" } };
    }
    if (request.path === "/rest/v1/accounts" && request.method === "PATCH") return { body: [] };
    if (request.path === "/rest/v1/counterparties") return { body: [{ risk_level: "low", address_changed_at: null, address_confirmed_at: null }] };
    const ids = request.params.get("source_id")?.match(/^in\.\((.*)\)$/)?.[1].split(",");
    if (request.path === "/rest/v1/payment_intents" && request.method === "GET" && ids) return { body: [] };
    return intents.respond(request);
  });
  const chain = new Chain(options.network ?? ARC_TESTNET);
  const testTokenBalance = vi.fn(async () => options.usdb);
  const lines: CycleLogLine[] = [];
  const stage = () =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () =>
        runApStage({
          db: db(), provider: chain, operating: { id: ACCOUNT_ID }, operatingAddress: "0x31d41849d0a8dd8dc7c52c00c61fa65b890bb2bf",
          operatingBalance: options.usdc ?? 2.61, reserveApy: 0.04, reserveBalance: 0.19,
          metrics: new CycleMetricsCollector(), lines, testTokenBalance,
          bridgeFee: async (): Promise<BridgeFee> => ({ feeUsdc: 0, maxFeeUnits: BigInt(0), domain: 26 }),
          gatewayQuote: async () => null,
        })
      )
    );
  return { fake, chain, stage, testTokenBalance };
}

function model(action: "pay" | "hold") {
  decideMock.mockImplementation(async (params: DecideParams<unknown>) => {
    const reference = params.fallback() as { action: string };
    const value = params.schema.parse({ action, reasoning: `The model says ${action}.`, confidence: 0.9 }) as { action: string };
    return { value, mode: "anthropic", reference, agreedWithReference: value.action === reference.action };
  });
}

const promptOf = () => JSON.parse((decideMock.mock.calls[0][0] as DecideParams<unknown>).userPrompt) as Record<string, Record<string, unknown>>;
const decisions = (requests: RecordedRequest[]) =>
  requests
    .filter((r) => r.path === "/rest/v1/rpc/append_ledger_entry")
    .map((r) => r.body as { p_action: string; p_detail: Record<string, unknown> })
    .filter((entry) => entry.p_action.startsWith("ap_"));

describe("a bill paid to a bank account on Arc testnet (B13)", () => {
  it("is timed against the wallet's USDB, and a pay is held for a person under the bank payout rule", async () => {
    model("pay");
    const { fake, chain, stage, testTokenBalance } = apFake({ usdb: 100, usdc: 2.61 });
    await stage();
    expect(testTokenBalance).toHaveBeenCalledTimes(1);
    const prompt = promptOf();
    expect(prompt.treasury).toEqual({ usdbBalance: 100, usdcBalance: 2.61, reserveBalance: 0 });
    expect(prompt.timing).toMatchObject({ shortfall: false, earlierObligations: { total: 0, count: 0 } });
    expect(prompt.payout).toMatchObject({ route: "bank" });
    expect(chain.transfers).toEqual([]);
    const [decision] = decisions(fake.requests);
    expect(decision.p_detail).toMatchObject({ guardrailBlocked: true, guardrailRule: "payout.bank_needs_person", paidToBank: true });
    expect(decision.p_detail.heldBecause).toBeUndefined();
  });

  it("is held, but not for USDC to come in, when the wallet's USDB falls short", async () => {
    model("hold");
    const { fake, stage } = apFake({ usdb: 5, usdc: 500 });
    await stage();
    expect(promptOf().timing).toMatchObject({ shortfall: true });
    const [decision] = decisions(fake.requests);
    expect(decision.p_action).toBe("ap_hold");
    expect(decision.p_detail.heldBecause).toBeUndefined();
    expect(decision.p_detail.cashNeededUsdc).toBeUndefined();
  });

  it("counts a USDB balance that cannot be read as none", async () => {
    model("hold");
    const { stage } = apFake({ usdb: null, usdc: 500 });
    await stage();
    expect(promptOf().treasury).toEqual({ usdbBalance: null, usdcBalance: 500, reserveBalance: 0 });
    expect(promptOf().timing).toMatchObject({ shortfall: true });
  });
});

describe("a bill paid to a bank account on Arc mainnet (B13)", () => {
  it("is timed against the wallet's USDC as before, BlindPay taking USDC there", async () => {
    model("hold");
    const { stage, testTokenBalance } = apFake({ usdb: 100, usdc: 2.61, network: ARC_MAINNET });
    await stage();
    expect(testTokenBalance).not.toHaveBeenCalled();
    expect(promptOf().treasury).toEqual({ operatingBalance: 2.61, reserveBalance: 0.19 });
    expect(promptOf().timing).toMatchObject({ shortfall: true });
  });
});
