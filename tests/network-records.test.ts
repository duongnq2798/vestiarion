import { describe, expect, it } from "vitest";
import { buildReceipt, receiptSummary, type ReceiptFacts } from "@/lib/receipts/facts";
import { readOnChain } from "@/lib/receipts/onchain";
import { pullRequestCommentBody } from "@/lib/github/payment-comments";
import { activityItem, type ActivityEntry } from "@/lib/agent-activity";

/**
 * A record reads the network it carries, with no workspace in scope
 * (docs/superpowers/specs/2026-10-05-network-threading-design.md P1, P6).
 */

const HASH = `0x${"ab".repeat(32)}`;
const intent = (over: Record<string, unknown> = {}) => ({
  status: "confirmed",
  provider_mode: "live",
  token: "USDC",
  amount: 1,
  destination: "0x840de234Bfc3F66fA380888A0a8204D9487D60d4",
  tx_hash: HASH,
  chain: null,
  destination_chain: null,
  mint_tx_hash: null,
  bridge_fee: null,
  payout_route: null,
  confirmed_at: "2026-10-05T14:25:34Z",
  network: null,
  ...over,
});
const paidInvoice = { id: "inv-1", status: "paid", direction: "payable" };
const recorded = [{ seq: 7, ts: "2026-10-05T14:25:35Z", hash: `0x${"cd".repeat(32)}`, action: "ap_pay", detail: { invoiceId: "inv-1", txHash: HASH } }];

function factsOf(built: ReturnType<typeof buildReceipt>): ReceiptFacts {
  if (!built.ok) throw new Error(built.reason);
  return built.facts;
}

describe("a receipt", () => {
  it("is on Arc testnet's own chain for an intent from before 0075 (Review Focus 2)", () => {
    expect(factsOf(buildReceipt({ invoice: paidInvoice, intent: intent() as never, entries: recorded as never })).chain).toBe("ARC-TESTNET");
  });

  it("is on Arc mainnet's own chain for a mainnet intent, read on mainnet's RPC with no scope", async () => {
    const facts = factsOf(buildReceipt({ invoice: paidInvoice, intent: intent({ network: "arc-mainnet" }) as never, entries: recorded as never }));
    expect(facts.chain).toBe("ARC");
    expect(receiptSummary(facts)).toContain("Arc mainnet");
    const asked: string[] = [];
    const fetch = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
    }) as unknown as typeof globalThis.fetch;
    await readOnChain(facts, { fetch });
    expect(asked[0]).toBe("https://rpc.mainnet.arc.io");
  });
});

describe("a payment's comment", () => {
  it("links the explorer of the intent's network, and names it", () => {
    const mainnet = pullRequestCommentBody({ amount: "1.00", token: "USDC", orgName: "Acme", txHash: HASH, origin: "https://www.vestiarion.xyz", network: "arc-mainnet" });
    expect(mainnet).toContain(`https://explorer.arc.io/tx/${HASH}`);
    expect(mainnet).toContain("on Arc mainnet");
    expect(pullRequestCommentBody({ amount: "1.00", token: "USDC", orgName: "Acme", txHash: HASH, origin: "https://www.vestiarion.xyz", network: "arc-testnet" })).toContain(`https://explorer.testnet.arc.io/tx/${HASH}`);
  });
});

describe("an activity item", () => {
  it("links its transaction on the workspace's network, once, for every chat and page", () => {
    const entry: ActivityEntry = { seq: 1, ts: "2026-10-05T14:25:35Z", action: "ap_pay", actor: "agent", detail: { invoiceId: "inv-1", txHash: HASH, execution: { txRef: HASH } } } as never;
    const invoices = new Map([["inv-1", { name: "Passkey test", amount: 1, currency: "USDC", status: "paid", txRef: HASH, scheduledFor: null }]]);
    const item = activityItem(entry, { network: "arc-mainnet", invoices, milestones: new Map() });
    expect(item?.txUrl).toBe(`https://explorer.arc.io/tx/${HASH}`);
  });
});
