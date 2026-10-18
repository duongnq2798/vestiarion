import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { weeklyBriefEmail, type WeeklyBriefFacts } from "@/lib/email/weekly-brief";
import { INVITE_LATER_COOKIE, inviteHref, inviteLaterCookie, inviteNudgeShown, isInviteVia } from "@/lib/invite-nudge";

/**
 * Bring in a second person (docs/superpowers/specs/2026-10-19-invite-nudge-design.md I1-I6): when Treasury asks an owner
 * or admin who runs a workspace alone to invite an approver or an accountant; the card, its two invitations through the
 * usual action marked as the card's, and Not now; the weekly brief's line and its link to Members; Members starting the
 * form on the role and marking the invitation as the brief's.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/app/actions/members", () => ({ inviteMemberAction: vi.fn(), changeMemberRoleAction: vi.fn(), removeMemberAction: vi.fn(), revokeInvitationAction: vi.fn() }));

const { InviteNudge, APPROVER_REASON } = await import("@/components/vx/InviteNudge");
const { default: MembersPanel } = await import("@/components/MembersPanel");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;/g, "'").replace(/\s+/g, " ");

describe("when the card shows", () => {
  const alone = { canManage: true, members: 1, openInvitations: 0, decidedCount: 1, putOff: false };

  it("shows to whoever may invite, once the agent decided a real bill, while one person runs it with no invitation open", () => {
    expect(inviteNudgeShown(alone)).toBe(true);
    expect(inviteNudgeShown({ ...alone, canManage: false })).toBe(false);
    expect(inviteNudgeShown({ ...alone, members: 2 })).toBe(false);
    expect(inviteNudgeShown({ ...alone, openInvitations: 1 })).toBe(false);
    expect(inviteNudgeShown({ ...alone, decidedCount: 0 })).toBe(false);
    expect(inviteNudgeShown({ ...alone, putOff: true })).toBe(false);
  });

  it("is put off for 30 days on the workspace's own path, and links Members with the role and where it came from", () => {
    expect(inviteLaterCookie("pinecrest", true)).toBe(`${INVITE_LATER_COOKIE}=1; Max-Age=2592000; Path=/o/pinecrest; SameSite=Lax; Secure`);
    expect(inviteLaterCookie("pinecrest", false)).not.toContain("Secure");
    expect(inviteHref("pinecrest", "approver", "weekly_brief")).toBe("/o/pinecrest/members?invite=approver&via=weekly_brief");
    expect(isInviteVia("console_nudge")).toBe(true);
    expect(isInviteVia("anything")).toBe(false);
  });
});

describe("the card", () => {
  it("asks for an approver and an accountant, each through the usual invitation marked as the card's", () => {
    const html = renderToStaticMarkup(<InviteNudge orgSlug="pinecrest" shown />);
    const words = text(html);
    expect(words).toContain("Bring in a second person");
    expect(words).toContain("You run this workspace alone.");
    expect(words).toContain(`An approver ${APPROVER_REASON}`);
    expect(words).toContain("Your accountant Reads everything, books payments in Xero");
    expect(words).toContain("Not now");
    expect(html.match(/name="via" value="console_nudge"/g)).toHaveLength(2);
    expect(html).toContain('name="role" value="approver"');
    expect(html).toContain('name="role" value="accountant"');
  });

  it("shows nothing when it should not, while staying in place for an invitation just sent", () => {
    expect(renderToStaticMarkup(<InviteNudge orgSlug="pinecrest" shown={false} />)).toBe("");
  });

  it("is on Treasury for whoever may invite, with the members read only for them", () => {
    const page = readFileSync("src/app/o/[slug]/console/page.tsx", "utf8");
    expect(page).toContain('const canInvite = can(role, "members.manage");');
    expect(page).toContain("{canInvite && <InviteNudge orgSlug={slug} shown={nudgeShown} />}");
  });
});

describe("Members, opened from the weekly brief", () => {
  const props = {
    orgSlug: "pinecrest",
    members: [{ userId: "u1", email: "owner@example.com", role: "owner" as const, joinedAt: "2026-10-01T00:00:00Z" }],
    invitations: [],
    viewerId: "u1",
    viewerRole: "owner" as const,
    assignable: ["owner", "admin", "approver", "accountant", "viewer"] as const,
  };

  it("starts the form on the role and marks the invitation as the brief's", () => {
    const html = renderToStaticMarkup(<MembersPanel {...props} inviteRole="approver" inviteVia="weekly_brief" />);
    expect(html).toContain('name="via" value="weekly_brief"');
    expect(text(html)).toContain("approver: Decides the payments the agent held");
  });

  it("marks nothing when opened any other way", () => {
    expect(renderToStaticMarkup(<MembersPanel {...props} />)).not.toContain('name="via"');
  });
});

describe("the weekly brief", () => {
  const facts: WeeklyBriefFacts = {
    week: "2026-W42",
    from: "2026-10-12",
    to: "2026-10-18",
    paid: { count: 1, usdc: 45 },
    received: { count: 0, usdc: 0 },
    decisions: 2,
    waiting: 0,
    next7: { count: 0, usdc: 0, expectedUsdc: 0, lines: [] },
    cash: { operating: 93.03, reserve: 0, short: null },
    shadow: null,
  };
  const links = { console: "https://www.vestiarion.xyz/o/pinecrest/console", approvals: "https://www.vestiarion.xyz/o/pinecrest/approvals", plan: "https://www.vestiarion.xyz/o/pinecrest/invoices?tab=plan" };

  it("asks a workspace run by one person to invite its approver or accountant, linking Members", () => {
    const invite = "https://www.vestiarion.xyz/o/pinecrest/members?invite=approver&via=weekly_brief";
    const email = weeklyBriefEmail({ orgName: "Pinecrest", facts, links: { ...links, invite }, origin: "https://www.vestiarion.xyz" });
    expect(email.text).toContain(`You run Pinecrest alone on Vestiarion. Invite your approver or your accountant: ${invite}`);
    expect(email.html).toContain("You run Pinecrest alone on Vestiarion. Invite your approver or your accountant:");
    expect(email.html).toContain(`href="${invite.replace("&", "&amp;")}"`);
  });

  it("says nothing of it otherwise", () => {
    const email = weeklyBriefEmail({ orgName: "Pinecrest", facts, links, origin: "https://www.vestiarion.xyz" });
    expect(email.text).not.toContain("alone on Vestiarion");
    expect(email.html).not.toContain("alone on Vestiarion");
  });
});
