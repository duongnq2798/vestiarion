import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HeldMilestoneActions, OWN_MILESTONE_NOTE, payNowDescription } from "@/components/HeldMilestoneActions";
import type { HeldReason } from "@/lib/agent/milestone-decisions";
import { onlyApproverOfTwo } from "@/lib/two-approvals";

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

describe("the Pay now confirmation (payment safety R4)", () => {
  it("says a transfer Circle never answered is looked for on Circle first, and sent only once Circle shows none", () => {
    expect(payNowDescription("unknown")).toBe("Vestiarion looks for the earlier transfer on Circle first: it records it if Circle has it, and sends the payment only once Circle shows none. The ledger records who approved it.");
  });

  it("keeps what it said for a transfer to record, one Circle failed, and a first send", () => {
    expect(payNowDescription("in_flight")).toBe("Nothing new is sent: Vestiarion checks the transfer already made with Circle, and the ledger records who approved it.");
    expect(payNowDescription("transfer_failed")).toBe("A new transfer starts as soon as you confirm, and the ledger records who approved it.");
    expect(payNowDescription("agent_held")).toBe("The transfer starts as soon as you confirm, and the ledger records who approved it.");
  });
});

describe("HeldMilestoneActions above the figure for two approvals (two approvals T8)", () => {
  const VIEWER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e5";
  const OTHER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d4";
  const AT = "2026-10-05T08:00:00.000Z";
  const HELD_FOR_TWO: HeldReason = {
    kind: "two_approvals",
    hint: "Needs two approvals",
    text: "Payments above 0.2 USDC need two approvals in this workspace. The first Pay now records an approval and sends nothing; another person's Pay now pays it.",
    link: null,
    canPay: true,
    canClose: true,
    override: true,
  };
  const renderTwo = (approvals: Array<{ by: string; at: string }>, options: { selfAdded?: boolean; soleApprover?: boolean; fewApprovers?: boolean } = {}) =>
    renderToStaticMarkup(
      <HeldMilestoneActions
        orgSlug="testnet-2"
        milestone={MILESTONE}
        reason={HELD_FOR_TWO}
        canDecide
        selfAdded={options.selfAdded ?? false}
        sandbox={false}
        soleApprover={options.soleApprover ?? false}
        viewerId={VIEWER}
        twoApprovals={{ above: 0.2, approvals, fewApprovers: options.fewApprovers ?? false }}
        memberEmails={{ [OTHER]: "linh@acme.test" }}
      />
    );
  const button = (label: string, disabled: boolean) => new RegExp(`<button[^>]*${disabled ? 'disabled=""' : ""}[^>]*>(?:(?!</button>).)*>${label}</button>`);

  it("offers Approve until another person approved it, then Pay now, saying who did", () => {
    const first = renderTwo([]);
    expect(text(first)).toContain("Payments above 0.2 USDC need two approvals. No one has approved it yet.");
    expect(first).toMatch(button("Approve", false));
    const second = renderTwo([{ by: OTHER, at: AT }]);
    expect(text(second)).toContain("linh@acme.test approved it on Oct 5, 2026, 08:00 UTC.");
    expect(second).toMatch(button("Pay now", false));
  });

  it("keeps a second approval from whoever gave the first, and from whoever added it while two others can approve", () => {
    const again = renderTwo([{ by: VIEWER, at: AT }]);
    expect(again).toMatch(button("Approve", true));
    expect(text(again)).toContain("You approved it");
    const own = renderTwo([], { selfAdded: true });
    expect(own).toMatch(button("Approve", true));
    expect(text(own)).toContain("You added this milestone, so someone else must approve paying it.");
    expect(renderTwo([], { selfAdded: true, fewApprovers: true })).toMatch(button("Approve", false));
  });

  it("tells the only approver it cannot be paid as things stand, and never calls it their own to pay", () => {
    const markup = renderTwo([], { selfAdded: true, soleApprover: true, fewApprovers: true });
    expect(text(markup)).toContain(onlyApproverOfTwo(0.2));
    expect(text(markup)).not.toContain(OWN_MILESTONE_NOTE);
  });
});
