import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { runApStage, type CycleLogLine } from "@/lib/agent/orchestrator";
import { CycleMetricsCollector } from "@/lib/agent/cycle-metrics";
import type { DecideParams } from "@/lib/agent/decide";
import type { BalanceSnapshot, ChainProvider, EarnResult, Stablecoin, SwapCallResult, TransferParams, TransferResult } from "@/lib/circle";
import { FxQuoteError, type EurcQuote } from "@/lib/fx/quote";
import type { SwapOutcome } from "@/lib/fx/swap";
import type { SwapOffer, SwapQuote } from "@/lib/fx/swap-service";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { paymentIntentsBackend } from "./support/payment-intents";

/**
 * The AP stage paying a EURC payable the wallet's EURC is short of (docs/superpowers/specs/2026-10-01-eurc-swap-design.md
 * S1–S7): code sizes a USDC→EURC swap and shows it to the model, the model chooses to fund the payment with it
 * (`fundWithSwap`), code bounds it, and the swap runs before the EURC transfer. The model is the real schema behind
 * a stubbed reply; the quotes and the swap itself are injected.
 */

const { decideMock } = vi.hoisted(() => ({ decideMock: vi.fn() }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/decide")>()),
  decide: decideMock,
}));

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000e5a0";
const INVOICE_ID = "018f8ce0-1557-7b54-a931-4d777f6bf001";
const SECOND_ID = "018f8ce0-1557-7b54-a931-4d777f6bf002";
const USDC_ID = "018f8ce0-1557-7b54-a931-4d777f6bf003";
const VENDOR = "018f8ce0-1557-7b54-a931-4d777f6bf004";
const ACCOUNT_ID = "018f8ce0-1557-7b54-a931-4d777f6bf005";
const WALLET = "0x97F85033bBD83870a841cF7153F35b387746B6b6";

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

/** 2 EURC is worth 2.432162 USDC at the testnet rate (captured 2026-10-01: 1 EURC → 1.216081 USDC). */
const RATE = 1.216081;
const QUOTE = (amount: number): EurcQuote => ({
  usdcEstimated: Number((amount * RATE).toFixed(6)), usdcMinimum: Number((amount * RATE * 0.97).toFixed(6)), rate: RATE, source: "circle-stablecoin-quote", quotedAt: "2026-10-01T09:00:00.000Z",
});
/** A USDC→EURC quote at the captured pool price: 1 USDC → 0.8228 EURC, at least 0.7981. */
const fairSwap = async (usdcIn: number): Promise<SwapQuote> => ({ eurcEstimated: Number((usdcIn * 0.8228).toFixed(6)), eurcMinimum: Number((usdcIn * 0.7981).toFixed(6)), provider: "lifi" });

function vendor(overrides: Record<string, unknown> = {}) {
  return {
    id: VENDOR, name: "Atelier Lumière", risk_level: "low", payment_limit: "200", performance_score: null, performance_inputs: null,
    address: "0xparis", address_changed_at: null, address_confirmed_at: null,
    ...overrides,
  };
}

function payable(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID, direction: "payable", status: "pending", amount: "2", currency: "EURC", memo: "Linen samples", po_reference: "PO-7701",
    goods_received: true, due_date: "2026-10-01T12:00:00+00:00", counterparty_id: VENDOR,
    agent_reasoning: null, tx_ref: null, decided_at: null, scheduled_for: null, paid_amount: null,
    early_pay_discount_pct: null, discount_due_date: null, created_at: "2026-10-01T08:00:00Z",
    counterparties: vendor(),
    ...overrides,
  };
}

class Chain implements ChainProvider {
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.003;
  transfers: TransferParams[] = [];
  balanceReads: Stablecoin[] = [];

  constructor(readonly mode: "live" | "simulate", public eurc: number) {}

  async transfer(params: TransferParams): Promise<TransferResult> {
    this.transfers.push(params);
    return {
      providerTxId: `circle-tx-${this.transfers.length}`, txHash: "0xhash", txRef: "0xhash", chain: "ARC-TESTNET", status: "confirmed",
      feeUsd: 0.003, feeSource: "chain_reported", providerMode: this.mode, settledInMs: 4000, providerState: "COMPLETE", failureReason: null,
    };
  }
  async getTokenBalance(accountId: string, token: Stablecoin): Promise<BalanceSnapshot> {
    this.balanceReads.push(token);
    return { accountId, chain: "ARC-TESTNET", token, balance: token === "EURC" ? this.eurc : 1000 };
  }
  async swapForEurc(): Promise<SwapCallResult> { throw new Error("the stage swaps through the injected swaps"); }
  async reconcileTransfer(): Promise<TransferResult> { throw new Error("not used"); }
  async getBalance(): Promise<BalanceSnapshot> { throw new Error("not used"); }
  async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
  async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
}

const swapped = (offer: SwapOffer, eurcReceived = 2.06): SwapOutcome => ({ ok: true, swapId: "swap-1", usdcIn: offer.usdcIn, eurcMinimum: offer.eurcMinimum, eurcReceived, swapTxHash: "0xswap" });

function apFake(options: {
  book: Array<Record<string, unknown>>;
  eurc?: number;
  paused?: boolean;
  mode?: "live" | "simulate";
  quoteSwap?: (usdcIn: number) => Promise<SwapQuote>;
  run?: (input: { offer: SwapOffer; short: number }) => Promise<SwapOutcome>;
  resume?: (invoiceId: string) => Promise<SwapOutcome | null>;
  operatingBalance?: number;
}) {
  const intents = paymentIntentsBackend(ORG);
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") {
      return {
        body: {
          id: ORG, slug: "lumiere", name: "Lumière", mode: "live",
          ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
          circle_api_key_enc: null, circle_entity_secret_enc: null,
        },
      };
    }
    if (request.path === "/rest/v1/rpc/append_ledger_entry") return { body: LEDGER_ROW };
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: options.paused ?? false };
    if (request.path === "/rest/v1/invoices" && request.method === "GET") {
      const statuses = request.params.get("status")?.match(/^in\.\((.*)\)$/)?.[1].split(",");
      return { body: statuses ? options.book.filter((row) => statuses.includes(row.status as string)) : options.book };
    }
    if (request.path === "/rest/v1/invoices" && request.method === "PATCH") return { body: [] };
    if (request.path === "/rest/v1/milestones") return { body: [] };
    if (request.path === "/rest/v1/accounts" && request.method === "GET") {
      return { body: { id: ACCOUNT_ID, chain: "ARC-TESTNET", token: "USDC", balance: "1000", apy: "0" } };
    }
    if (request.path === "/rest/v1/accounts" && request.method === "PATCH") return { body: [] };
    return intents.respond(request);
  });
  const chain = new Chain(options.mode ?? "live", options.eurc ?? 0);
  const quoteSwap = vi.fn(options.quoteSwap ?? fairSwap);
  const run = vi.fn(async (input: { invoiceId: string; counterpartyName: string; offer: SwapOffer; short: number; reasoning: string }) =>
    options.run ? options.run(input) : swapped(input.offer)
  );
  const resume = vi.fn(async (input: { invoiceId: string; counterpartyName: string }) => (options.resume ? options.resume(input.invoiceId) : null));
  const lines: CycleLogLine[] = [];
  const stage = () =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () =>
        runApStage({
          db: db(), provider: chain, operating: { id: ACCOUNT_ID }, operatingAddress: WALLET, operatingBalance: options.operatingBalance ?? 1000,
          reserveApy: 0.045, reserveBalance: 0, metrics: new CycleMetricsCollector(), lines,
          quoteEurc: async (amount) => QUOTE(amount), quoteSwap, swaps: { run, resume },
        })
      )
    );
  return { fake, chain, lines, stage, quoteSwap, run, resume };
}

/** The model answers `action`, choosing the swap or not; the reference is the written policy's own answer. */
function model(action: "pay" | "hold" | "schedule", extra: { fundWithSwap?: boolean; payOn?: string } = {}) {
  decideMock.mockImplementation(async (params: DecideParams<unknown>) => {
    const reference = params.fallback() as { action: string };
    const value = params.schema.parse({ action, ...extra, reasoning: `The model says ${action}.`, confidence: 0.9 }) as { action: string };
    return { value, mode: "anthropic", reference, agreedWithReference: value.action === reference.action };
  });
}

/** No model: the written policy decides. */
function policyOnly() {
  decideMock.mockImplementation(async (params: DecideParams<unknown>) => {
    const reference = params.fallback();
    return { value: reference, mode: "heuristic", reference, agreedWithReference: null };
  });
}

const promptAt = (i: number) => JSON.parse((decideMock.mock.calls[i][0] as DecideParams<unknown>).userPrompt) as Record<string, Record<string, unknown>>;
const systemPromptOf = () => (decideMock.mock.calls[0][0] as DecideParams<unknown>).systemPrompt;
const entries = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.path === "/rest/v1/rpc/append_ledger_entry").map((r) => r.body as { p_summary: string; p_detail: Record<string, unknown> });
const patches = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.path === "/rest/v1/invoices" && r.method === "PATCH").map((r) => r.body as Record<string, unknown>);

describe("a EURC payable the wallet is short of, with a swap to fund it", () => {
  it("is shown the swap, and paid in EURC after it when the model chooses it", async () => {
    model("pay", { fundWithSwap: true });
    const { fake, chain, stage, quoteSwap, run } = apFake({ book: [payable()] });

    await stage();

    // 2 EURC short, at 1.216081 over the 3% floor: 2.507384 USDC.
    expect(quoteSwap).toHaveBeenCalledWith(2.507384);
    const prompt = promptAt(0);
    expect(prompt.treasury).toEqual({ eurcBalance: 0, usdcBalance: 1000, usdcDueWithin7Days: 0, reserveBalance: 0 });
    // 2.507384 USDC for 2.063076 EURC is 1.215362 a EURC, 0.06% below the 1.216081 it was weighed at.
    expect(prompt.swap).toEqual({ usdcIn: 2.507384, eurcEstimated: 2.063076, eurcMinimum: 2.001143, usdcPerEurc: RATE, costPercent: -0.06, provider: "lifi" });
    expect(prompt.swapUnavailable).toBeUndefined();
    expect((prompt as unknown as { responseShape: Record<string, string> }).responseShape.fundWithSwap).toContain("swap");
    expect(systemPromptOf()).toContain("fundWithSwap");
    // The plan counts the EURC the swap would bring, so the payable is not a shortfall.
    expect((prompt.timing as { shortfall: boolean }).shortfall).toBe(false);

    expect(run).toHaveBeenCalledWith({ invoiceId: INVOICE_ID, counterpartyName: "Atelier Lumière", offer: expect.objectContaining({ usdcIn: 2.507384 }), short: 2, reasoning: "The model says pay." });
    expect(chain.transfers).toEqual([expect.objectContaining({ token: "EURC", amount: 2, toAddress: "0xparis" })]);
    expect(patches(fake.requests)[0]).toMatchObject({ status: "paid", paid_amount: 2 });
    const [entry] = entries(fake.requests);
    expect(entry.p_summary).toBe("PAY invoice from Atelier Lumière for 2 EURC");
    expect(entry.p_detail).toMatchObject({
      guardrailRule: null,
      decision: expect.objectContaining({ fundWithSwap: true }),
      swapOffer: expect.objectContaining({ usdcIn: 2.507384 }),
      swap: { swapId: "swap-1", state: "confirmed", usdcIn: 2.507384, eurcReceived: 2.06, swapTxHash: "0xswap", reason: null },
    });
  });

  it("is paid with the swap by the written policy too", async () => {
    policyOnly();
    const { chain, stage, run } = apFake({ book: [payable()] });
    await stage();
    expect(run).toHaveBeenCalledTimes(1);
    expect(chain.transfers).toHaveLength(1);
  });

  it("is held, as before, when the model pays without choosing the swap", async () => {
    model("pay");
    const { fake, chain, stage, run } = apFake({ book: [payable()] });
    await stage();
    expect(run).not.toHaveBeenCalled();
    expect(chain.transfers).toEqual([]);
    expect(entries(fake.requests)[0].p_detail).toMatchObject({ guardrailRule: "treasury.insufficient_eurc", swap: null });
  });

  it("is held when the swap costs more than 3% above the rate it was weighed at, whatever the model says", async () => {
    model("pay", { fundWithSwap: true });
    const dear = async (usdcIn: number): Promise<SwapQuote> => ({ eurcEstimated: Number((usdcIn * 0.79).toFixed(6)), eurcMinimum: Number((usdcIn * 0.8).toFixed(6)), provider: "lifi" });
    const { fake, chain, stage, run } = apFake({ book: [payable()], quoteSwap: dear });
    await stage();
    expect(run).not.toHaveBeenCalled();
    expect(chain.transfers).toEqual([]);
    const [entry] = entries(fake.requests);
    expect(entry.p_detail).toMatchObject({ guardrailRule: "fx.swap_cost_above_cap" });
    expect((entry.p_detail.referenceDecision as { action: string }).action).toBe("hold");
  });

  it("is held when the swap would leave the USDC short of what falls due in USDC within 7 days", async () => {
    model("pay", { fundWithSwap: true });
    const usdcBill = payable({ id: USDC_ID, currency: "USDC", amount: "998", po_reference: "PO-1", due_date: "2026-10-05T12:00:00+00:00", status: "scheduled", scheduled_for: "2026-10-05T00:00:00.000Z" });
    const { fake, stage, run } = apFake({ book: [usdcBill, payable()] });
    await stage();
    const eurcPrompt = decideMock.mock.calls.map((call) => JSON.parse((call[0] as DecideParams<unknown>).userPrompt)).find((p) => p.invoice.currency === "EURC");
    expect(eurcPrompt.treasury).toMatchObject({ usdcBalance: 1000, usdcDueWithin7Days: 998 });
    expect(run).not.toHaveBeenCalled();
    expect(entries(fake.requests).find((e) => e.p_summary.includes("EURC"))!.p_detail).toMatchObject({ guardrailRule: "fx.swap_usdc_short" });
  });

  it("is held, with the swap's failure, when the swap does not go through", async () => {
    model("pay", { fundWithSwap: true });
    const { fake, chain, stage } = apFake({ book: [payable()], run: async () => ({ ok: false, pending: false, swapId: "swap-1", reason: "Circle did not complete the swap (FAILED)." }) });
    await stage();
    expect(chain.transfers).toEqual([]);
    const [patch] = patches(fake.requests);
    expect(patch).toMatchObject({ status: "held" });
    expect(String(patch.agent_reasoning)).toContain("Circle did not complete the swap (FAILED).");
    expect(entries(fake.requests)[0].p_detail).toMatchObject({ swap: { swapId: "swap-1", state: "failed", reason: "Circle did not complete the swap (FAILED)." } });
  });

  it("is held while its swap is in flight at Circle", async () => {
    model("pay", { fundWithSwap: true });
    const { fake, chain, stage } = apFake({ book: [payable()], run: async () => ({ ok: false, pending: true, swapId: "swap-1", reason: "A swap for this invoice is in flight at Circle." }) });
    await stage();
    expect(chain.transfers).toEqual([]);
    expect(patches(fake.requests)[0]).toMatchObject({ status: "held" });
    expect(entries(fake.requests)[0].p_detail).toMatchObject({ swap: { state: "pending" } });
  });

  it("swaps nothing while the agent is paused", async () => {
    model("pay", { fundWithSwap: true });
    const { chain, stage, run, resume } = apFake({ book: [payable()], paused: true });
    await stage();
    expect(run).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(chain.transfers).toEqual([]);
  });

  it("finishes a swap whose answer was lost before deciding, and so never swaps twice", async () => {
    model("pay", { fundWithSwap: true });
    const box: { chain?: Chain } = {};
    const { chain, stage, run, resume } = apFake({
      book: [payable()],
      resume: async () => {
        // The swap went through: the wallet now holds its EURC.
        box.chain!.eurc = 2.06;
        return { ok: true, swapId: "swap-0", usdcIn: 2.5, eurcMinimum: 2.0, eurcReceived: 2.06, swapTxHash: "0xswap0" };
      },
    });
    box.chain = chain;
    await stage();
    expect(resume).toHaveBeenCalledWith({ invoiceId: INVOICE_ID, counterpartyName: "Atelier Lumière" });
    expect(promptAt(0).treasury).toMatchObject({ eurcBalance: 2.06 });
    expect(promptAt(0).swap).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(chain.transfers).toHaveLength(1);
  });

  it("is told why there is no swap when there is no route, and the written policy holds it", async () => {
    model("pay", { fundWithSwap: true });
    const { fake, chain, stage, run } = apFake({ book: [payable()], quoteSwap: async () => { throw new FxQuoteError("no_route"); } });
    await stage();
    const prompt = promptAt(0);
    expect(prompt.swap).toBeUndefined();
    expect(prompt.swapUnavailable).toBe("No USDC→EURC route on Arc testnet right now.");
    expect(run).not.toHaveBeenCalled();
    expect(chain.transfers).toEqual([]);
    const [entry] = entries(fake.requests);
    expect(entry.p_detail).toMatchObject({ guardrailRule: "treasury.insufficient_eurc", swapUnavailable: "No USDC→EURC route on Arc testnet right now." });
    expect((entry.p_detail.referenceDecision as { action: string; reasoning: string }).action).toBe("hold");
  });

  it("is scheduled for its due date without a swap when it is not due yet", async () => {
    policyOnly();
    const { fake, stage, run } = apFake({ book: [payable({ due_date: "2026-10-04T12:00:00+00:00" })] });
    await stage();
    expect(run).not.toHaveBeenCalled();
    expect(patches(fake.requests)[0]).toMatchObject({ status: "scheduled", scheduled_for: "2026-10-04T00:00:00.000Z" });
  });

  it("carries the swap into the next payable's figures: the EURC it left, the USDC it took", async () => {
    model("pay", { fundWithSwap: true });
    const second = payable({ id: SECOND_ID, amount: "1", po_reference: "PO-7702", created_at: "2026-10-01T08:30:00Z" });
    const { stage, run } = apFake({ book: [payable(), second] });
    await stage();
    const next = promptAt(1);
    // 2.06 received, 2 paid: 0.06 left, so the second is 0.94 short; the first swap took 2.507384 USDC.
    expect(next.treasury).toMatchObject({ eurcBalance: 0.06, usdcBalance: 997.492616 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toMatchObject({ short: 0.94 });
  });

  it("is not swapped for when the wallet's EURC covers it, whatever the model says", async () => {
    model("pay", { fundWithSwap: true });
    const { chain, stage, quoteSwap, run } = apFake({ book: [payable()], eurc: 500 });
    await stage();
    expect(quoteSwap).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(chain.transfers).toHaveLength(1);
  });

  it("is never offered a swap in a sandbox", async () => {
    model("pay", { fundWithSwap: true });
    const { stage, quoteSwap, resume } = apFake({ book: [payable()], mode: "simulate" });
    await stage();
    expect(quoteSwap).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
});
