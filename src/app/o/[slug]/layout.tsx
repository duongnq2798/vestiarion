import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AgentPausedBanner, pausedBy, readPause } from "@/components/AgentPausedBanner";
import { MainnetBanner } from "@/components/MainnetBanner";
import { PaymentsOffBanner } from "@/components/PaymentsOffBanner";
import { AppFrame } from "@/components/vx/AppFrame";
import { SIDEBAR_COOKIE, sidebarCollapsedFrom } from "@/components/vx/sidebar-preference";
import type { WorkspaceSummary } from "@/components/vx/workspace";
import { membershipFor, membershipsOf, requireMembership, type OrgMembership } from "@/lib/auth/membership";
import { getSessionUser } from "@/lib/auth/session";
import { currentConfig } from "@/lib/context";
import { paymentsSwitchForPages } from "@/lib/payments-switch";

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
  return { slug: membership.slug, name: membership.name, mode: membership.mode, role: membership.role, network: membership.network };
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
 *
 * The paused banner is platform data too: the pause lives on the
 * organization row, and the pauser's address comes from its member list. The
 * payments-off banner reads only the platform's switch (payment safety S5, S7).
 * The Arc mainnet banner reads the membership's network and mode, and the
 * deployment's switch (mainnet go-live M13). The same facts feed the header's
 * status chips (workspace shell design S5); the page adds its own.
 *
 * The sidebar's width comes from the viewer's `vx_sidebar` cookie, so the
 * first paint has it (workspace shell design S3).
 */
export default async function OrgLayout({ children, params }: OrgLayoutProps) {
  const { slug } = await params;
  const { user, membership } = await requireMembership(slug);
  const [memberships, pause, payments, cookieStore] = await Promise.all([membershipsOf(user.id), readPause(membership.orgId), paymentsSwitchForPages(), cookies()]);
  const paused = pause.paused;
  const mainnetEnabled = currentConfig().mainnetEnabled === true;
  const platform = {
    network: membership.network,
    mode: membership.mode,
    mainnetEnabled,
    paymentsOff: payments.off ? { reason: payments.reason ?? null } : null,
    paymentsUnread: payments.unread === true,
    pause: paused ? { since: paused.pause.pausedAt, by: pausedBy(paused.pause, paused.members), reason: paused.pause.reason ?? null } : null,
    pauseUnread: pause.unread,
  };

  return (
    <AppFrame
      workspace={summary(membership)}
      workspaces={memberships.map(summary)}
      email={user.email}
      platform={platform}
      sidebarCollapsed={sidebarCollapsedFrom(cookieStore.get(SIDEBAR_COOKIE)?.value)}
      banners={
        <>
          {membership.network === "arc-mainnet" && <MainnetBanner mode={membership.mode} enabled={mainnetEnabled} />}
          {payments.off && <PaymentsOffBanner reason={payments.reason} />}
          {paused && <AgentPausedBanner pause={paused.pause} members={paused.members} />}
        </>
      }
    >
      {children}
    </AppFrame>
  );
}
