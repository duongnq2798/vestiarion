import type { Metadata } from "next";
import { AutoRefresh } from "@/components/AutoRefresh";
import MembersPanel from "@/components/MembersPanel";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { requireMembership } from "@/lib/auth/membership";
import { can, canAssignRole, ORG_ROLES } from "@/lib/auth/roles";
import { chainModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { keyNamesForViewer } from "@/lib/member-keys";
import { activeKeyNamesByCreator } from "@/lib/platform/api-keys";
import { listMembers, listOpenInvitations } from "@/lib/platform/members";
import { stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("members") };

export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const { user, membership } = access;
    const canManage = can(membership.role, "members.manage");
    const [members, invitations, dashboardStats, keysByCreator] = await Promise.all([
      listMembers(membership.orgId),
      canManage ? listOpenInvitations(membership.orgId) : Promise.resolve([]),
      stats(),
      // Leaving or removing someone revokes the API keys they created here (migration 0069), so the confirmations name them.
      activeKeyNamesByCreator(membership.orgId),
    ]);
    const assignable = ORG_ROLES.filter((role) => canAssignRole(membership.role, role));

    return (
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("members")}
          sub="Everyone in this workspace, and the invitations still open. Anyone may leave on their own; an owner or admin invites, changes roles and removes."
        />
        {/* Someone accepting an invitation, or another admin's change, shows up without a reload:
            every 15 s while an invitation is open, every minute otherwise, and at once on return to the tab. */}
        <AutoRefresh intervalMs={invitations.length > 0 ? 15_000 : 60_000} />
        <MembersPanel
          orgSlug={slug}
          members={members}
          invitations={invitations}
          viewerId={user.id}
          viewerRole={membership.role}
          assignable={assignable}
          keyNames={keyNamesForViewer({ members, viewerId: user.id, viewerRole: membership.role, byCreator: keysByCreator })}
        />
      </ProductShell>
    );
  });
}
