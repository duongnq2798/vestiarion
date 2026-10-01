import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { runApStage, type CycleLogLine } from "@/lib/agent/orchestrator";
import { CycleMetricsCollector } from "@/lib/agent/cycle-metrics";
import type { DecideParams } from "@/lib/agent/decide";
import type { BalanceSnapshot, ChainProvider, EarnResult, Stablecoin, TransferParams, TransferResult } from "@/lib/circle";
import { FxQuoteError, type EurcQuote } from "@/lib/fx/quote";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { paymentIntentsBackend } from "./support/payment-intents";

/**
 * The AP stage deciding a EURC payable (docs/superpowers/specs/2026-10-01-eurc-invoices-design.md
 * E2–E7, plan P1–P3): weighed against the counterparty's USDC limit at a quoted rate the ledger
 * records, paid in EURC from the wallet's EURC, and held with a named rule when there is no quote
 * or not enough EURC. The model is the real schema behind a stubbed reply; the quote is injected.
 */

const { decideMock } = vi.hoisted(() => ({ decideMock: vi.fn() }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/decide")>()),
  decide: decideMock,
}));

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000e0c0";
const INVOICE_ID = "018f8ce0-1557-7b54-a931-4d777f6be001";
const TWIN_ID = "018f8ce0-1557-7b54-a931-4d777f6be002";
const USDC_ID = "018f8ce0-1557-7b54-a931-4d777f6be003";
const VENDOR = "018f8ce0-1557-7b54-a931-4d777f6be004";
const ACCOUNT_ID = "018f8ce0-1557-7b54-a931-4d777f6be005";

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

const QUOTE: EurcQuote = { usdcEstimated: 117, usdcMinimum: 113.49, rate: 1.17, source: "circle-stablecoin-quote", quotedAt: "2026-10-01T09:00:00.000Z" };

function vendor(overrides: Record<string, unknown> = {}) {
  return {
    id: VENDOR, name: "Atelier Lumière", risk_level: "low", payment_limit: "200", performance_score: null, performance_inputs: null,
    address: "0xparis", address_changed_at: null, address_confirmed_at: null,
    ...overrides,
  };
}

function payable(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID, direction: "payable", status: "pending", amount: "100", currency: "EURC", memo: "Linen samples", po_reference: "PO-7701",
    goods_received: true, due_date: "2026-10-03T12:00:00+00:00", counterparty_id: VENDOR,
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

  constructor(readonly mode: "live" | "simulate", private readonly eurc: number | Error) {}

  async transfer(params: TransferParams): Promise<TransferResult> {
    this.transfers.push(params);
    return {
      providerTxId: `circle-tx-${this.transfers.length}`, txHash: "0xhash", txRef: "0xhash", chain: "ARC-TESTNET", status: "confirmed",
      feeUsd: 0.003, feeSource: "chain_reported", providerMode: this.mode, settledInMs: 4000, providerState: "COMPLETE", failureReason: null,
    };
  }
  async getTokenBalance(accountId: string, token: Stablecoin): Promise<BalanceSnapshot> {
    this.balanceReads.push(token);
    if (token === "EURC" && this.eurc instanceof Error) throw this.eurc;
    return { accountId, chain: "ARC-TESTNET", token, balance: token === "EURC" ? (this.eurc as number) : 1000 };
  }
  async reconcileTransfer(): Promise<TransferResult> { throw new Error("not used"); }
  async getBalance(): Promise<BalanceSnapshot> { throw new Error("not used"); }
  async depositToEarn(): Promise<EarnResult> { throw new Error("not used"); }
  async withdrawFromEarn(): Promise<EarnResult> { throw new Error("not used"); }
}

function apFake(options: { book: Array<Record<string, unknown>>; mode?: "live" | "simulate"; eurc?: number | Error; quote?: () => Promise<EurcQuote> }) {
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
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: false };
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
  const chain = new Chain(options.mode ?? "live", options.eurc ?? 500);
  const quoteEurc = vi.fn(options.quote ?? (async () => QUOTE));
  const lines: CycleLogLine[] = [];
  const stage = () =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () =>
        runApStage({
          db: db(), provider: chain, operating: { id: ACCOUNT_ID }, operatingBalance: 1000, reserveApy: 0.045, reserveBalance: 0,
          metrics: new CycleMetricsCollector(), lines, quoteEurc,
        })
      )
    );
  return { fake, chain, lines, stage, quoteEurc, intents };
}

/** The model answers `action`; the reference is the written policy's own answer. */
function model(action: "pay" | "hold" | "schedule", payOn?: string) {
  decideMock.mockImplementation(async (params: DecideParams<unknown>) => {
    const reference = params.fallback() as { action: string };
    const value = params.schema.parse({ action, payOn, reasoning: `The model says ${action}.`, confidence: 0.9 }) as { action: string };
    return { value, mode: "anthropic", reference, agreedWithReference: value.action === reference.action };
  });
}

const promptOf = () => JSON.parse((decideMock.mock.calls[0][0] as DecideParams<unknown>).userPrompt) as Record<string, Record<string, unknown>>;
const systemPromptOf = () => (decideMock.mock.calls[0][0] as DecideParams<unknown>).systemPrompt;
const entries = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.path === "/rest/v1/rpc/append_ledger_entry").map((r) => r.body as { p_summary: string; p_detail: Record<string, unknown> });
const patches = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.path === "/rest/v1/invoices" && r.method === "PATCH").map((r) => r.body as Record<string, unknown>);

describe("a EURC payable inside its limit at the quoted rate", () => {
  it("is paid in EURC, and the decision records the rate it was weighed at", async () => {
    model("pay");
    const { fake, chain, lines, stage, quoteEurc } = apFake({ book: [payable()] });

    await stage();

    expect(quoteEurc).toHaveBeenCalledWith(100);
    const prompt = promptOf();
    expect(prompt.invoice).toMatchObject({ amount: 100, currency: "EURC", usdcValue: 117 });
    expect(prompt.treasury).toMatchObject({ eurcBalance: 500 });
    expect(systemPromptOf()).toContain("USDC value");

    expect(chain.transfers).toHaveLength(1);
    expect(chain.transfers[0]).toMatchObject({ token: "EURC", amount: 100, toAddress: "0xparis" });
    expect(patches(fake.requests)[0]).toMatchObject({ status: "paid", paid_amount: 100 });

    const [entry] = entries(fake.requests);
    expect(entry.p_summary).toBe("PAY invoice from Atelier Lumière for 100 EURC");
    expect(entry.p_detail).toMatchObject({
      currency: "EURC",
      usdcValue: 117,
      fx: { rate: 1.17, source: "circle-stablecoin-quote", quotedAt: "2026-10-01T09:00:00.000Z" },
      guardrailRule: null,
    });
    expect(lines[0].message).toContain("100 EURC");
  });

  it("is weighed with EURC money only: the reserve, and USDC payables due first, do not count (P1)", async () => {
    model("pay");
    const usdcFirst = { ...payable({ id: USDC_ID, currency: "USDC", amount: "900", po_reference: "PO-1", due_date: "2026-10-02T12:00:00+00:00" }) };
    const { stage } = apFake({ book: [usdcFirst, payable()] });

    await stage();

    const eurcCall = decideMock.mock.calls.map((call) => JSON.parse((call[0] as DecideParams<unknown>).userPrompt)).find((p) => p.invoice.currency === "EURC");
    expect(eurcCall.timing.earlierObligations).toEqual({ total: 0, count: 0 });
    expect(eurcCall.treasury).toMatchObject({ eurcBalance: 500, reserveBalance: 0 });
  });

  it("is shown a USDC bill under the same PO as a re-bill to confirm, which does not block it (review I1)", async () => {
    model("pay");
    const usdcTwin = payable({ id: TWIN_ID, currency: "USDC", status: "paid", tx_ref: "0xold" });
    const { fake, chain, stage } = apFake({ book: [usdcTwin, payable()] });

    await stage();

    const prompt = promptOf();
    expect(prompt.duplicateMatches).toEqual([expect.objectContaining({ signals: ["purchase_order_rebilled"], otherInvoiceAmount: 100 })]);
    expect(chain.transfers).toHaveLength(1);
    expect(patches(fake.requests)[0]).toMatchObject({ status: "paid" });
  });

  it("is refused when it repeats a EURC bill already paid in EURC", async () => {
    model("pay");
    const eurcTwin = payable({ id: TWIN_ID, status: "paid", tx_ref: "0xold" });
    const { fake, chain, stage } = apFake({ book: [eurcTwin, payable()] });

    await stage();

    expect(chain.transfers).toEqual([]);
    expect(patches(fake.requests)[0]).toMatchObject({ status: "flagged" });
    expect(entries(fake.requests)[0].p_detail).toMatchObject({ guardrailRule: "invoice.duplicate_of_settled" });
  });
});

describe("a EURC payable the guardrails stop (P3)", () => {
  it("is held at the payment limit when its USDC value is over it, though its face value is not", async () => {
    model("pay");
    const { fake, chain, stage } = apFake({ book: [payable({ counterparties: vendor({ payment_limit: "110" }) })] });

    await stage();

    expect(chain.transfers).toEqual([]);
    expect(patches(fake.requests)[0]).toMatchObject({ status: "held" });
    const [entry] = entries(fake.requests);
    expect(entry.p_detail).toMatchObject({ guardrailBlocked: true, guardrailRule: "counterparty.payment_limit", usdcValue: 117 });
    // The written policy reaches the same answer from the same figures.
    expect((entry.p_detail.referenceDecision as { action: string }).action).toBe("hold");
  });

  it("is held for a person when no quote can be had, whatever the model says (E4)", async () => {
    model("pay");
    const { fake, chain, stage } = apFake({ book: [payable()], quote: async () => { throw new FxQuoteError("no_route"); } });

    await stage();

    expect(promptOf().invoice).toMatchObject({ currency: "EURC", usdcValue: null });
    expect(chain.transfers).toEqual([]);
    const [patch] = patches(fake.requests);
    expect(patch).toMatchObject({ status: "held" });
    expect(String(patch.agent_reasoning)).toContain("no EURC→USDC rate");
    const [entry] = entries(fake.requests);
    expect(entry.p_detail).toMatchObject({ guardrailRule: "fx.rate_unavailable", fx: null, usdcValue: null });
    expect((entry.p_detail.referenceDecision as { action: string }).action).toBe("hold");
  });

  it("is held when the wallet's EURC cannot cover it, and never paid with USDC instead (E5)", async () => {
    model("pay");
    const { fake, chain, stage } = apFake({ book: [payable()], eurc: 40 });

    await stage();

    expect(chain.transfers).toEqual([]);
    const [patch] = patches(fake.requests);
    expect(patch).toMatchObject({ status: "held" });
    expect(String(patch.agent_reasoning)).toContain("40 EURC");
    expect(entries(fake.requests)[0].p_detail).toMatchObject({ guardrailRule: "treasury.insufficient_eurc" });
  });
});

describe("a EURC payable in a sandbox (E7)", () => {
  it("has no EURC balance to check, and is paid like any simulated payment", async () => {
    model("pay");
    const { fake, chain, stage } = apFake({ book: [payable()], mode: "simulate", eurc: 0 });

    await stage();

    expect(chain.balanceReads).toEqual([]);
    expect(promptOf().treasury).toMatchObject({ eurcBalance: null });
    expect(chain.transfers[0]).toMatchObject({ token: "EURC" });
    expect(patches(fake.requests)[0]).toMatchObject({ status: "paid" });
  });
});

describe("a USDC payable", () => {
  it("asks for no quote and reads no EURC", async () => {
    model("pay");
    const { chain, stage, quoteEurc } = apFake({ book: [payable({ currency: "USDC" })] });

    await stage();

    expect(quoteEurc).not.toHaveBeenCalled();
    expect(chain.balanceReads).toEqual([]);
    expect(promptOf().invoice).toMatchObject({ amount: 100, currency: "USDC", usdcValue: 100 });
    expect(chain.transfers[0]).toMatchObject({ token: "USDC" });
  });
});

describe("the review's fixes (M1, M4, M5)", () => {
  it("holds a EURC payable whose wallet balance could not be read, and still decides the USDC payable after it", async () => {
    model("pay");
    const usdc = payable({ id: USDC_ID, currency: "USDC", po_reference: "PO-1", created_at: "2026-10-01T08:30:00Z" });
    const { fake, chain, stage } = apFake({ book: [payable(), usdc], eurc: new Error("Circle did not answer within 15 s") });

    await stage();

    const [eurcPatch, usdcPatch] = patches(fake.requests);
    expect(eurcPatch).toMatchObject({ status: "held" });
    expect(String(eurcPatch.agent_reasoning)).toContain("could not be read");
    expect(entries(fake.requests)[0].p_detail).toMatchObject({ guardrailRule: "treasury.insufficient_eurc" });
    expect(usdcPatch).toMatchObject({ status: "paid" });
    expect(chain.transfers.map((transfer) => transfer.token)).toEqual(["USDC"]);
  });

  it("tells the model what a null EURC balance means", () => {
    // Read from the prompt the stage sends; any decision will do.
    return (async () => {
      model("pay");
      const { stage } = apFake({ book: [payable()], mode: "simulate" });
      await stage();
      expect(systemPromptOf()).toContain("eurcBalance is null");
    })();
  });

  it("does not write a null limit into the policy's reasoning", async () => {
    model("hold");
    const { fake, stage } = apFake({
      book: [payable({ counterparties: vendor({ payment_limit: null }) })],
      quote: async () => {
        throw new FxQuoteError("unavailable");
      },
    });

    await stage();

    const reference = entries(fake.requests)[0].p_detail.referenceDecision as { reasoning: string };
    expect(reference.reasoning).not.toContain("null");
    expect(reference.reasoning).toContain("No EURC→USDC rate");
  });
});
