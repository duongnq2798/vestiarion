import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApprovalCard from "@/components/ApprovalCard";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { WaitingPayable } from "@/lib/agent/approvals";
import { COSIGN_BLOCKED, type CosignState } from "@/lib/cosign-state-rules";
import { cosignDescription } from "@/lib/two-approvals";

/**
 * Co-sign on the approval card (docs/superpowers/specs/2026-10-22-accountant-cosign-design.md CS8): for an accountant
 * while the workspace's accountants co-sign, on a payment above the figure only, never Approve and pay, Reject or Return;
 * once given, the card says so. Its confirmation opens in a portal, so its words are checked against the source.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/verdicts", () => ({ giveVerdictAction: vi.fn() }));
vi.mock("@/app/actions/approvals", () => ({
  approveInvoiceAction: vi.fn(),
  cosignInvoiceAction: vi.fn(),
  rejectInvoiceAction: vi.fn(),
  returnInvoiceAction: vi.fn(),
  addInvoiceDetailsAction: vi.fn(),
}));

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").trim();
const ACCOUNTANT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000ac";
const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1";

const payable: WaitingPayable = {
  id: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f1",
  counterpartyId: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1",
  counterpartyName: "Cobalt Cloud",
  riskLevel: "low",
  amount: 1250,
  dueDate: "2026-10-30",
  status: "held",
  reasoning: "Held: above the figure for two approvals.",
  explanation: "Held: above the figure for two approvals.",
  decidedAt: "2026-10-22T10:00:00.000Z",
  createdBy: OWNER,
  reviewedAt: null,
  reclaimable: false,
  paymentSent: false,
  address: "0x1948aB0000000000000000000000000000c345a0",
  lastAttempt: null,
  discount: null,
  currency: "USDC",
  payeeChain: "ARC-TESTNET",
  bridgeFeeUsdc: null,
  poReference: "PO-7",
  goodsReceived: true,
  addedSinceDecision: null,
  guardrailRule: null,
  twoApprovals: { above: 500, approvals: [], excluded: [OWNER], excludedSlots: 1, approvers: 2 },
};

const card = (over: Partial<WaitingPayable> = {}, canCosign = true, cosign?: CosignState) =>
  text(html(<ApprovalCard orgSlug="acme" payable={{ ...payable, ...over }} canDecide={false} viewerId={ACCOUNTANT} sandbox={false} canCosign={canCosign} cosign={cosign} />));

describe("Co-sign on the approval card", () => {
  it("gives a co-signing accountant Co-sign on a payment above the figure, and no way to pay, reject or return it", () => {
    const shown = card();
    expect(shown).toContain("Co-sign");
    expect(shown).not.toContain("Approve and pay");
    expect(shown).not.toContain("Reject");
    expect(shown).not.toContain("Return to agent");
  });

  it("says once they co-signed it", () => {
    const shown = card({ twoApprovals: { ...payable.twoApprovals!, approvals: [{ by: ACCOUNTANT, at: "2026-10-22T11:00:00.000Z" }] } });
    expect(shown).toContain("You co-signed it. An owner, admin or approver's Approve and pay pays it.");
  });

  it("offers nothing to an accountant while co-signing is off, or on a payment one approval pays", () => {
    expect(card({}, false)).not.toContain("Co-sign");
    expect(card({ twoApprovals: undefined })).not.toContain("Co-sign");
  });

  it("shows Co-sign only where the co-sign can be given now, as the accountant console says it (accountant queue AQ5)", () => {
    expect(card({}, true, { state: "can_cosign", above: 500, approvals: 0 })).toContain("Co-sign");
    // The page's read is what counts: no Co-sign where the approvals standing already pay it, whatever the card's facts.
    const needless = card({}, true, { state: "not_needed" });
    expect(needless).not.toContain("Co-sign");
    expect(needless).not.toContain("co-signed");
  });

  it.each(Object.values(COSIGN_BLOCKED))("shows %j in place of Co-sign where the server would refuse it", (reason) => {
    const shown = card({}, true, { state: "blocked", reason });
    expect(shown).toContain(reason);
    expect(shown).not.toContain("Co-sign");
    expect(shown).not.toContain("You co-signed it");
  });

  it("offers no Co-sign on a bill held for a shadow-mode verdict, which the server refuses with verdict_needed", () => {
    const shown = card({ heldForVerdict: true, verdictEntry: { seq: 41, ts: "2026-10-22T10:00:00.000Z" } }, true, { state: "blocked", reason: COSIGN_BLOCKED.verdict });
    expect(shown).toContain("Waiting for a verdict in shadow mode.");
    expect(shown).not.toContain("Co-sign");
  });

  it("links the address to confirm from the card", () => {
    const markup = html(
      <ApprovalCard orgSlug="acme" payable={payable} canDecide={false} viewerId={ACCOUNTANT} sandbox={false} canCosign cosign={{ state: "blocked", reason: COSIGN_BLOCKED.unconfirmed }} />
    );
    expect(text(markup)).toContain("Confirm the address first on Counterparties .");
    expect(markup).toContain(`href="/o/acme/counterparties#counterparty-${payable.counterpartyId}"`);
  });

  it("links the payee's row where it has no payment address yet, which the server refuses with no_address", () => {
    const markup = html(
      <ApprovalCard orgSlug="acme" payable={{ ...payable, address: null }} canDecide={false} viewerId={ACCOUNTANT} sandbox={false} canCosign cosign={{ state: "blocked", reason: COSIGN_BLOCKED.no_address }} />
    );
    expect(text(markup)).toContain("The payee has no payment address yet on Counterparties .");
    expect(text(markup)).not.toContain("Co-sign");
    expect(markup).toContain(`href="/o/acme/counterparties#counterparty-${payable.counterpartyId}"`);
  });

  it("says they co-signed it when the page read so", () => {
    expect(card({}, true, { state: "cosigned" })).toContain("You co-signed it. An owner, admin or approver's Approve and pay pays it.");
  });

  it("confirms what a co-sign does before it is given", () => {
    expect(cosignDescription("1,250.00 USDC", "Cobalt Cloud")).toBe(
      "This records your co-sign of 1,250.00 USDC to Cobalt Cloud and sends nothing. An owner, admin or approver's Approve and pay then pays it."
    );
    const source = readFileSync(path.join(process.cwd(), "src/components/ApprovalCard.tsx"), "utf8");
    expect(source).toContain('confirmLabel="Co-sign"');
    expect(source).toContain("title={`Co-sign ${payable.counterpartyName}'s invoice?`}");
  });
});
