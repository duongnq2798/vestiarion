import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppFrame } from "@/components/vx/AppFrame";
import type { WorkspaceSummary } from "@/components/vx/AppNav";
import { membershipFor, membershipsOf, requireMembership, type OrgMembership } from "@/lib/auth/membership";
import { getSessionUser } from "@/lib/auth/session";

type OrgLayoutProps = {
  children: ReactNode;
  params: Promise<{ slug: string }>;
};

const NOT_FOUND_TITLE = "Workspace not found · Vestiarion";

/**
 * Page titles read "Audit log · Acme · Vestiarion", so tabs on two workspaces
 * stay apart. That is for a member. Anyone else is answered with the
 * not-found page by the layout's own check, and gets its title: a template
 * with no `%s` replaces each page's title rather than wrapping it, so the tab
 * does not name a section of a workspace they cannot see. (Throwing here
 * instead would leave that page with no title at all.)
 */
export async function generateMetadata({ params }: Pick<OrgLayoutProps, "params">): Promise<Metadata> {
  const { slug } = await params;
  const user = await getSessionUser();
  const membership = user ? await membershipFor(user.id, slug) : null;
  if (!membership) return { title: { default: NOT_FOUND_TITLE, template: NOT_FOUND_TITLE } };
  return {
    title: {
      default: `${membership.name} · Vestiarion`,
      template: `%s · ${membership.name} · Vestiarion`,
    },
  };
}

/** What the frame shows of a membership; the organization's id stays on the server. */
function summary(membership: OrgMembership): WorkspaceSummary {
  return { slug: membership.slug, name: membership.name, mode: membership.mode, role: membership.role };
}

/**
 * Defence in depth only: in this Next version a layout does not control
 * whether its child segments render or appear in the RSC payload, so this
 * check alone would not stop a page from running. Each page under
 * `/o/[slug]` calls `requireMembership` itself before loading tenant data;
 * this call just means a request that never reaches a page (a bare fetch of
 * the layout's own boundary) is still covered.
 *
 * The navigation frame is drawn here so it persists across pages, and from
 * platform data only — the membership just checked and the viewer's other
 * memberships. No organization's own rows are read in this layout.
 */
export default async function OrgLayout({ children, params }: OrgLayoutProps) {
  const { slug } = await params;
  const { user, membership } = await requireMembership(slug);
  const memberships = await membershipsOf(user.id);

  return (
    <AppFrame workspace={summary(membership)} workspaces={memberships.map(summary)} email={user.email}>
      {children}
    </AppFrame>
  );
}
