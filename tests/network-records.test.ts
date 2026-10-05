import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildReceipt, receiptSummary, type ReceiptFacts } from "@/lib/receipts/facts";
import { readOnChain } from "@/lib/receipts/onchain";
import { pullRequestCommentBody } from "@/lib/github/payment-comments";
import { activityItem, type ActivityEntry } from "@/lib/agent-activity";
import { counterpartyChainProblem } from "@/lib/intake-validation";
import { PayeeJourney } from "@/components/payee/PayeeJourney";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { invoiceDecision } from "@/components/vx/map";
import type { LedgerEntry } from "@/lib/ledger";
import type { PayeeLinkStatus } from "@/lib/payee-journey";
import type { CounterpartyRow, InvoiceRow } from "@/lib/queries";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/payee/[token]/actions", () => ({ submitPayeeAddressAction: vi.fn() }));

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

// ---------------------------------------------------------------- Task 7: a workspace's chain, and the pages' links
describe("a counterparty's chain on its workspace's network (Review Focus 3)", () => {
  it("is refused in plain words when it is another network's, and none is the workspace's own", () => {
    expect(counterpartyChainProblem("arc-testnet", "ARC")).toBe("ARC is not a chain this workspace pays on");
    expect(counterpartyChainProblem("arc-mainnet", "BASE-SEPOLIA")).toBe("BASE-SEPOLIA is not a chain this workspace pays on");
    expect(counterpartyChainProblem("arc-testnet", "BASE-SEPOLIA")).toBeNull();
    expect(counterpartyChainProblem("arc-mainnet", null)).toBeNull();
    expect(counterpartyChainProblem("arc-mainnet", undefined)).toBeNull();
  });
});

describe("a page's links (P6)", () => {
  it("open the payee's network's explorer on a paid payee link, with no scope (Review Focus 1)", () => {
    const status: PayeeLinkStatus = {
      orgName: "Northstar", payeeName: "Linh Tran", chain: "ARC", linkState: "used", expiresAt: "2026-10-12T00:00:00Z", usedAt: "2026-10-05T14:24:17Z",
      statusUntil: "2026-11-05T00:00:00Z", address: "0x1234567890abcdef1234567890abcdef1234abcd", addressConfirmed: true,
      payments: [{ kind: "milestone", title: "Passkey test flow", amount: 1, currency: "USDC", status: "paid", txRef: HASH, settledAt: "2026-10-05T14:25:34Z", scheduledFor: null }],
    };
    const markup = renderToStaticMarkup(createElement(PayeeJourney, { token: "t", status, refresh: false }));
    expect(markup).toContain(`https://explorer.arc.io/tx/${HASH}`);
    expect(markup).not.toContain("explorer.testnet.arc.io");
  });

  it("open the workspace's network's explorer on a decision's transaction", () => {
    const invoice = {
      id: "inv-1", direction: "payable", counterparty_id: "cp-1", counterparty_name: "Acme", amount: 1, memo: null, po_reference: "PO-1", goods_received: true,
      due_date: "2026-10-05T12:00:00.000Z", status: "paid", agent_reasoning: "Paid.", tx_ref: HASH, scheduled_for: null, early_pay_discount_pct: null,
      discount_due_date: null, paid_amount: null,
    } as InvoiceRow;
    const counterparty = { id: "cp-1", name: "Acme", role: "vendor", address: null, chain: null, payment_limit: 5, risk_level: "clear" } as unknown as CounterpartyRow;
    const paid = { seq: 9, ts: "2026-10-05T14:25:35Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "PAY", detail: { invoiceId: "inv-1", execution: { txRef: HASH } } } as unknown as LedgerEntry;
    const decision = invoiceDecision(invoice, counterparty, [paid], { network: "arc-mainnet" });
    const markup = renderToStaticMarkup(createElement(DecisionCard, { decision, orgSlug: "acme" }));
    expect(markup).toContain(`https://explorer.arc.io/tx/${HASH}`);
  });
});
