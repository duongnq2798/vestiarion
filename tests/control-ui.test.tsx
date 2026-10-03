import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApprovalCard, {
  HIGH_RISK_EXPLAINED,
  OWN_ENTRY_RECORDED,
  OWN_INVOICE_NOTE,
  payConfirmDescription,
  payConfirmTitle,
  SELF_APPROVAL_EXPLAINED,
} from "@/components/ApprovalCard";
import { agentResumes, CASH_SHORTFALL } from "@/lib/next-step";
import { WAITING_FOR_A_DECISION, WaitingPayableAction } from "@/components/WaitingPayableAction";
import { ActivityToastBody } from "@/components/AgentActivity";
import { addDetailsPrompt, addedDetailsSentence } from "@/lib/added-details";
import AgentPauseControl, { PAUSE_DIALOG_DESCRIPTION } from "@/components/AgentPauseControl";
import { AgentPausedBanner, pausedBanner } from "@/components/AgentPausedBanner";
import type { WaitingPayable } from "@/lib/agent/approvals";
import { utcDay, utcMinute } from "@/lib/copy";

/**
 * The approvals inbox, the pause control and the paused banner, as the markup
 * they render on the server (the `tests/ui-*.test.tsx` shape). The server
 * actions are stand-ins: the components only hand them to their forms.
 */

vi.mock("@/app/actions/approvals", () => ({
  approveInvoiceAction: vi.fn(),
  rejectInvoiceAction: vi.fn(),
  returnInvoiceAction: vi.fn(),
  addInvoiceDetailsAction: vi.fn(),
}));
vi.mock("@/app/actions/agent", () => ({
  pauseAgentAction: vi.fn(),
  resumeAgentAction: vi.fn(),
}));

const { pauseStateOfMock, listMembersMock } = vi.hoisted(() => ({ pauseStateOfMock: vi.fn(), listMembersMock: vi.fn() }));
vi.mock("@/lib/platform/pause", () => ({ pauseStateOf: pauseStateOfMock }));
vi.mock("@/lib/platform/members", () => ({ listMembers: listMembersMock }));

const html = (node: ReactElement) => renderToStaticMarkup(node);

/** A disabled button whose label, after its icon, is Approve and pay. */
const APPROVE_DISABLED = /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Approve and pay<\/button>/;

const VIEWER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e5";
const CREATOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1";

function payable(overrides: Partial<WaitingPayable> = {}): WaitingPayable {
  return {
    id: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f1",
    counterpartyId: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1",
    counterpartyName: "Northwind Supply",
    riskLevel: "low",
    amount: 1250,
    dueDate: "2026-10-03",
    status: "held",
    reasoning: "Above the auto-pay limit for a new vendor.",
    explanation: "Above the auto-pay limit for a new vendor.",
    decidedAt: "2026-09-29T14:05:12.345+00:00",
    createdBy: CREATOR,
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
    goodsReceived: false,
    addedSinceDecision: null,
    guardrailRule: null,
    ...overrides,
  };
}

function card(
  overrides: Partial<WaitingPayable> = {},
  props: Partial<{ canDecide: boolean; canEdit: boolean; viewerId: string; sandbox: boolean; soleApprover: boolean }> = {}
) {
  return html(
    <ApprovalCard
      orgSlug="acme"
      payable={payable(overrides)}
      canDecide={props.canDecide ?? true}
      canEdit={props.canEdit ?? false}
      viewerId={props.viewerId ?? VIEWER}
      sandbox={props.sandbox ?? false}
      soleApprover={props.soleApprover ?? false}
    />
  );
}

describe("utcMinute", () => {
  it("reads an instant to the minute, in UTC, the same on server and browser", () => {
    expect(utcMinute("2026-09-29T14:05:12.345+00:00")).toBe("Sep 29, 2026, 14:05 UTC");
    expect(utcMinute("2026-09-29T23:30:00+02:00")).toBe("Sep 29, 2026, 21:30 UTC");
    expect(utcMinute("2027-01-01T00:59:00+01:00")).toBe("Dec 31, 2026, 23:59 UTC");
  });
});

describe("utcDay", () => {
  it("reads an instant as its UTC day, with the month named", () => {
    expect(utcDay("2026-09-30T12:00:00+00:00")).toBe("Sep 30, 2026");
    expect(utcDay("2026-10-05")).toBe("Oct 5, 2026");
    expect(utcDay("2026-12-31T23:30:00-02:00")).toBe("Jan 1, 2027");
  });
});

describe("ApprovalCard", () => {
  it("shows the due date as a date, not the stored timestamp", () => {
    const markup = card({ dueDate: "2026-09-30T12:00:00+00:00" });
    expect(markup).toContain("Due Sep 30, 2026");
    expect(markup).not.toContain("T12:00:00");
  });

  it("shows where the payment goes, and posts that address with Approve and pay", () => {
    const markup = card();
    expect(markup).toContain("Pays to");
    expect(markup).toContain("0x1948aB0000000000000000000000000000c345a0");
    expect(markup).toMatch(/<input type="hidden" name="address" value="0x1948aB0000000000000000000000000000c345a0"\/>/);
  });

  it("says when the counterparty has no address, and posts an empty one", () => {
    const markup = card({ address: null });
    expect(markup).toContain("no address set");
    expect(markup).toMatch(/<input type="hidden" name="address" value=""\/>/);
  });

  it("shows the counterparty, amount, due date, status, reasoning and when the agent stopped", () => {
    const markup = card();
    expect(markup).toContain("Northwind Supply");
    expect(markup).toContain("1,250.00");
    expect(markup).toContain("Due Oct 3, 2026");
    expect(markup).toContain("Held");
    expect(markup).toContain("Above the auto-pay limit for a new vendor.");
    expect(markup).toContain("stopped Sep 29, 2026, 14:05 UTC");
  });

  it("offers the three decisions to someone who may decide", () => {
    const markup = card();
    expect(markup).toContain("Approve and pay");
    expect(markup).toContain("Reject");
    expect(markup).toContain("Return to agent");
    expect(markup).toContain('name="orgSlug" value="acme"');
    expect(markup).toContain('name="invoiceId" value="1b6c1c9e-4a4f-4a7e-9b1e-0000000000f1"');
  });

  it("shows a viewer the card without buttons", () => {
    const markup = card({}, { canDecide: false });
    expect(markup).toContain("Northwind Supply");
    expect(markup).not.toContain("Approve and pay");
    expect(markup).not.toContain("Return to agent");
    expect(markup).not.toContain("<button");
  });

  it("says a claimed row is being decided, and offers nothing", () => {
    const markup = card({ status: "processing", reviewedAt: "2026-09-29T14:05:12Z", reclaimable: false });
    expect(markup).toContain("Being decided");
    expect(markup).not.toContain("Approve and pay");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("An earlier decision did not finish");
  });

  it("offers the three decisions again on a claim that did not finish, and says so", () => {
    const markup = card({ status: "processing", reviewedAt: "2026-09-29T13:00:00Z", reclaimable: true });
    expect(markup).toContain("An earlier decision did not finish");
    expect(markup).not.toContain("Being decided by someone else right now");
    expect(markup).toContain("Approve and pay");
    expect(markup).toContain("Reject");
    expect(markup).toContain("Return to agent");
    expect(markup).not.toMatch(APPROVE_DISABLED);
  });

  it("omits the double-pay reassurance on an unfinished claim whose last attempt failed, since approving sends a new transfer instead", () => {
    const markup = card({
      status: "processing",
      reviewedAt: "2026-09-29T13:00:00Z",
      reclaimable: true,
      lastAttempt: { state: "failed", reason: "Insufficient funds" },
    });
    expect(markup).toContain("An earlier decision did not finish.");
    expect(markup).not.toContain("Approve and pay records it without paying twice.");
    expect(markup).toContain("The last payment attempt failed: Insufficient funds. Approving sends a new transfer.");
  });

  it("offers only Approve and pay when a payment was already sent, and says so", () => {
    const markup = card({ status: "processing", reclaimable: true, paymentSent: true });
    expect(markup).toContain("A payment was already sent; Approve and pay records it.");
    expect(markup).toContain("Approve and pay");
    expect(markup).not.toMatch(APPROVE_DISABLED);
    expect(markup).not.toContain("Reject");
    expect(markup).not.toContain("Return to agent");
  });

  it("does the same for a held row whose payment was already sent", () => {
    const markup = card({ status: "held", paymentSent: true });
    expect(markup).toContain("A payment was already sent; Approve and pay records it.");
    expect(markup).not.toContain("Return to agent");
  });

  it("does not mention a sent payment otherwise", () => {
    expect(card()).not.toContain("A payment was already sent");
  });

  it("says why the last payment attempt failed, and still offers all three decisions", () => {
    const markup = card({ lastAttempt: { state: "failed", reason: "Insufficient funds" } });
    expect(markup).toContain("The last payment attempt failed: Insufficient funds. Approving sends a new transfer.");
    expect(markup).toContain("Approve and pay");
    expect(markup).toContain("Reject");
    expect(markup).toContain("Return to agent");
    expect(markup).not.toMatch(APPROVE_DISABLED);
  });

  it("says approving sends nothing new after a Gateway transfer that failed, and that it may be rejected or returned once Circle says it was not minted (Gateway review I2)", () => {
    const markup = card({ lastAttempt: { state: "failed", reason: "Gateway could not mint it (out of gas)", resend: false } });
    expect(markup).toContain(
      "The last payment attempt failed: Gateway could not mint it (out of gas). Approving sends nothing new: check with Circle whether it was minted, and reject or return the invoice if it was not."
    );
    expect(markup).not.toContain("Approving sends a new transfer.");
    expect(markup).toContain("Reject");
  });

  it("says a payment still in flight can only be approved, which checks it again", () => {
    const markup = card({ lastAttempt: { state: "in_flight" } });
    expect(markup).toContain(
      "The payment is still in flight on Arc testnet. It cannot be rejected or returned until Circle settles it; approving checks it again."
    );
    expect(markup).toContain("Approve and pay");
    expect(markup).not.toMatch(APPROVE_DISABLED);
    expect(markup).not.toContain("Reject");
    expect(markup).not.toContain("Return to agent");
  });

  it("shows the in-flight line instead of the sent-payment line when a payment already sent is in flight", () => {
    const markup = card({ paymentSent: true, lastAttempt: { state: "in_flight" } });
    expect(markup).not.toContain("A payment was already sent; Approve and pay records it.");
    expect(markup).toContain("still in flight on Arc testnet");
  });

  it("does not mention a last payment attempt otherwise", () => {
    const markup = card();
    expect(markup).not.toContain("The last payment attempt failed");
    expect(markup).not.toContain("still in flight on Arc testnet");
  });

  it("offers nothing on an unfinished claim to someone who may not decide", () => {
    const markup = card({ status: "processing", reclaimable: true }, { canDecide: false });
    expect(markup).not.toContain("<button");
  });

  it("does not let the person who created the invoice pay it, and says why", () => {
    const markup = card({ createdBy: VIEWER });
    expect(markup).toContain("You created this invoice");
    expect(markup).toMatch(APPROVE_DISABLED);
  });

  it("lets the workspace's sole approver pay an invoice they entered, and says the ledger records it", () => {
    const markup = card({ createdBy: VIEWER }, { soleApprover: true });
    expect(markup).not.toContain("You created this invoice");
    expect(markup).not.toMatch(APPROVE_DISABLED);
    expect(markup.replace(/&#x27;/g, "'")).toContain(OWN_INVOICE_NOTE);
  });

  it("says nothing about a sole approver on an invoice someone else entered", () => {
    const markup = card({ createdBy: CREATOR }, { soleApprover: true });
    expect(markup.replace(/&#x27;/g, "'")).not.toContain(OWN_INVOICE_NOTE);
    expect(markup).not.toMatch(APPROVE_DISABLED);
  });

  it("still refuses a high-risk counterparty to a sole approver", () => {
    const markup = card({ createdBy: VIEWER, riskLevel: "high" }, { soleApprover: true });
    expect(markup).toContain("Screened high risk");
    expect(markup).toMatch(APPROVE_DISABLED);
    expect(markup.replace(/&#x27;/g, "'")).not.toContain(OWN_INVOICE_NOTE);
  });

  it("adds to the confirm dialog that the ledger records a sole approver's own entry", () => {
    const first = payConfirmDescription({ paymentSent: false, lastAttempt: null }, true);
    expect(first).toBe(`The transfer starts as soon as you confirm, and the ledger records who approved it. ${OWN_ENTRY_RECORDED}`);
    expect(payConfirmDescription({ paymentSent: false, lastAttempt: null })).not.toContain(OWN_ENTRY_RECORDED);
  });

  it("does not let a high-risk counterparty be paid, and says why", () => {
    const markup = card({ riskLevel: "high" });
    expect(markup).toContain("Screened high risk");
    expect(markup).toMatch(APPROVE_DISABLED);
  });

  it("leaves Approve and pay enabled otherwise", () => {
    expect(card()).not.toMatch(APPROVE_DISABLED);
  });

  it("has a live region for the result of a decision", () => {
    expect(card()).toContain('role="status"');
  });

  it("asks before paying, and says when the payment is simulated", () => {
    expect(payConfirmTitle(payable(), false)).toBe("Pay 1,250.00 USDC to Northwind Supply now?");
    expect(payConfirmTitle(payable({ currency: "EURC" }), false)).toBe("Pay 1,250.00 EURC to Northwind Supply now?");
    // A payee on another chain: where it goes, and the fee on top (CCTP payouts, review I2).
    expect(payConfirmTitle(payable({ payeeChain: "ETH-SEPOLIA", bridgeFeeUsdc: 1.854162 }), false)).toBe(
      "Pay 1,250.00 USDC to Northwind Supply on Ethereum Sepolia now? The CCTP fee, about 1.854162 USDC, comes on top."
    );
    expect(payConfirmTitle(payable({ payeeChain: "BASE-SEPOLIA", bridgeFeeUsdc: null }), false)).toBe(
      "Pay 1,250.00 USDC to Northwind Supply on Base Sepolia now? A CCTP fee comes on top."
    );
    expect(payConfirmTitle(payable(), true)).toBe("Pay 1,250.00 USDC to Northwind Supply now? (simulated)");
  });

  it("asks to pay the amount that will leave while an early-payment discount still applies, and names the discount", () => {
    const discounted = payable({ amount: 400, discount: { pct: 2, deadline: "2026-10-11T12:00:00+00:00" } });
    const before = new Date("2026-10-05T09:00:00Z");
    expect(payConfirmTitle(discounted, false, before)).toBe("Pay 392.00 USDC to Northwind Supply now? (2% discount through Oct 11, 2026)");
    expect(payConfirmTitle(discounted, true, before)).toBe("Pay 392.00 USDC to Northwind Supply now? (2% discount through Oct 11, 2026) (simulated)");
    // Through the end of the deadline's UTC day, as payInvoice applies it.
    expect(payConfirmTitle(discounted, false, new Date("2026-10-11T23:59:59Z"))).toBe(
      "Pay 392.00 USDC to Northwind Supply now? (2% discount through Oct 11, 2026)"
    );
  });

  it("asks to pay the full amount once the discount's day has passed", () => {
    const lapsed = payable({ amount: 400, discount: { pct: 2, deadline: "2026-10-11T12:00:00+00:00" } });
    expect(payConfirmTitle(lapsed, false, new Date("2026-10-12T00:00:00Z"))).toBe("Pay 400.00 USDC to Northwind Supply now?");
  });

  it("says the transfer starts as soon as you confirm, with no prior attempt to report", () => {
    expect(payConfirmDescription(payable())).toBe("The transfer starts as soon as you confirm, and the ledger records who approved it.");
  });

  it("says a new transfer starts after a failed attempt", () => {
    expect(payConfirmDescription(payable({ lastAttempt: { state: "failed", reason: "Insufficient funds" } }))).toBe(
      "A new transfer starts as soon as you confirm, and the ledger records who approved it."
    );
  });

  it("says nothing new is sent after a Gateway transfer that failed (Gateway review I2)", () => {
    expect(payConfirmDescription(payable({ lastAttempt: { state: "failed", reason: "Gateway could not mint it (out of gas)", resend: false } }))).toBe(
      "Nothing new is sent: Vestiarion checks the transfer already made with Circle, and the ledger records who approved it."
    );
  });

  it("says nothing new is sent for a transfer still in flight", () => {
    expect(payConfirmDescription(payable({ lastAttempt: { state: "in_flight" } }))).toBe(
      "Nothing new is sent: Vestiarion checks the transfer already made with Circle, and the ledger records who approved it."
    );
  });

  it("says nothing new is sent when a payment was already sent, even without a reported last attempt", () => {
    expect(payConfirmDescription(payable({ paymentSent: true }))).toBe(
      "Nothing new is sent: Vestiarion checks the transfer already made with Circle, and the ledger records who approved it."
    );
  });
});

describe("AgentPauseControl", () => {
  it("says a pause stops the agent, not the people (spec D6)", () => {
    expect(PAUSE_DIALOG_DESCRIPTION).toContain("The agent runs no cycle and moves no money until someone resumes it.");
    expect(PAUSE_DIALOG_DESCRIPTION).toContain("People can still pay or reject from Approvals.");
    expect(PAUSE_DIALOG_DESCRIPTION).not.toMatch(/^No cycle runs and no money moves/);
  });

  it("offers Pause agent while running, to someone who may pause", () => {
    const markup = html(<AgentPauseControl orgSlug="acme" paused={false} canPause canResume={false} />);
    expect(markup).toContain("Pause agent");
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).not.toContain("Resume agent");
  });

  it("renders nothing while running for someone who may not pause", () => {
    expect(html(<AgentPauseControl orgSlug="acme" paused={false} canPause={false} canResume={false} />)).toBe("");
  });

  it("offers Resume agent while paused, only to someone who may resume", () => {
    const owner = html(<AgentPauseControl orgSlug="acme" paused canPause canResume />);
    expect(owner).toContain("Resume agent");
    expect(owner).toContain('name="orgSlug" value="acme"');
    expect(owner).not.toContain("Pause agent");

    const approver = html(<AgentPauseControl orgSlug="acme" paused canPause canResume={false} />);
    expect(approver).not.toContain("Resume agent");
    expect(approver).not.toContain("Pause agent");
  });
});

describe("AgentPausedBanner", () => {
  const members = [{ userId: CREATOR, email: "ada@example.com", role: "owner" as const, joinedAt: "2026-09-01T00:00:00Z" }];

  it("says since when, by whom and why", () => {
    const markup = html(<AgentPausedBanner pause={{ pausedAt: "2026-09-29T14:05:12Z", pausedBy: CREATOR, reason: "Suspicious vendor" }} members={members} />);
    expect(markup).toContain("The agent is paused since Sep 29, 2026, 14:05 UTC by ada@example.com: Suspicious vendor");
  });

  it("loads nothing more when the agent is running", async () => {
    listMembersMock.mockClear();
    pauseStateOfMock.mockResolvedValueOnce(null);
    await expect(pausedBanner("org-1")).resolves.toBeNull();
    expect(listMembersMock).not.toHaveBeenCalled();
  });

  it("shows no banner, rather than failing the page, when the pause cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    pauseStateOfMock.mockRejectedValueOnce(new Error("connection refused"));
    await expect(pausedBanner("org-1")).resolves.toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("names the pauser as a member when the member list cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pause = { pausedAt: "2026-09-29T14:05:12Z", pausedBy: CREATOR, reason: "Incident" };
    pauseStateOfMock.mockResolvedValueOnce(pause);
    listMembersMock.mockRejectedValueOnce(new Error("connection refused"));
    const loaded = await pausedBanner("org-1");
    expect(loaded).toEqual({ pause, members: [] });
    expect(html(<AgentPausedBanner pause={loaded!.pause} members={loaded!.members} />)).toContain("by a member: Incident");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("names a pauser who has left as a member, and leaves out a missing reason", () => {
    const markup = html(<AgentPausedBanner pause={{ pausedAt: "2026-09-29T14:05:12Z", pausedBy: VIEWER, reason: null }} members={members} />);
    expect(markup).toContain("The agent is paused since Sep 29, 2026, 14:05 UTC by a member.");
  });
});

describe("the new control screens, as source", () => {
  const ROOT = process.cwd();
  const FILES = [
    "src/app/o/[slug]/approvals/page.tsx",
    "src/components/ApprovalCard.tsx",
    "src/components/AddDetailsDialog.tsx",
    "src/components/WaitingPayableAction.tsx",
    "src/components/AgentActivity.tsx",
    "src/components/AgentPauseControl.tsx",
    "src/components/AgentPausedBanner.tsx",
  ];
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

  it.each(FILES)("%s renders no raw control", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/<(button|select|textarea)\b/);
    for (const input of source.match(/<input\b[^>]*>/g) ?? []) expect(input).toContain('type="hidden"');
  });

  it.each(FILES)("%s has no colour literal", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch)\(/);
    expect(source).not.toMatch(/\b(text|bg|border|ring|fill|stroke)-(white|black|(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/);
  });

  it("Invoices tells a waiting payable's row what it needs, and gives its card what a person can do about it", () => {
    const invoices = read("src/app/o/[slug]/invoices/page.tsx");
    expect(invoices).toContain("hint: facts ? waitingHint(facts.onFile, facts.added) : undefined");
    expect(invoices).toContain("needsYou.map((decision) => row(decision, needsYouFor))");
    expect(invoices).toContain("<WaitingPayableAction");
    expect(invoices).toContain('viewerCan(slug, "approval.decide")');
  });

  it("the console's Stopped cards say what stopped each payable and where to handle it", () => {
    const console_ = read("src/app/o/[slug]/console/page.tsx");
    expect(console_).toContain("footerAction={nextStepFor(decision)}");
    // A hold for want of cash is no guardrail rule, but is explained like one (reserve cash back R4).
    expect(console_).toContain("rule={decision.guardrail?.rule ?? (decision.heldForCash ? CASH_SHORTFALL : null)}");
    expect(read("src/app/o/[slug]/invoices/page.tsx")).toContain("rule={decision.guardrail?.rule ?? (decision.heldForCash ? CASH_SHORTFALL : null)}");
  });

  it("AP / AR says which payables a running cycle is deciding", () => {
    const invoices = read("src/app/o/[slug]/invoices/page.tsx");
    expect(invoices).toContain("hasRunningCycle().catch(() => false)");
    expect(invoices).toContain("entries, { deciding })");
  });

  it("every page's frame shows the agent's live state, and a successful form tells it to watch closely", () => {
    expect(read("src/components/vx/Shell.tsx")).toContain("<AgentActivity lastCycleAt={lastCycleAt} />");
    expect(read("src/components/ui/useActionForm.ts")).toContain("window.dispatchEvent(new Event(AGENT_EXPECTED_EVENT));");
    expect(read("src/components/AgentControlsClient.tsx")).toContain("window.dispatchEvent(new Event(AGENT_EXPECTED_EVENT));");
  });

  it("a counterparty takes an address for payment notices when added, and on its row", () => {
    expect(read("src/components/intake/CounterpartyIntake.tsx")).toContain('label="Email for payment notices"');
    expect(read("src/components/intake/CounterpartyIntake.tsx")).toContain('name="noticeEmail"');
    const page = read("src/app/o/[slug]/counterparties/page.tsx");
    expect(page).toContain("Payment notices");
    expect(page).toContain("<CounterpartyNoticeEmailEdit");
  });

  it("a cycle brings cash back from the reserve before it decides today's payments, and a person can too", () => {
    const orchestrator = read("src/lib/agent/orchestrator.ts");
    expect(orchestrator.indexOf('await stage("liquidity", async () => {')).toBeGreaterThan(0);
    expect(orchestrator.indexOf('await stage("liquidity", async () => {')).toBeLessThan(orchestrator.indexOf('await stage("ap", async () => {'));
    const panel = read("src/components/UsycReservePanel.tsx");
    expect(panel).toContain("Bring cash back");
    expect(panel).toContain("status.liveAt && canManage && status.reserveBalance > 0 && <CashBackForm");
  });

  it("a cycle ends by sending the payment notices it owes", () => {
    expect(read("src/lib/agent/orchestrator.ts")).toContain('await stage("notices", async () => {');
  });

  it("a link to a counterparty's row opens the row", () => {
    expect(read("src/components/CounterpartyRow.tsx")).toContain("id={`counterparty-${counterparty.id}`}");
    expect(read("src/components/vx/ScrollToHash.tsx")).toContain("fold.open = true");
  });

  it("the console's Needs you tile links to the approvals inbox", () => {
    expect(read("src/app/o/[slug]/console/page.tsx")).toMatch(/label="Needs you"[^\n]*href=\{orgHref\(slug, "\/approvals"\)\}/);
  });

  it("the console's Needs you tile counts what needs a person, not rows someone is already deciding, but an unfinished claim again", () => {
    const console_ = read("src/app/o/[slug]/console/page.tsx");
    expect(console_).toContain('waiting.filter((payable) => payable.status !== "processing" || payable.reclaimable).length');
    expect(console_).toContain("Waiting for a person's decision");
  });

  it("the console treats an unreadable pause as not paused", () => {
    expect(read("src/app/o/[slug]/console/page.tsx")).toMatch(/pauseStateOf\(access\.membership\.orgId\)\.catch\(/);
  });

  it("the workspace layout draws the paused banner from platform data", () => {
    const layout = read("src/app/o/[slug]/layout.tsx");
    expect(layout).toContain("pausedBanner(membership.orgId)");
    expect(layout).toContain("<AgentPausedBanner");
    expect(layout).toContain("<AgentPausedBanner");
  });

  // The Approve and pay confirmation is a portalled AlertDialog (see
  // ConfirmDialog), so renderToStaticMarkup never shows its description;
  // these three strings are pinned in source instead, as payConfirmDescription
  // picks one of them.
  it("the pay confirmation says the transfer starts, with no prior attempt to report", () => {
    expect(read("src/components/ApprovalCard.tsx")).toContain("The transfer starts as soon as you confirm, and the ledger records who approved it.");
  });

  it("the pay confirmation says a new transfer starts after a failed attempt", () => {
    expect(read("src/components/ApprovalCard.tsx")).toContain("A new transfer starts as soon as you confirm, and the ledger records who approved it.");
  });

  it("the pay confirmation says nothing new is sent for a transfer already made", () => {
    expect(read("src/components/ApprovalCard.tsx")).toContain(
      "Nothing new is sent: Vestiarion checks the transfer already made with Circle, and the ledger records who approved it."
    );
  });
});

describe("adding what a held payable was missing, on its card (complete held invoice R1–R3, R6)", () => {
  it("offers Add details to an owner or admin while the payable lacks a purchase order or goods received", () => {
    expect(card({ poReference: null, goodsReceived: false }, { canEdit: true })).toContain("Add details");
    expect(card({ poReference: "PO-7", goodsReceived: false }, { canEdit: true })).toContain("Add details");
    expect(card({ poReference: null, goodsReceived: true }, { canEdit: true })).toContain("Add details");
  });

  it("does not offer it to an approver, who decides payments but does not enter invoices", () => {
    const markup = card({}, { canEdit: false });
    expect(markup).toContain("Approve and pay");
    expect(markup).not.toContain("Add details");
  });

  it("does not offer it once both are on file", () => {
    expect(card({ poReference: "PO-7", goodsReceived: true }, { canEdit: true })).not.toContain("Add details");
  });

  it.each([
    ["a payment was already sent", { paymentSent: true }],
    ["a payment is in flight", { lastAttempt: { state: "in_flight" } as const }],
    ["an earlier decision did not finish", { status: "processing" as const, reviewedAt: "2026-09-29T13:00:00Z", reclaimable: true }],
  ])("does not offer it when %s", (_label, overrides: Partial<WaitingPayable>) => {
    expect(card(overrides, { canEdit: true })).not.toContain("Add details");
  });

  it("says what was added since the agent stopped it, and that the agent decides it again", () => {
    const added = { poReference: "PO-100", goodsReceived: true as const };
    const markup = card({ poReference: "PO-100", goodsReceived: true, addedSinceDecision: added }, { canEdit: true });
    expect(markup).toContain(addedDetailsSentence(added));
    expect(markup).not.toContain("Add details");
  });

  it("says nothing of the kind when nothing was added", () => {
    expect(card({}, { canEdit: true })).not.toContain("Since the agent stopped it");
  });
});

describe("a payable waiting for a person, on its card on Invoices (complete held invoice)", () => {
  const ID = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f1";
  const action = (
    facts: { poReference: string | null; goodsReceived: boolean },
    props: Partial<{ added: { poReference?: string; goodsReceived?: true } | null; canAddDetails: boolean; canDecide: boolean }> = {}
  ) =>
    html(
      <WaitingPayableAction
        orgSlug="acme"
        invoice={{ id: ID, counterpartyName: "Jiren", ...facts }}
        added={props.added ?? null}
        canAddDetails={props.canAddDetails ?? true}
        canDecide={props.canDecide ?? true}
      />
    );
  const DECIDE_LINK = `href="/o/acme/approvals#payable-${ID}"`;
  /** As the markup escapes it. */
  const WAITING = WAITING_FOR_A_DECISION.replaceAll("'", "&#x27;");

  it("asks an owner or admin for what is missing, offers Add details right there, and opens the payable in Approvals", () => {
    const markup = action({ poReference: null, goodsReceived: false });
    expect(markup).toContain(addDetailsPrompt({ poReference: true, goodsReceived: true }));
    expect(markup).toContain("Add details");
    expect(markup).toContain("Decide in Approvals");
    expect(markup).toContain(DECIDE_LINK);
  });

  it("names only what is missing", () => {
    expect(action({ poReference: "PO-7", goodsReceived: false })).toContain("Confirm the goods or services were received, and the agent decides it again.");
    expect(action({ poReference: null, goodsReceived: true })).toContain("Add the purchase order, and the agent decides it again.");
  });

  it("sends an approver, who does not enter invoices, to Approvals", () => {
    const markup = action({ poReference: null, goodsReceived: false }, { canAddDetails: false });
    expect(markup).toContain(WAITING);
    expect(markup).not.toContain("Add details");
    expect(markup).toContain(DECIDE_LINK);
  });

  it("offers only Approvals when nothing is missing", () => {
    const markup = action({ poReference: "PO-7", goodsReceived: true });
    expect(markup).toContain(WAITING);
    expect(markup).not.toContain("Add details");
    expect(markup).toContain("Decide in Approvals");
  });

  it("says what was added until the agent decides it again, and offers Add details for what is still missing", () => {
    const added = action({ poReference: "PO-153", goodsReceived: false }, { added: { poReference: "PO-153" } });
    expect(added).toContain(addedDetailsSentence({ poReference: "PO-153" }));
    expect(added).toContain("Add details");
    const complete = action({ poReference: "PO-153", goodsReceived: true }, { added: { poReference: "PO-153", goodsReceived: true } });
    expect(complete).toContain(addedDetailsSentence({ poReference: "PO-153", goodsReceived: true }));
    expect(complete).not.toContain("Add details");
  });

  it("shows a viewer nothing to do, but still what was added", () => {
    expect(action({ poReference: null, goodsReceived: false }, { canAddDetails: false, canDecide: false })).toBe("");
    const markup = action({ poReference: "PO-153", goodsReceived: true }, { canAddDetails: false, canDecide: false, added: { poReference: "PO-153", goodsReceived: true } });
    expect(markup).toContain("Since the agent stopped it");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("Decide in Approvals");
  });

  it("says which rule stopped it and links the page that removes the cause, for an owner or admin", () => {
    const markup = html(
      <WaitingPayableAction
        orgSlug="acme"
        invoice={{ id: ID, counterpartyName: "CME", counterpartyId: "cp-1", poReference: "PO-CME-1", goodsReceived: true }}
        added={null}
        canAddDetails
        canDecide
        rule="counterparty.payment_limit"
        canFix
      />
    );
    expect(markup).toContain("It is above CME&#x27;s payment limit. Pay it in Approvals, or raise the limit.");
    expect(markup).toContain('href="/o/acme/counterparties#counterparty-cp-1"');
    expect(markup).toContain("Edit limit");
    expect(markup).toContain(DECIDE_LINK);
  });

  it("offers an approver only Approvals for a rule, and never Add details over a rule", () => {
    const markup = html(
      <WaitingPayableAction
        orgSlug="acme"
        invoice={{ id: ID, counterpartyName: "CME", counterpartyId: "cp-1", poReference: null, goodsReceived: false }}
        added={null}
        canAddDetails={false}
        canDecide
        rule="workspace.outflow_budget"
        canFix={false}
      />
    );
    expect(markup).toContain("The agent&#x27;s spending limit has no room for it.");
    expect(markup).not.toContain("Spending limit</a>");
    expect(markup).not.toContain("Add details");
    expect(markup).toContain(DECIDE_LINK);
  });

  it("says a payable held for want of cash waits for cash, and links the USYC reserve, for an owner or admin (reserve cash back R4)", () => {
    const markup = html(
      <WaitingPayableAction
        orgSlug="acme"
        invoice={{ id: ID, counterpartyName: "CME", counterpartyId: "cp-1", poReference: "PO-1", goodsReceived: true }}
        added={null}
        canAddDetails
        canDecide
        rule={CASH_SHORTFALL}
        canFix
      />
    );
    expect(markup).toContain("The operating wallet did not hold the cash it needs, and the reserve could not cover it.");
    expect(markup).toContain('href="/o/acme/settings#usyc-reserve-title"');
    expect(markup).toContain("USYC reserve");
    expect(markup).toContain(DECIDE_LINK);
    expect(markup).not.toContain("Add details");
  });

  it("explains a rule with no page to fix it, and sends the person to Approvals", () => {
    const markup = html(
      <WaitingPayableAction
        orgSlug="acme"
        invoice={{ id: ID, counterpartyName: "CME", counterpartyId: "cp-1", poReference: "PO-1", goodsReceived: true }}
        added={null}
        canAddDetails
        canDecide
        rule="bridge.fee_above_cap"
        canFix
      />
    );
    expect(markup).toContain("The payout fee is above 10% of the invoice, more than the agent pays. Pay it with the fee in Approvals, or reject it.");
    expect(markup).toContain(DECIDE_LINK);
    expect(markup).not.toContain("Add details");
  });

  it("is the card Decide in Approvals opens at, on Approvals", () => {
    expect(card()).toContain(`id="payable-${ID}"`);
  });
});

describe("why Approve and pay is off, and what to do instead (approval guidance)", () => {
  const yours = { createdBy: VIEWER, guardrailRule: "workspace.outflow_budget" };

  it("tells the person who entered the invoice who must approve it, and what happens without them", () => {
    const markup = card(yours, { canEdit: true });
    expect(markup).toContain("You entered this invoice");
    expect(markup).toContain(SELF_APPROVAL_EXPLAINED);
    expect(markup).toContain(agentResumes("workspace.outflow_budget")!);
    expect(markup).toContain('href="/o/acme/console#agent-budget"');
    expect(markup).toContain("Spending limit");
    expect(markup).toContain('href="/o/acme/members"');
    expect(markup).toContain("See who can approve");
    // The short reason stays beside the disabled button, which it describes.
    expect(markup).toContain("You created this invoice");
    expect(markup).toMatch(APPROVE_DISABLED);
  });

  it("gives an approver who entered it no fix they cannot make", () => {
    const markup = card(yours, { canEdit: false });
    expect(markup).toContain(SELF_APPROVAL_EXPLAINED);
    expect(markup).not.toContain('href="/o/acme/console#agent-budget"');
    expect(markup).toContain("See who can approve");
  });

  it("says nothing about what happens on its own when no rule stopped it", () => {
    const markup = card({ createdBy: VIEWER }, { canEdit: true });
    expect(markup).toContain(SELF_APPROVAL_EXPLAINED);
    expect(markup).not.toContain("on its own once");
  });

  it("says why a counterparty screened high risk is never paid, and where its match is reviewed", () => {
    const markup = card({ riskLevel: "high" }, { canEdit: true });
    expect(markup).toContain("Screened high risk");
    expect(markup).toContain(HIGH_RISK_EXPLAINED);
    expect(markup).toContain('href="/o/acme/counterparties#counterparty-1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1"');
  });

  it("says nothing more when the viewer may approve it", () => {
    const markup = card({}, { canEdit: true });
    expect(markup).not.toContain("You entered this invoice");
    expect(markup).not.toContain(HIGH_RISK_EXPLAINED);
  });

  it("tells the workspace's only approver they may approve what they entered, not that they may not", () => {
    const markup = card({ createdBy: VIEWER }, { soleApprover: true, canEdit: true });
    expect(markup).toContain(OWN_INVOICE_NOTE);
    expect(markup).not.toContain(SELF_APPROVAL_EXPLAINED);
  });
});

describe("a toast for what the agent decided", () => {
  it("puts its button and transaction under its words, so the words take the toast's width", () => {
    const markup = html(
      <ActivityToastBody detail="DeepSeek decided to pay it; code stopped it: the payout fee is above 10% of the invoice." action="Decide in Approvals" txHash={null} primary onAction={() => {}} />
    );
    // One column: the reason, then a row of what to do. No button beside the words.
    expect(markup).toMatch(/^<span class="mt-1 grid gap-2.5"><span>DeepSeek decided to pay it; code stopped it: the payout fee is above 10% of the invoice\.<\/span><span class="flex flex-wrap/);
    expect(markup).toContain("Decide in Approvals");
    expect(markup).not.toContain("View on Arcscan");
  });

  it("links a payment's transaction beside its quiet button", () => {
    const markup = html(<ActivityToastBody detail={null} action="How it decided" txHash={`0x${"ab".repeat(32)}`} primary={false} onAction={() => {}} />);
    expect(markup).toContain("How it decided");
    expect(markup).toContain(`href="https://testnet.arcscan.app/tx/0x${"ab".repeat(32)}"`);
    expect(markup).toContain("View on Arcscan");
  });
});

describe("addedDetailsSentence", () => {
  it("names what was added, and says the agent decides it again", () => {
    const next = "The agent decides it again at its next cycle, usually within a minute.";
    expect(addedDetailsSentence({ poReference: "PO-100", goodsReceived: true })).toBe(
      `Since the agent stopped it, the purchase order PO-100 was added and the goods were marked received. ${next}`
    );
    expect(addedDetailsSentence({ poReference: "PO-100" })).toBe(`Since the agent stopped it, the purchase order PO-100 was added. ${next}`);
    expect(addedDetailsSentence({ goodsReceived: true })).toBe(`Since the agent stopped it, the goods were marked received. ${next}`);
  });
});

describe("ApprovalCard for a EURC payable (EURC invoices design E4)", () => {
  it("shows the amount in EURC", () => {
    const markup = renderToStaticMarkup(
      <ApprovalCard orgSlug="acme" payable={payable({ currency: "EURC" })} canDecide viewerId={VIEWER} sandbox={false} />
    );
    expect(markup).toMatch(/1,250\.00<\/span><span[^>]*>EURC<\/span>/);
  });
});
