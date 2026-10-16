import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { enforceApGuardrails } from "@/lib/agent/guardrails";
import { handleBlindpayNotice } from "@/lib/bank-payouts/webhook";
import { bankAccountLine, bankQuoteLine } from "@/lib/bank-payouts/words";
import type { BlindpaySettings } from "@/lib/blindpay/settings";
import { BANK_ID, BankPayoutError, bankPayoutResult, bankStepKey, payToBank, reconcileBankPayout } from "@/lib/circle/bank-payout";
import type { ContractCall } from "@/lib/circle/cctp";
import { MAY_HAVE_BEEN_ACCEPTED, type Settlement } from "@/lib/circle/settlement";
import type { TransferParams } from "@/lib/circle/types";

/**
 * Bank payouts (docs/superpowers/specs/2026-10-16-bank-payouts-design.md): a bill paid to a vendor's bank account in
 * Mexico through BlindPay. The quote that must leave exactly the invoice's amount, the approve of BlindPay's contract and
 * the payout under the attempt's own keys (B7); BlindPay's outcomes read as a transfer's (B8); a person approves every
 * bank payout (B6); the card's words (B12); and BlindPay's notices (B9).
 */

const SETTINGS: BlindpaySettings = {
  apiKey: "test-key-not-real",
  instanceId: "in_TestInstanceAB",
  webhookSecret: null,
  route: () => ({ network: "arc_testnet", token: "USDB" }),
};
const ROUTE = { bankAccountId: "ba_000000000001", network: "arc_testnet", token: "USDB" as const };
const WALLET = { address: "0x3333333333333333333333333333333333333333", chain: "ARC-TESTNET" };
const PARAMS: TransferParams = { fromAccountId: "account-1", toAddress: "blindpay:ba_000000000001", amount: 10, idempotencyKey: "attempt-key-1", memo: "Invoice 1", bank: ROUTE };
const TOKEN = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x2222222222222222222222222222222222222222";

const quote = (overrides: Record<string, unknown> = {}) => ({
  id: "qu_000000000001",
  expires_at: Date.now() + 5 * 60_000,
  blindpay_quotation: 1835,
  sender_amount: 1000,
  receiver_amount: 18140,
  flat_fee: 210,
  billing_fee_amount: 0,
  contract: { address: TOKEN, blindpayContractAddress: SPENDER, amount: "10000000", network: { name: "arc_testnet", chainId: 5042002 } },
  ...overrides,
});
const payout = (status = "processing", id = "po_000000000001") => ({ id, status });

type Answer = { status?: number; body: unknown } | "no answer";

/** BlindPay over a fake fetch: each path's answers in order, and every request as it was sent. */
function blindpay(answers: { quote?: Answer[]; payout?: Answer[]; read?: Answer[] }) {
  const sent: Array<{ url: string; method: string; key: string | null; body: Record<string, unknown> | null }> = [];
  const queue = { quote: [...(answers.quote ?? [])], payout: [...(answers.payout ?? [])], read: [...(answers.read ?? [])] };
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const where = String(url);
    sent.push({ url: where, method: init?.method ?? "GET", key: new Headers(init?.headers).get("idempotency-key"), body: init?.body ? JSON.parse(String(init.body)) : null });
    const list = where.endsWith("/quotes") ? queue.quote : where.endsWith("/payouts/evm") ? queue.payout : queue.read;
    const next = list.shift();
    if (!next) throw new Error(`no fake answer for ${where}`);
    if (next === "no answer") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

/** What a call that must fail threw. */
const failure = (call: Promise<unknown>): Promise<Error> =>
  call.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error as Error
  );

function approver(status: Settlement["status"] = "confirmed") {
  const calls: Array<{ call: ContractCall; key: string }> = [];
  return { calls, approve: async (call: ContractCall, key: string): Promise<Settlement> => (calls.push({ call, key }), { status }) };
}

describe("paying a bill to a bank account (B7)", () => {
  it("quotes the invoice amount, approves BlindPay's contract for it, and pays out under the attempt's own keys", async () => {
    const api = blindpay({ quote: [{ body: quote() }], payout: [{ body: payout() }] });
    const wallet = approver();
    const result = await payToBank(PARAMS, ROUTE, WALLET, { fetchImpl: api.fetchImpl, approve: wallet.approve, settings: SETTINGS, waitMs: 0 });

    expect(api.sent[0]).toMatchObject({ method: "POST", key: null });
    expect(api.sent[0].url).toBe("https://api.blindpay.com/v1/instances/in_TestInstanceAB/quotes");
    expect(api.sent[0].body).toMatchObject({ bank_account_id: "ba_000000000001", currency_type: "sender", cover_fees: false, request_amount: 1000, network: "arc_testnet", token: "USDB" });
    expect(wallet.calls).toEqual([{ call: { contractAddress: TOKEN, abiFunctionSignature: "approve(address,uint256)", abiParameters: [SPENDER, "10000000"] }, key: bankStepKey("attempt-key-1", "approve") }]);
    expect(api.sent[1]).toMatchObject({ key: "attempt-key-1/bank-payout", body: { quote_id: "qu_000000000001", sender_wallet_address: WALLET.address } });
    expect(result).toMatchObject({
      providerTxId: `${BANK_ID}po_000000000001`,
      status: "pending",
      route: "bank",
      providerState: "processing",
      bankPayout: { provider: "blindpay", quoteId: "qu_000000000001", payoutId: "po_000000000001", receiverAmount: 181.4, currency: "MXN", rate: 18.35, feesReceiver: 2.1, network: "arc_testnet", token: "USDB" },
    });
  });

  it("sends nothing when the quote would take another amount than the invoice's, or has expired", async () => {
    const other = blindpay({ quote: [{ body: quote({ sender_amount: 1001 }) }] });
    const wallet = approver();
    await expect(payToBank(PARAMS, ROUTE, WALLET, { fetchImpl: other.fetchImpl, approve: wallet.approve, settings: SETTINGS })).rejects.toThrow(/BlindPay quoted 10.01 to leave for a 10 payment: nothing was sent/);
    const expired = blindpay({ quote: [{ body: quote({ expires_at: Date.now() - 1000 }) }] });
    await expect(payToBank(PARAMS, ROUTE, WALLET, { fetchImpl: expired.fetchImpl, approve: wallet.approve, settings: SETTINGS })).rejects.toThrow(/quote expired before the payout: nothing was sent/);
    const refused = blindpay({ quote: [{ status: 400, body: { code: "QUOTES_BANK_ACCOUNT_NOT_APPROVED" } }] });
    await expect(payToBank(PARAMS, ROUTE, WALLET, { fetchImpl: refused.fetchImpl, approve: wallet.approve, settings: SETTINGS })).rejects.toThrow(
      "BlindPay gave no quote for this payout (QUOTES_BANK_ACCOUNT_NOT_APPROVED): nothing was sent."
    );
    expect(wallet.calls).toEqual([]);
  });

  it("asks for no payout until Circle confirms the approve", async () => {
    for (const [status, message] of [
      ["failed", "The approve for BlindPay failed: nothing was paid."],
      ["pending", "Circle has not confirmed the approve for BlindPay yet: nothing was paid."],
    ] as const) {
      const api = blindpay({ quote: [{ body: quote() }] });
      const error = await payToBank(PARAMS, ROUTE, WALLET, { fetchImpl: api.fetchImpl, approve: approver(status).approve, settings: SETTINGS }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(BankPayoutError);
      expect((error as Error).message).toBe(message);
      expect(api.sent.filter((request) => request.url.endsWith("/payouts/evm"))).toEqual([]);
    }
  });

  it("asks for the same payout again under the same key while BlindPay has not seen the approve", async () => {
    const api = blindpay({ quote: [{ body: quote() }], payout: [{ status: 400, body: { code: "PAYOUTS_ALLOWANCE_NOT_CONFIRMED" } }, { body: payout() }] });
    const result = await payToBank(PARAMS, ROUTE, WALLET, { fetchImpl: api.fetchImpl, approve: approver().approve, settings: SETTINGS, waitMs: 0 });
    const payouts = api.sent.filter((request) => request.url.endsWith("/payouts/evm"));
    expect(payouts.map((request) => request.key)).toEqual(["attempt-key-1/bank-payout", "attempt-key-1/bank-payout"]);
    expect(result.providerTxId).toBe(`${BANK_ID}po_000000000001`);
  });

  it("keeps a payout BlindPay never answered, or one its key already holds, in flight; one it refused paid nothing", async () => {
    const silent = blindpay({ quote: [{ body: quote() }], payout: ["no answer"] });
    const lost = await failure(payToBank(PARAMS, ROUTE, WALLET, { fetchImpl: silent.fetchImpl, approve: approver().approve, settings: SETTINGS }));
    expect(lost).not.toBeInstanceOf(BankPayoutError);
    expect(lost.message).toContain(MAY_HAVE_BEEN_ACCEPTED);

    const held = blindpay({ quote: [{ body: quote() }], payout: [{ status: 409, body: { code: "idempotency_key_reused" } }] });
    const kept = await failure(payToBank(PARAMS, ROUTE, WALLET, { fetchImpl: held.fetchImpl, approve: approver().approve, settings: SETTINGS }));
    expect(kept.message).toContain(MAY_HAVE_BEEN_ACCEPTED);
    expect(kept.message).toContain("check it with BlindPay");

    const refused = blindpay({ quote: [{ body: quote() }], payout: [{ status: 400, body: { code: "PAYOUTS_INSUFFICIENT_BALANCE" } }] });
    await expect(payToBank(PARAMS, ROUTE, WALLET, { fetchImpl: refused.fetchImpl, approve: approver().approve, settings: SETTINGS })).rejects.toThrow(
      "BlindPay refused the payout (PAYOUTS_INSUFFICIENT_BALANCE): nothing was paid."
    );
  });

  it("refuses a wallet with no address to pay from, before asking BlindPay anything", async () => {
    const api = blindpay({});
    await expect(payToBank(PARAMS, ROUTE, { address: null, chain: "ARC-TESTNET" }, { fetchImpl: api.fetchImpl, approve: approver().approve, settings: SETTINGS })).rejects.toThrow(/no address to pay BlindPay from/);
    expect(api.sent).toEqual([]);
  });
});

describe("a bank payout as a transfer (B8)", () => {
  it("is paid on completed; refunded reads as Circle's own terminal failure, and failed waits for BlindPay's refund", () => {
    expect(bankPayoutResult("blindpay:po_000000000001", { id: "po_000000000001", status: "completed", txHash: null, reason: null, estimatedArrival: null }, "ARC-TESTNET")).toMatchObject({
      status: "confirmed",
      providerState: "completed",
      failureReason: null,
      route: "bank",
    });
    expect(bankPayoutResult("blindpay:po_000000000001", { id: "po_000000000001", status: "refunded", txHash: null, reason: null, estimatedArrival: null }, "ARC-TESTNET")).toMatchObject({
      status: "failed",
      providerState: "FAILED",
      failureReason: "BlindPay refunded the payout",
    });
    // Not a terminal failure: Approve and pay only reads it again, and sends nothing new, until BlindPay refunds it.
    expect(bankPayoutResult("blindpay:po_000000000001", { id: "po_000000000001", status: "failed", txHash: null, reason: "Invalid CLABE", estimatedArrival: null }, "ARC-TESTNET")).toMatchObject({
      status: "failed",
      providerState: "failed",
      failureReason: "Invalid CLABE; BlindPay holds the USDC until it refunds it",
    });
    expect(bankPayoutResult("blindpay:po_000000000001", { id: "po_000000000001", status: "on_hold", txHash: null, reason: null, estimatedArrival: null }, "ARC-TESTNET").status).toBe("pending");
  });

  it("is read back from BlindPay by its payout id, never sent again", async () => {
    const api = blindpay({ read: [{ body: payout("completed") }] });
    const read = await reconcileBankPayout(`${BANK_ID}po_000000000001`, { fetchImpl: api.fetchImpl, settings: SETTINGS });
    expect(read.status).toBe("completed");
    expect(api.sent).toEqual([{ url: "https://api.blindpay.com/v1/instances/in_TestInstanceAB/payouts/po_000000000001", method: "GET", key: null, body: null }]);
  });
});

describe("a person approves every bank payout (B6)", () => {
  it("holds the agent's pay for a vendor paid to its bank, whatever the model said", () => {
    expect(enforceApGuardrails({ action: "pay", reasoning: "Pay now.", amount: 10, riskLevel: "low", paymentLimit: 1000, paidToBank: true })).toMatchObject({
      blocked: true,
      status: "held",
      rule: "payout.bank_needs_person",
    });
    expect(enforceApGuardrails({ action: "pay", reasoning: "Pay now.", amount: 10, riskLevel: "low", paymentLimit: 1000 }).blocked).toBe(false);
  });
});

describe("the approval card's words (B12)", () => {
  const BANK = { bankCode: "012", last4: "9716", beneficiaryName: "Ana López", accountStatus: "approved" as const };

  it("names the account by its bank and last four, and what the vendor receives", () => {
    expect(bankAccountLine(BANK)).toBe("Paid to a bank account in Mexico: BBVA ····9716, Ana López, through BlindPay.");
    expect(bankAccountLine({ ...BANK, accountStatus: "verifying" })).toContain("BlindPay is still checking the account.");
    expect(bankQuoteLine({ ...BANK, quote: { receiverAmount: 1814, currency: "MXN", rate: 18.35, feesReceiver: 2.1 }, quoteProblem: null })).toBe(
      "Ana López receives about 1,814.00 MXN (18.35 MXN per USDC, BlindPay's fees 2.10 MXN). Approve and pay asks BlindPay for a fresh quote."
    );
    expect(bankQuoteLine({ ...BANK, quote: null, quoteProblem: "eurc" })).toBe("Only USDC is paid to a bank account, and this invoice is in EURC.");
    expect(bankQuoteLine({ ...BANK, quote: null, quoteProblem: "unread" })).toMatch(/^BlindPay did not quote it just now/);
  });
});

describe("BlindPay's notices (B9)", () => {
  const key = crypto.randomBytes(24);
  const secret = `whsec_${key.toString("base64")}`;
  const now = 1_792_130_000_000;
  const signed = (raw: string, signingKey: Buffer = key) => {
    const timestamp = String(Math.floor(now / 1000));
    const signature = `v1,${crypto.createHmac("sha256", signingKey).update(`msg_1.${timestamp}.${raw}`).digest("base64")}`;
    return new Headers({ "svix-id": "msg_1", "svix-timestamp": timestamp, "svix-signature": signature });
  };
  const ORGS = [
    { id: "org-a", slug: "alpha", mode: "sandbox" as const },
    { id: "org-b", slug: "bravo", mode: "live" as const },
  ];

  it("starts a cycle in the workspace whose payment waits on the payout, after the signature checks", async () => {
    const raw = JSON.stringify({ webhook_event: "payout.complete", id: "po_000000000001" });
    const raise = vi.fn();
    const answer = await handleBlindpayNotice(raw, signed(raw), {
      secret,
      now: () => now,
      candidates: async () => ORGS,
      inFlight: async (orgId, providerTxId) => orgId === "org-b" && providerTxId === "blindpay:po_000000000001",
      raise,
    });
    expect(answer).toEqual({ status: 200, started: "bravo" });
    expect(raise).toHaveBeenCalledWith({ orgId: "org-b", sandbox: false, kind: "payment_settled" });
  });

  it("refuses a notice not signed with the secret, or with none set, and reads nothing", async () => {
    const raw = JSON.stringify({ webhook_event: "payout.complete", id: "po_000000000001" });
    const candidates = vi.fn(async () => ORGS);
    expect(await handleBlindpayNotice(raw, signed(raw, crypto.randomBytes(24)), { secret, now: () => now, candidates })).toEqual({ status: 401 });
    expect(await handleBlindpayNotice(raw, signed(raw), { secret: null, now: () => now, candidates })).toEqual({ status: 401 });
    expect(candidates).not.toHaveBeenCalled();
  });

  it("acknowledges any other notice, and asks again when a workspace could not be read", async () => {
    const other = JSON.stringify({ webhook_event: "bankAccount.new", id: "ba_000000000001" });
    const raise = vi.fn();
    expect(await handleBlindpayNotice(other, signed(other), { secret, now: () => now, candidates: async () => ORGS, raise })).toEqual({ status: 200 });
    const raw = JSON.stringify({ webhook_event: "payout.update", id: "po_000000000001" });
    const unread = await handleBlindpayNotice(raw, signed(raw), {
      secret,
      now: () => now,
      candidates: async () => ORGS,
      inFlight: async (orgId) => {
        if (orgId === "org-a") throw new Error("down");
        return false;
      },
      raise,
    });
    expect(unread).toEqual({ status: 503 });
    expect(raise).not.toHaveBeenCalled();
  });
});
