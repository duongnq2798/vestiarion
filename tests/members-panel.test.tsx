import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/members", () => ({
  changeMemberRoleAction: vi.fn(),
  inviteMemberAction: vi.fn(),
  removeMemberAction: vi.fn(),
  revokeInvitationAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));

import MembersPanel from "@/components/MembersPanel";

const MEMBERS = [{ userId: "u-1", email: "linh@example.com", role: "owner" as const, joinedAt: "2026-10-01T08:00:00Z" }];

/** Members is about people and roles: a member's own notifications live in Settings, and the page points there. */
describe("MembersPanel", () => {
  it("points to Settings for the viewer's own notifications, and holds none of them", () => {
    const markup = renderToStaticMarkup(
      <MembersPanel orgSlug="acme" members={MEMBERS} invitations={[]} viewerId="u-1" viewerRole="owner" assignable={["owner", "admin", "approver", "viewer"]} />
    );
    expect(markup).toContain('href="/o/acme/settings#notifications"');
    expect(markup).not.toContain("Email me when payments need a decision");
    expect(markup).not.toContain("Connect Telegram");
  });
});
