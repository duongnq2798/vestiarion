import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createEvmPayout, createQuote, createSpeiAccount, getPayout, termsUrl, testBusiness } from "@/lib/blindpay/api";
import { clabeBank, clabeShown, readClabe } from "@/lib/blindpay/clabe";
import { BlindpayError } from "@/lib/blindpay/http";
import { expiresAtMs, mapPayout, mapQuote, payoutOutcome } from "@/lib/blindpay/map";
import { blindpaySettingsFromEnv } from "@/lib/blindpay/settings";
import { verifyBlindpaySignature } from "@/lib/blindpay/webhook";

/**
 * BlindPay, the bank payout partner (docs/superpowers/specs/2026-10-16-bank-payouts-design.md): its settings and the
 * network a workspace pays on (B2), the CLABE check (B4), quotes and payouts read (B5, B7, B8), every call's auth and
 * idempotency key, and the webhook's Svix signature (B9).
 */

const SETTINGS = { apiKey: "test-key-not-real", instanceId: "in_TestInstanceAB" };
const QUOTE = {
  id: "qu_000000000001",
  expires_at: 1792130400000,
  commercial_quotation: 1839,
  blindpay_quotation: 1835,
  sender_amount: 1000,
  receiver_amount: 18140,
  flat_fee: 210,
  billing_fee_amount: 0,
  contract: { address: "0x1111111111111111111111111111111111111111", blindpayContractAddress: "0x2222222222222222222222222222222222222222", amount: "10000000", abi: [], functionName: "approve", network: { name: "arc_testnet", chainId: 5042002 } },
};

function fake(answer: { status?: number; body: unknown; headers?: Record<string, string> }) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json", ...answer.headers } });
  }) as unknown as typeof fetch;
  return { sent, deps: { fetchImpl } };
}

const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;

describe("BlindPay's settings (B2)", () => {
  it("is on with a key and an instance id, and pays on the workspace's network", () => {
    const settings = blindpaySettingsFromEnv({ BLINDPAY_API_KEY: "k", BLINDPAY_INSTANCE_ID: "in_TestInstance01", BLINDPAY_WEBHOOK_SECRET: "whsec_abc" });
    expect(settings).toMatchObject({ apiKey: "k", instanceId: "in_TestInstance01", webhookSecret: "whsec_abc" });
    expect(settings?.route("arc-testnet")).toEqual({ network: "arc_testnet", token: "USDB" });
    expect(settings?.route("arc-mainnet")).toEqual({ network: "arc", token: "USDC" });
    expect(blindpaySettingsFromEnv({ BLINDPAY_API_KEY: "k", BLINDPAY_INSTANCE_ID: "in_x", BLINDPAY_NETWORK: "base_sepolia" })).toBeNull();
    const overridden = blindpaySettingsFromEnv({ BLINDPAY_API_KEY: "k", BLINDPAY_INSTANCE_ID: "in_TestInstance01", BLINDPAY_NETWORK: "base_sepolia" });
    expect(overridden?.route("arc-testnet")).toEqual({ network: "base_sepolia", token: "USDB" });
    expect(blindpaySettingsFromEnv({ BLINDPAY_API_KEY: "k" })).toBeNull();
    expect(blindpaySettingsFromEnv({ BLINDPAY_API_KEY: "k", BLINDPAY_INSTANCE_ID: "in_TestInstance01", BLINDPAY_WEBHOOK_SECRET: "nope" })?.webhookSecret).toBeNull();
  });
});

describe("a CLABE (B4)", () => {
  it("takes 18 digits whose control digit checks, and keeps only the bank code and last four", () => {
    expect(readClabe("032180000118359719")).toBe("032180000118359719");
    expect(readClabe("0321 8000 0118 3597 19")).toBe("032180000118359719");
    expect(readClabe("032180000118359718")).toBeNull();
    expect(readClabe("03218000011835971")).toBeNull();
    expect(readClabe("0321800001183597a9")).toBeNull();
    expect(clabeShown("012180000118359716")).toEqual({ bankCode: "012", last4: "9716" });
    expect(clabeBank("012")).toBe("BBVA");
    expect(clabeBank("999")).toBe("bank 999");
  });
});

describe("BlindPay's answers (B5, B7, B8)", () => {
  it("reads a quote: what leaves, what the vendor receives, the rate, the fees and the approve", () => {
    expect(mapQuote(QUOTE)).toEqual({
      id: "qu_000000000001",
      expiresAtMs: 1792130400000,
      senderAmount: 10,
      receiverAmount: 181.4,
      rate: 18.35,
      feesReceiver: 2.1,
      contract: { token: QUOTE.contract.address, spender: QUOTE.contract.blindpayContractAddress, amount: "10000000", network: "arc_testnet", chainId: 5042002 },
    });
    expect(() => mapQuote({ ...QUOTE, contract: { ...QUOTE.contract, blindpayContractAddress: "not an address" } })).toThrow();
    expect(() => mapQuote({ ...QUOTE, id: "po_1" })).toThrow();
  });

  it("reads expires_at in seconds or milliseconds", () => {
    expect(expiresAtMs(1712958191)).toBe(1712958191000);
    expect(expiresAtMs(1712958191000)).toBe(1712958191000);
    expect(expiresAtMs("soon")).toBeNull();
  });

  it("reads a payout and what it means for the payment", () => {
    const hash = `0x${"a".repeat(64)}`;
    expect(mapPayout({ id: "po_000000000001", status: "completed", tracking_transaction: { transaction_hash: hash } })).toMatchObject({ id: "po_000000000001", status: "completed", txHash: hash });
    expect(mapPayout({ id: "po_000000000002", status: "refunded", tracking_complete: { refund_reason: "Bank rejected the account" } }).reason).toBe("Bank rejected the account");
    expect(() => mapPayout({ id: "po_1", status: "lost" })).toThrow();
    expect([payoutOutcome("completed"), payoutOutcome("failed"), payoutOutcome("refunded"), payoutOutcome("processing"), payoutOutcome("on_hold")]).toEqual(["confirmed", "failed", "failed", "pending", "pending"]);
  });
});

describe("BlindPay's calls", () => {
  it("asks for a quote at the instance, with the key and the idempotency key, in minor units", async () => {
    const { sent, deps } = fake({ body: QUOTE });
    await createQuote(SETTINGS, { bankAccountId: "ba_000000000001", amount: 10, network: "arc_testnet", token: "USDB" }, "inv-1/attempt-1/bank-quote", deps);
    expect(sent[0].url).toBe("https://api.blindpay.com/v1/instances/in_TestInstanceAB/quotes");
    expect(header(sent[0].init, "authorization")).toBe("Bearer test-key-not-real");
    expect(header(sent[0].init, "idempotency-key")).toBe("inv-1/attempt-1/bank-quote");
    expect(bodyOf(sent[0].init)).toEqual({ bank_account_id: "ba_000000000001", currency_type: "sender", cover_fees: false, request_amount: 1000, network: "arc_testnet", token: "USDB" });
  });

  it("pays a quote from the sender's wallet, and reads a payout back", async () => {
    const payout = { id: "po_000000000009", status: "processing" };
    const made = fake({ body: payout });
    expect(await createEvmPayout(SETTINGS, { quoteId: "qu_000000000001", senderWalletAddress: "0x3333333333333333333333333333333333333333" }, "k/bank-payout", made.deps)).toMatchObject({ id: "po_000000000009", status: "processing" });
    expect(made.sent[0].url).toBe("https://api.blindpay.com/v1/instances/in_TestInstanceAB/payouts/evm");
    expect(bodyOf(made.sent[0].init)).toEqual({ quote_id: "qu_000000000001", sender_wallet_address: "0x3333333333333333333333333333333333333333" });
    const read = fake({ body: { ...payout, status: "completed" } });
    expect((await getPayout(SETTINGS, "po_000000000009", read.deps)).status).toBe("completed");
    expect(read.sent[0].init.method).toBe("GET");
  });

  it("sends a vendor's CLABE as a third party's SPEI account", async () => {
    const { sent, deps } = fake({ body: { id: "ba_000000000002", status: "approved" } });
    expect(await createSpeiAccount(SETTINGS, { customerId: "re_000000000001", beneficiaryName: "Ana López", clabe: "032180000118359719", label: "Ana López" }, "cp-1/bank", deps)).toEqual({ id: "ba_000000000002", status: "approved" });
    expect(sent[0].url).toBe("https://api.blindpay.com/v1/instances/in_TestInstanceAB/customers/re_000000000001/bank-accounts");
    expect(bodyOf(sent[0].init)).toMatchObject({ type: "spei_bitso", spei_protocol: "clabe", spei_clabe: "032180000118359719", beneficiary_name: "Ana López", recipient_relationship: "vendor_or_supplier" });
  });

  it("makes the terms link outside the instance path, with its idempotency key in the body", async () => {
    const { sent, deps } = fake({ body: { url: "https://app.blindpay.com/e/terms-of-service?x=1" } });
    expect(await termsUrl(SETTINGS, { idempotencyKey: "00000000-0000-4000-8000-000000000001", redirectUrl: "https://www.vestiarion.xyz/api/integrations/blindpay/terms?org=acme" }, deps)).toBe("https://app.blindpay.com/e/terms-of-service?x=1");
    expect(sent[0].url).toBe("https://api.blindpay.com/v1/e/instances/in_TestInstanceAB/tos");
    expect(bodyOf(sent[0].init)).toEqual({ idempotency_key: "00000000-0000-4000-8000-000000000001", redirect_url: "https://www.vestiarion.xyz/api/integrations/blindpay/terms?org=acme" });
    expect(header(sent[0].init, "idempotency-key")).toBeNull();
  });

  it("reads BlindPay's errors into its code, and says which are worth trying again", async () => {
    const expired = fake({ status: 400, body: { success: false, code: "QUOTES_EXPIRED", message: "quote_expired" } });
    const error = await createEvmPayout(SETTINGS, { quoteId: "qu_000000000001", senderWalletAddress: "0x3333333333333333333333333333333333333333" }, "k", expired.deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BlindpayError);
    expect(error).toMatchObject({ status: 400, code: "QUOTES_EXPIRED", retryable: false });
    expect(String((error as Error).message)).not.toContain("test-key-not-real");
    const busy = fake({ status: 429, body: { code: "development_instance_rate_limit_exceeded" }, headers: { "retry-after": "7" } });
    expect(await getPayout(SETTINGS, "po_000000000009", busy.deps).catch((caught: unknown) => caught)).toMatchObject({ status: 429, retryable: true, retryAfterMs: 7000 });
  });

  it("sends BlindPay only its own test values for a development business, never a real person's", () => {
    const business = testBusiness({ tosId: "to_000000000001", legalName: "Pinecrest Studio", email: "ops@example.com", externalId: "org-1" });
    expect(business).toMatchObject({ type: "business", kyc_type: "standard", tos_id: "to_000000000001", legal_name: "Pinecrest Studio", tax_id: "000000000" });
    expect(business.owners[0]).toMatchObject({ first_name: "Test", last_name: "Owner" });
    expect(business.legal_name).not.toBe("Fail");
  });
});

describe("the webhook's signature (B9)", () => {
  const key = crypto.randomBytes(24);
  const secret = `whsec_${key.toString("base64")}`;
  const body = JSON.stringify({ webhook_event: "payout.complete", id: "po_000000000009" });
  const now = 1_792_130_000_000;
  const sign = (id: string, timestamp: string, raw: string, signingKey: Buffer = key) =>
    `v1,${crypto.createHmac("sha256", signingKey).update(`${id}.${timestamp}.${raw}`).digest("base64")}`;
  const headers = (values: Record<string, string>) => new Headers(values);

  it("takes BlindPay's own signature, among several", () => {
    const timestamp = String(Math.floor(now / 1000));
    expect(verifyBlindpaySignature(headers({ "svix-id": "msg_1", "svix-timestamp": timestamp, "svix-signature": `v1,AAAA ${sign("msg_1", timestamp, body)}` }), body, secret, now)).toEqual({ ok: true, id: "msg_1" });
  });

  it("refuses a missing, stale, changed or wrongly keyed notice", () => {
    const timestamp = String(Math.floor(now / 1000));
    expect(verifyBlindpaySignature(headers({ "svix-id": "msg_1", "svix-timestamp": timestamp }), body, secret, now)).toEqual({ ok: false, reason: "missing" });
    const old = String(Math.floor(now / 1000) - 600);
    expect(verifyBlindpaySignature(headers({ "svix-id": "msg_1", "svix-timestamp": old, "svix-signature": sign("msg_1", old, body) }), body, secret, now)).toEqual({ ok: false, reason: "stale" });
    expect(verifyBlindpaySignature(headers({ "svix-id": "msg_1", "svix-timestamp": timestamp, "svix-signature": sign("msg_1", timestamp, body) }), `${body} `, secret, now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyBlindpaySignature(headers({ "svix-id": "msg_1", "svix-timestamp": timestamp, "svix-signature": sign("msg_1", timestamp, body, crypto.randomBytes(24)) }), body, secret, now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyBlindpaySignature(headers({ "svix-id": "msg_1", "svix-timestamp": timestamp, "svix-signature": sign("msg_1", timestamp, body) }), body, "not-a-secret", now)).toEqual({ ok: false, reason: "bad_secret" });
  });
});
