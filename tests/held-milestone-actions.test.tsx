import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HeldMilestoneActions, OWN_MILESTONE_NOTE } from "@/components/HeldMilestoneActions";
import type { HeldReason } from "@/lib/agent/milestone-decisions";

vi.mock("@/app/actions/milestones", () => ({
  payHeldMilestoneAction: vi.fn(),
  closeMilestoneAction: vi.fn(),
}));

/**
 * A held milestone's row, opened (held milestone actions R1–R3): the sentence saying what it waits for, a link
 * to where that is settled, and Pay now and Close without paying for whoever may decide it.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const MILESTONE = { id: "m-1", title: "Clean service", amount: 0.3, contractorName: "Puka Hotel" };
const FAILED: HeldReason = {
  kind: "transfer_failed",
  hint: "Circle did not send it",
  text: "Circle did not send it: Circle could not prepare the transaction (Circle: ESTIMATION_ERROR). Nothing moved. Pay now sends it again.",
  link: null,
  canPay: true,
  canClose: true,
  override: false,
};

const render = (reason: HeldReason, options: { canDecide?: boolean; selfAdded?: boolean; soleApprover?: boolean } = {}) =>
  renderToStaticMarkup(
    <HeldMilestoneActions
      orgSlug="testnet-2"
      milestone={MILESTONE}
      reason={reason}
      canDecide={options.canDecide ?? true}
      selfAdded={options.selfAdded ?? false}
      sandbox={false}
      soleApprover={options.soleApprover ?? false}
    />
  );

describe("HeldMilestoneActions", () => {
  it("says what it waits for, and offers Pay now and Close without paying", () => {
    const markup = render(FAILED);
    expect(text(markup)).toContain("What it waits for");
    expect(text(markup)).toContain("Pay now sends it again.");
    expect(text(markup)).toContain("Pay now");
    expect(text(markup)).toContain("Close without paying");
  });

  it("links to where a block is settled, and offers no Pay now while it stands", () => {
    const markup = render({ ...FAILED, kind: "screening_limit", canPay: false, link: { label: "Counterparties", path: "/counterparties" }, text: "A screening match lowered Quoc Duong's limit." });
    expect(markup).toContain('href="/o/testnet-2/counterparties"');
    expect(text(markup)).toContain("Open Counterparties");
    expect(text(markup)).not.toMatch(/Pay now/);
    expect(text(markup)).toContain("Close without paying");
  });

  it("keeps Pay now from whoever added the milestone when it overrides the agent's hold", () => {
    const markup = render({ ...FAILED, kind: "agent_held", override: true }, { selfAdded: true });
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="pay-held-m-1-blocked"/);
    expect(text(markup)).toContain("You added this milestone, so someone else must approve paying it.");
  });

  it("lets the workspace's sole approver override the hold on a milestone they added, and says the ledger records it", () => {
    const markup = render({ ...FAILED, kind: "agent_held", override: true }, { selfAdded: true, soleApprover: true });
    expect(markup).not.toMatch(/<button[^>]*disabled=""/);
    expect(text(markup)).not.toContain("so someone else must approve paying it");
    expect(text(markup)).toContain(OWN_MILESTONE_NOTE);
  });

  it("says nothing about a sole approver when Pay now overrides nothing", () => {
    const markup = render(FAILED, { selfAdded: true, soleApprover: true });
    expect(text(markup)).not.toContain(OWN_MILESTONE_NOTE);
  });

  it("shows only the reason to someone who cannot decide it", () => {
    const markup = render(FAILED, { canDecide: false });
    expect(text(markup)).not.toContain("Close without paying");
    expect(text(markup)).toContain("An owner, admin or approver can pay it now or close it.");
  });
});
