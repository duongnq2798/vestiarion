import { beforeEach, describe, expect, it, vi } from "vitest";
import { buyPayeeHistories, type BuyHistory } from "@/lib/agent/services";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { PurchaseRefused } from "@/lib/x402/buyer";
import type { Network } from "@/lib/network";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The cycle's `services` stage (docs/superpowers/specs/2026-10-02-x402-payee-history-design.md R3, R5, R6, R7):
 * it buys an address's history before a first payment to it, never twice in 7 days, never for an address
 * already paid, within the day's budget and the purse, and never while the agent is paused; each purchase,
 * refusal and failure is recorded and signed, and the decisions get the newest answer for the current address.
 */

const { ledgerMock } = vi.hoisted(() => ({ ledgerMock: vi.fn() }));
vi.mock("@/lib/ledger", () => ({ appendLedgerEntry: ledgerMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000005e7";
const NOW = new Date("2026-10-02T10:00:00Z");
const ADDR = { puka: "0x840de234Bfc3F66fA380888A0a8204D9487D60d4", gozo: "0xBa3f64568C9A571b52c1D1C0B1ca5b7f03134BFa", paid: "0x537409Db5D90c0b1F4A8d0B087c8427A7C955981" };
const COUNTERPARTIES = [
  { id: "cp-puka", name: "Puka Hotel", address: ADDR.puka, address_changed_at: null, address_confirmed_at: null },
  { id: "cp-gozo", name: "Gozo", address: ADDR.gozo, address_changed_at: null, address_confirmed_at: null },
  { id: "cp-paid", name: "Vestiarion", address: ADDR.paid, address_changed_at: null, address_confirmed_at: null },
  { id: "cp-moved", name: "Moved", address: "0x1111111111111111111111111111111111111111", address_changed_at: "2026-10-02T09:00:00Z", address_confirmed_at: null },
];

interface World {
  purchases?: unknown[];
  paused?: boolean;
  signer?: boolean;
}

let fake: ReturnType<typeof fakeSupabase>;
function world(over: World = {}) {
  fake = fakeSupabase((r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/rpc/agent_paused") return { body: over.paused ?? false };
    if (r.path === "/rest/v1/service_purchases" && r.method === "GET") return { body: over.purchases ?? [] };
    if (r.path === "/rest/v1/service_purchases" && r.method === "POST") return { body: { id: `purchase-${fake.requests.filter((q) => q.method === "POST").length}` } };
    if (r.path === "/rest/v1/gateway_signers") return { body: over.signer === false ? null : { circle_wallet_id: "w-signer", address: "0x325d7ba3ff3d1da5fb0b66ea47f86206e3f4f6b6" } };
    if (r.path === "/rest/v1/invoices") return { body: [{ counterparty_id: "cp-puka" }, { counterparty_id: "cp-paid" }, { counterparty_id: "cp-moved" }] };
    if (r.path === "/rest/v1/milestones") return { body: [{ contractor_id: "cp-gozo" }] };
    if (r.path === "/rest/v1/payment_intents") return { body: [{ destination: ADDR.paid.toLowerCase() }] };
    if (r.path === "/rest/v1/counterparties") return { body: COUNTERPARTIES };
    return { body: [] };
  });
}
const history = (address: string, workspacesPaid = 2) => ({ address, workspacesPaid, paymentsConfirmed: 4, firstPaidAt: "2026-09-29T10:00:00Z", lastPaidAt: "2026-10-01T10:00:00Z", asOf: NOW.toISOString(), seller: "Vestiarion" });
const bought = (address: string) => ({ data: history(address), priceUsdc: 0.001, payer: "0x325d7ba3ff3d1da5fb0b66ea47f86206e3f4f6b6", payTo: "0x2fafddA3F973e8f993911F1c2196d5E72D51d71d", nonce: `0x${"1".repeat(64)}`, settlement: "gateway-transfer-1" });
const run = (buy: BuyHistory, extra: { live?: boolean; purse?: number; paymentsDisabled?: boolean; network?: Network } = {}) => {
  const lines: Array<{ domain: string; message: string }> = [];
  const result = runWith(orgTestContext({ config: { ...config, paymentsDisabled: extra.paymentsDisabled, network: extra.network }, client: fake.client, orgId: ORG }), () =>
    buyPayeeHistories({ db: db(), live: extra.live ?? true, lines, now: NOW, buy, purse: async () => extra.purse ?? 0.05 })
  );
  return { result, lines };
};
const inserts = () => fake.requests.filter((r) => r.path === "/rest/v1/service_purchases" && r.method === "POST").map((r) => r.body as Record<string, unknown>);

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
});

describe("buyPayeeHistories", () => {
  it("buys the history of each address about to be paid for the first time, records it, signs it, and hands it to the decisions", async () => {
    world();
    const buy = vi.fn<BuyHistory>(async (address, beforePay) => {
      await beforePay(0.001);
      return bought(address);
    });
    const { result, lines } = run(buy);
    const facts = await result;

    // Not the address already paid, nor the one whose change awaits confirmation.
    expect(buy.mock.calls.map(([address]) => address).sort()).toEqual([ADDR.gozo, ADDR.puka].sort());
    expect(facts.get("cp-puka")).toMatchObject({ workspacesPaid: 2, paymentsConfirmed: 4, priceUsdc: 0.001, boughtAt: NOW.toISOString(), about: expect.stringContaining("other than this one") });
    expect(inserts()[0]).toMatchObject({ status: "paid", price_usdc: 0.001, settlement: "gateway-transfer-1", counterparty_id: expect.any(String), seller_url: expect.stringContaining("/api/x402/payee-history") });
    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "agent", domain: "compliance", action: "service_purchased", detail: expect.objectContaining({ priceUsdc: 0.001, settlement: "gateway-transfer-1", result: expect.objectContaining({ workspacesPaid: 2 }) }) })
    );
    expect(lines.some((line) => line.message.includes("bought its address's payment history for 0.001 USDC"))).toBe(true);
  });

  it("uses a history bought within 7 days instead of buying again, while the address is the one looked up", async () => {
    world({
      purchases: [
        { counterparty_id: "cp-puka", address: ADDR.puka, status: "paid", price_usdc: "0.001", result: history(ADDR.puka, 3), created_at: "2026-09-30T10:00:00Z" },
        { counterparty_id: "cp-gozo", address: "0x9999999999999999999999999999999999999999", status: "paid", price_usdc: "0.001", result: history("0x99", 7), created_at: "2026-09-30T10:00:00Z" },
      ],
    });
    const buy = vi.fn<BuyHistory>(async (address) => bought(address));
    const facts = await run(buy).result;
    expect(facts.get("cp-puka")).toMatchObject({ workspacesPaid: 3, boughtAt: "2026-09-30T10:00:00Z" });
    // Gozo's old purchase was for another address: it is bought again for the current one.
    expect(buy.mock.calls.map(([address]) => address)).toEqual([ADDR.gozo]);
  });

  it("refuses past the day's budget, signs the refusal, records the rule, and buys nothing after it", async () => {
    world({ purchases: [{ counterparty_id: "cp-x", address: "0x2222222222222222222222222222222222222222", status: "paid", price_usdc: "0.05", result: null, created_at: "2026-10-02T08:00:00Z" }] });
    const buy = vi.fn<BuyHistory>(async (address, beforePay) => {
      await beforePay(0.001);
      return bought(address);
    });
    await run(buy).result;
    expect(buy).toHaveBeenCalledTimes(1);
    expect(inserts()).toEqual([expect.objectContaining({ status: "refused", reason: expect.stringContaining("past 0.05 USDC") })]);
    expect(ledgerMock).toHaveBeenCalledWith(expect.objectContaining({ action: "service_purchase_refused", detail: expect.objectContaining({ rule: "budget.day" }) }));
  });

  it("refuses when the purse is short, and signs a purchase that failed without stopping the stage", async () => {
    world();
    const short = vi.fn<BuyHistory>(async (address, beforePay) => {
      await beforePay(0.001);
      return bought(address);
    });
    await run(short, { purse: 0.0005 }).result;
    expect(ledgerMock).toHaveBeenCalledWith(expect.objectContaining({ action: "service_purchase_refused", detail: expect.objectContaining({ rule: "purse.short" }) }));
    expect(short).toHaveBeenCalledTimes(1);

    world();
    ledgerMock.mockClear();
    const failing = vi.fn<BuyHistory>(async () => Promise.reject(new Error("The seller did not accept the payment (402): did not settle")));
    await run(failing).result;
    expect(failing).toHaveBeenCalledTimes(2);
    expect(ledgerMock).toHaveBeenCalledWith(expect.objectContaining({ action: "service_purchase_failed" }));
    expect(inserts().every((row) => row.status === "failed")).toBe(true);
  });

  it("does not try an address again within a day of a refusal or failure", async () => {
    world({ purchases: [{ counterparty_id: "cp-puka", address: ADDR.puka, status: "failed", price_usdc: null, result: null, created_at: "2026-10-02T09:30:00Z" }] });
    const buy = vi.fn<BuyHistory>(async (address) => bought(address));
    await run(buy).result;
    expect(buy.mock.calls.map(([address]) => address)).toEqual([ADDR.gozo]);
  });

  it("buys nothing while the agent is paused, in a sandbox, or with no Gateway signer", async () => {
    const buy = vi.fn<BuyHistory>(async (address) => bought(address));
    world({ paused: true });
    await run(buy).result;
    world();
    await run(buy, { live: false }).result;
    expect(buy).not.toHaveBeenCalled();
    expect(inserts()).toEqual([]);
  });

  it("buys nothing while the platform has payments switched off, though it still hands over what it bought before (payment safety S9)", async () => {
    const buy = vi.fn<BuyHistory>(async (address) => bought(address));
    world();
    await run(buy, { paymentsDisabled: true }).result;
    expect(buy).not.toHaveBeenCalled();
    expect(inserts()).toEqual([]);
  });

  it("buys nothing on a network without Gateway, and says why (network threading P5)", async () => {
    const buy = vi.fn<BuyHistory>(async (address) => bought(address));
    world();
    const { result, lines } = run(buy, { network: "arc-mainnet" });
    await result;
    expect(buy).not.toHaveBeenCalled();
    expect(inserts()).toEqual([]);
    expect(lines).toContainEqual({ domain: "compliance", message: "Buying services over x402 does not run on Arc mainnet yet" });
  });

  it("names a refusal's rule only for a refusal", () => {
    expect(new PurchaseRefused("purse.short", "x").rule).toBe("purse.short");
  });
});
