import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApprovalCard from "@/components/ApprovalCard";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { WaitingPayable } from "@/lib/agent/approvals";
import type { VerdictView } from "@/lib/verdict-view";

/**
 * A payment held in shadow mode, in Approvals (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S4): the person
 * agrees and pays it, or disagrees, rather than approving it; once a verdict is given, the card says it and keeps its
 * actions. Server-rendered markup, as tests/control-ui.test.tsx renders the card.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/verdicts", () => ({ giveVerdictAction: vi.fn() }));
vi.mock("@/app/actions/approvals", () => ({
  approveInvoiceAction: vi.fn(),
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
  counterpartyName: "Northwind Supply",
  riskLevel: "low",
  amount: 96.39,
  dueDate: "2026-10-10",
  status: "held",
  reasoning: "Matched and within the limit; paying now. [shadow mode: held for a person to agree; nothing is paid until they do]",
  explanation: "Matched and within the limit; paying now.",
  decidedAt: "2026-10-07T10:00:00.000Z",
  createdBy: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1",
  reviewedAt: null,
  reclaimable: false,
  paymentSent: false,
  address: "0x1948aB0000000000000000000000000000c345a0",
  lastAttempt: null,
  discount: null,
  currency: "USDC",
  payeeChain: "ARC-TESTNET",
  bridgeFeeUsdc: null,
  poReference: null,
  goodsReceived: true,
  addedSinceDecision: null,
  guardrailRule: null,
  heldForVerdict: true,
  verdictEntry: { seq: 41, ts: "2026-10-07T10:00:00.000Z" },
};
const view = (over: Partial<VerdictView> = {}): VerdictView => ({ entrySeq: 41, agentAction: "ap_pay", given: null, open: true, heldForVerdict: true, ...over });
const card = (verdict?: VerdictView) =>
  text(html(<ApprovalCard orgSlug="acme" payable={payable} canDecide viewerId={VIEWER} sandbox={false} {...(verdict ? { verdict } : {})} />));

describe("ApprovalCard in shadow mode", () => {
  it("asks the person to agree and pay, or disagree, instead of approving it", () => {
    const words = card(view());
    expect(words).toContain("Do you agree with the agent?");
    expect(words).toContain("Agree and pay");
    expect(words).toContain("Disagree");
    expect(words).not.toContain("Approve and pay");
    expect(words).not.toContain("Return to agent");
  });

  it("says the verdict once given, and keeps the card's own actions for what is still held", () => {
    const words = card(view({ given: { verdict: "agree", reason: null }, open: false }));
    expect(words).toContain("You agreed.");
    expect(words).toContain("Approve and pay");
  });

  it("keeps the card's own actions where no verdict is shown", () => {
    expect(card()).toContain("Approve and pay");
  });
});

describe("ApprovalCard in shadow mode, for someone who may not pay it (shadow mode review I2)", () => {
  it("offers the person who entered the bill Agree alone, saying why", () => {
    const words = text(
      html(<ApprovalCard orgSlug="acme" payable={{ ...payable, createdBy: VIEWER }} canDecide viewerId={VIEWER} sandbox={false} verdict={view()} />)
    );
    expect(words).toContain("You created this invoice: Agree records your verdict, and another person pays it in Approvals.");
    expect(words).not.toContain("Agree and pay");
  });
});
