import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApprovalCard, { payConfirmTitle } from "@/components/ApprovalCard";
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
    decidedAt: "2026-09-29T14:05:12.345+00:00",
    createdBy: CREATOR,
    reviewedAt: null,
    reclaimable: false,
    paymentSent: false,
    address: "0x1948aB0000000000000000000000000000c345a0",
    ...overrides,
  };
}

function card(overrides: Partial<WaitingPayable> = {}, props: Partial<{ canDecide: boolean; viewerId: string; sandbox: boolean }> = {}) {
  return html(<ApprovalCard orgSlug="acme" payable={payable(overrides)} canDecide={props.canDecide ?? true} viewerId={props.viewerId ?? VIEWER} sandbox={props.sandbox ?? false} />);
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

  it("offers nothing on an unfinished claim to someone who may not decide", () => {
    const markup = card({ status: "processing", reclaimable: true }, { canDecide: false });
    expect(markup).not.toContain("<button");
  });

  it("does not let the person who created the invoice pay it, and says why", () => {
    const markup = card({ createdBy: VIEWER });
    expect(markup).toContain("You created this invoice");
    expect(markup).toMatch(APPROVE_DISABLED);
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
    expect(payConfirmTitle(payable(), true)).toBe("Pay 1,250.00 USDC to Northwind Supply now? (simulated)");
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
});
