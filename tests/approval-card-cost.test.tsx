import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApprovalCard from "@/components/ApprovalCard";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { WaitingPayable } from "@/lib/agent/approvals";

/**
 * The approval card's cost box (docs/superpowers/specs/2026-10-22-approval-total-cost-design.md TC1): what Approve and
 * pay would cost, shown before anyone approves, and not for a payment already sent, in flight, processing or to a bank.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/verdicts", () => ({ giveVerdictAction: vi.fn() }));
vi.mock("@/app/actions/document-requests", () => ({ revokeDocumentRequestAction: vi.fn(), setDocumentRequestsAction: vi.fn(), attachDocumentAction: vi.fn() }));
vi.mock("@/app/actions/approvals", () => ({
  approveInvoiceAction: vi.fn(), cosignInvoiceAction: vi.fn(),
  rejectInvoiceAction: vi.fn(),
  returnInvoiceAction: vi.fn(),
  addInvoiceDetailsAction: vi.fn(),
}));

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").trim();
const VIEWER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e5";

const payable: WaitingPayable = {
  id: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f1",
  counterpartyId: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1",
  counterpartyName: "Cobalt Cloud",
  riskLevel: "low",
  amount: 140,
  dueDate: "2026-10-22",
  status: "held",
  reasoning: "Held: the operating wallet is short.",
  explanation: "Held: the operating wallet is short.",
  decidedAt: "2026-10-17T10:00:00.000Z",
  createdBy: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1",
  reviewedAt: null,
  reclaimable: false,
  paymentSent: false,
  address: "0x1948aB0000000000000000000000000000c345a0",
  lastAttempt: null,
  discount: null,
  currency: "USDC",
  payeeChain: "BASE-SEPOLIA",
  bridgeFeeUsdc: 0.210001,
  payoutRoute: "cctp",
  poReference: null,
  goodsReceived: true,
  addedSinceDecision: null,
  guardrailRule: null,
};
const card = (over: Partial<WaitingPayable> = {}) => text(html(<ApprovalCard orgSlug="acme" payable={{ ...payable, ...over }} canDecide viewerId={VIEWER} sandbox={false} />));

describe("the approval card's cost", () => {
  it("shows what Approve and pay would cost before anyone approves: the fee, what leaves and what the payee receives", () => {
    const shown = card();
    expect(shown).toContain("Invoice 140.00 USDC");
    expect(shown).toContain("CCTP fee, about 0.210001 USDC");
    expect(shown).toContain("Leaves the operating wallet 140.210001 USDC");
    expect(shown).toContain("Cobalt Cloud receives at least 140.00 USDC on Base Sepolia");
    // On Arc testnet Circle's Gas Station pays the network fee; on Arc mainnet the card notes it.
    expect(shown).not.toContain("Arc's network fee");
    expect(card({ payeeChain: "BASE" })).toContain("Arc's network fee, about 0.00319 USDC a transaction");
  });

  it("is not shown for a payment already sent, one in flight, one the agent is paying, or a bank payout", () => {
    expect(card({ paymentSent: true })).not.toContain("Leaves the operating wallet");
    expect(card({ lastAttempt: { state: "in_flight" } as WaitingPayable["lastAttempt"] })).not.toContain("Leaves the operating wallet");
    expect(card({ status: "processing" })).not.toContain("Leaves the operating wallet");
    expect(card({ bank: { beneficiaryName: "Cobalt SA", quote: null, quoteProblem: "not_set_up" } as unknown as WaitingPayable["bank"] })).not.toContain("Leaves the operating wallet");
  });

  it("shows a bank payout's cost with BlindPay's quote, and what USDC to a wallet would give the vendor (bank route comparison BR1)", () => {
    const bank = { bankCode: "012", last4: "9716", beneficiaryName: "Ana López", accountStatus: "approved", quote: { receiverAmount: 1814, currency: "MXN", rate: 18.35, feesSender: 2.1 }, quoteProblem: null };
    const shown = card({ amount: 100, payeeChain: "ARC-TESTNET", bank: bank as WaitingPayable["bank"] });
    expect(shown).toContain("BlindPay's fees, taken from it -2.10 USDC");
    expect(shown).toContain("Leaves the operating wallet 100.00 USDC");
    expect(shown).toContain("Paid in USDC to a wallet instead, Cobalt Cloud would receive the full 100.00 USDC, with no fee taken");
  });
});
