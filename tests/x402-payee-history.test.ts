import { describe, expect, it, vi } from "vitest";
import { getAddress, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sellPayeeHistory, type Facilitator, type PayeeHistory } from "@/lib/platform/payee-history";
import { buyX402, circleTypedData, PurchaseRefused, type X402Signer } from "@/lib/x402/buyer";
import { decodeHeader, encodeHeader, GATEWAY_BATCHING, PAYEE_HISTORY_PATH, payeeHistoryRequirements, VESTIARION_SELLER, X402_NETWORK } from "@/lib/x402/offer";

/**
 * Payee history over x402 (docs/superpowers/specs/2026-10-02-x402-payee-history-design.md §2, R1, R2, R4, R5):
 * the seller asks with a 402 and Vestiarion's one offer, answers only once Circle's facilitator verified and
 * settled the payment, and never charges for an answer it could not read; the buyer refuses in code before
 * signing anything it may not pay, and signs Gateway's batched authorization as the facilitator checks it.
 */

const ORIGIN = "https://www.vestiarion.xyz";
const ADDRESS = "0x537409Db5D90c0b1F4A8d0B087c8427A7C955981";
const HISTORY: PayeeHistory = { address: ADDRESS, workspacesPaid: 2, paymentsConfirmed: 5, firstPaidAt: "2026-09-29T10:00:00Z", lastPaidAt: "2026-10-02T06:28:15Z", asOf: "2026-10-02T07:00:00Z" };
const buyerKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

/** Circle's facilitator as the seller sees it: here it checks the signature itself, as Gateway does with ecrecover. */
function facilitator(over: { verify?: Facilitator["verify"]; settle?: Facilitator["settle"] } = {}) {
  const calls = { verify: 0, settle: 0 };
  const f: Facilitator = {
    verify: async (payload, requirements) => {
      calls.verify += 1;
      if (over.verify) return over.verify(payload, requirements);
      const { authorization, signature } = (payload as { payload: { authorization: Record<string, string>; signature: Hex } }).payload;
      const valid = await verifyTypedData({
        address: authorization.from as Hex,
        domain: { name: GATEWAY_BATCHING.name, version: GATEWAY_BATCHING.version, chainId: 5042002, verifyingContract: GATEWAY_BATCHING.verifyingContract },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) } as never,
        signature,
      });
      const longEnough = Number(authorization.validBefore) - Date.now() / 1000 >= 7 * 86_400;
      const right = getAddress(authorization.to) === getAddress(requirements.payTo) && authorization.value === requirements.amount;
      return valid && longEnough && right ? { isValid: true, payer: authorization.from } : { isValid: false, invalidReason: "invalid_signature" };
    },
    settle: async (payload, requirements) => {
      calls.settle += 1;
      if (over.settle) return over.settle(payload, requirements);
      return { success: true, transaction: "gateway-transfer-1", network: X402_NETWORK, payer: buyerKey.address };
    },
  };
  return { f, calls };
}

/** The seller behind a fetch, as the buyer reaches it over HTTP. */
function sellerFetch(f: Facilitator, deps: { read?: () => Promise<PayeeHistory>; record?: () => Promise<void> } = {}) {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ url: url.toString(), headers });
    const answer = await sellPayeeHistory(
      { address: url.searchParams.get("address"), paymentHeader: headers["Payment-Signature"] ?? null, origin: ORIGIN },
      { facilitator: f, read: deps.read ?? (async () => HISTORY), record: deps.record ?? (async () => undefined) }
    );
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: answer.headers });
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}

const localSigner: X402Signer = {
  address: buyerKey.address,
  signTypedData: (params) => buyerKey.signTypedData(params as never),
};
const allowed = (url: URL) => url.origin === ORIGIN && url.pathname === PAYEE_HISTORY_PATH;
const buy = (fetcher: typeof fetch, over: Partial<Parameters<typeof buyX402>[0]> = {}) =>
  buyX402<PayeeHistory & { seller: string }>({
    url: `${ORIGIN}${PAYEE_HISTORY_PATH}?address=${ADDRESS}`,
    expected: payeeHistoryRequirements(),
    maxPriceUsdc: 0.01,
    allowed,
    signer: localSigner,
    fetch: fetcher,
    ...over,
  });

describe("the seller", () => {
  it("asks for 0.001 USDC on Arc testnet, through Gateway batching, to Vestiarion's own wallet", async () => {
    const { f, calls } = facilitator();
    const answer = await sellPayeeHistory({ address: ADDRESS, paymentHeader: null, origin: ORIGIN }, { facilitator: f });
    expect(answer.status).toBe(402);
    const offer = decodeHeader<{ x402Version: number; accepts: Array<Record<string, unknown>>; resource: { url: string } }>(answer.headers["PAYMENT-REQUIRED"]);
    expect(offer?.x402Version).toBe(2);
    expect(offer?.resource.url).toBe(`${ORIGIN}${PAYEE_HISTORY_PATH}?address=${ADDRESS}`);
    expect(offer?.accepts).toEqual([
      {
        scheme: "exact",
        network: "eip155:5042002",
        asset: "0x3600000000000000000000000000000000000000",
        amount: "1000",
        payTo: VESTIARION_SELLER,
        maxTimeoutSeconds: 345600,
        extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" },
      },
    ]);
    expect(calls).toEqual({ verify: 0, settle: 0 });
  });

  it("answers a missing or malformed address with 400, before any offer", async () => {
    const { f } = facilitator();
    expect((await sellPayeeHistory({ address: "sim:cp-1", paymentHeader: null, origin: ORIGIN }, { facilitator: f })).status).toBe(400);
    expect((await sellPayeeHistory({ address: null, paymentHeader: null, origin: ORIGIN }, { facilitator: f })).status).toBe(400);
  });

  it("never verifies a payment made for another offer", async () => {
    const { f, calls } = facilitator();
    const cheaper = { ...payeeHistoryRequirements(), amount: "1" };
    const header = encodeHeader({ x402Version: 2, accepted: cheaper, payload: { authorization: { from: buyerKey.address } } });
    const answer = await sellPayeeHistory({ address: ADDRESS, paymentHeader: header, origin: ORIGIN }, { facilitator: f });
    expect(answer.status).toBe(402);
    expect(answer.body).toEqual({ error: "The payment accepted another offer than this one." });
    expect(calls.verify).toBe(0);
  });

  it("does not charge when the history cannot be read, and gives nothing when the payment does not settle", async () => {
    const unread = facilitator();
    const failing = sellerFetch(unread.f, { read: async () => Promise.reject(new Error("db down")) });
    await expect(buy(failing.fetcher)).rejects.toThrow(/503/);
    expect(unread.calls).toEqual({ verify: 1, settle: 0 });

    const unsettled = facilitator({ settle: async () => ({ success: false, errorReason: "insufficient_balance" }) });
    const refused = sellerFetch(unsettled.f);
    await expect(buy(refused.fetcher)).rejects.toThrow(/did not settle: insufficient_balance/);
  });
});

describe("the buyer and the seller together", () => {
  it("pays once with a Gateway-batched authorization the facilitator verifies, and gets the history and the settlement", async () => {
    const { f, calls } = facilitator();
    const recorded = vi.fn(async () => undefined);
    const { fetcher, sent } = sellerFetch(f, { record: recorded });
    const bought = await buy(fetcher);

    expect(bought.data).toMatchObject({ workspacesPaid: 2, paymentsConfirmed: 5, seller: "Vestiarion" });
    expect(bought).toMatchObject({ priceUsdc: 0.001, payer: buyerKey.address, payTo: VESTIARION_SELLER, settlement: "gateway-transfer-1" });
    expect(bought.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(calls).toEqual({ verify: 1, settle: 1 });
    expect(sent).toHaveLength(2);
    expect(recorded).toHaveBeenCalledWith({ address: ADDRESS, payer: buyerKey.address, nonce: bought.nonce, settlement: "gateway-transfer-1" });
  });

  it("refuses in code before signing: a seller not allowed, another offer, a price above the most, or its own last word", async () => {
    const { f } = facilitator();
    const sign = vi.fn(localSigner.signTypedData);
    const signer = { ...localSigner, signTypedData: sign };

    await expect(buy(sellerFetch(f).fetcher, { url: `https://evil.example${PAYEE_HISTORY_PATH}?address=${ADDRESS}`, signer })).rejects.toMatchObject({ rule: "seller.not_allowed" });
    await expect(buy(sellerFetch(f).fetcher, { expected: { ...payeeHistoryRequirements(), payTo: buyerKey.address }, signer })).rejects.toMatchObject({ rule: "offer.mismatch" });
    await expect(buy(sellerFetch(f).fetcher, { maxPriceUsdc: 0.0005, signer })).rejects.toMatchObject({ rule: "price.above_max" });
    await expect(
      buy(sellerFetch(f).fetcher, {
        signer,
        beforePay: async () => {
          throw new PurchaseRefused("budget.day", "over the day's budget");
        },
      })
    ).rejects.toMatchObject({ rule: "budget.day" });
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("circleTypedData", () => {
  it("adds the EIP-712 domain type for Circle's signTypedData and writes numbers as strings", () => {
    const data = JSON.parse(
      circleTypedData({
        domain: { name: "GatewayWalletBatched", version: "1", chainId: 5042002, verifyingContract: GATEWAY_BATCHING.verifyingContract },
        types: { TransferWithAuthorization: [{ name: "value", type: "uint256" }] },
        primaryType: "TransferWithAuthorization",
        message: { value: 1000n },
      })
    );
    expect(data.types.EIP712Domain.map((field: { name: string }) => field.name)).toEqual(["name", "version", "chainId", "verifyingContract"]);
    expect(data.message).toEqual({ value: "1000" });
    expect(data.primaryType).toBe("TransferWithAuthorization");
  });
});
