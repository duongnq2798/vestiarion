import type { Metadata } from "next";
import { ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import AcceptInvitationByIdForm from "@/components/AcceptInvitationByIdForm";
import CreateWorkspaceForm from "@/components/CreateWorkspaceForm";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Disclosure } from "@/components/ui/Disclosure";
import { AccountMenu } from "@/components/vx/AccountMenu";
import { SITE_COLUMN, SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import { WorkspaceMeta } from "@/components/vx/WorkspaceMeta";
import { HOME_PATH } from "@/components/vx/nav";
import { membershipsOf, type OrgMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { verifySession } from "@/lib/auth/session";
import { currentConfig } from "@/lib/context";
import { mayUseMainnet } from "@/lib/mainnet";
import { pendingInvitationsFor } from "@/lib/platform/members";
import { activeLine, byRecentActivity } from "@/lib/workspace-recency";

export const metadata: Metadata = { title: "Workspaces" };

type OnboardingPageProps = {
  searchParams: Promise<{ new?: string | string[]; create?: string | string[]; shadow?: string | string[] }>;
};

/** Past this many workspaces, the most recent lead under "Recent" and the rest follow under "Other workspaces". */
const RECENT = 3;

const expiresFormat = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Where a signed-in person lands, and where they create a workspace
 * (docs/superpowers/specs/2026-10-07-workspaces-page-design.md). Signing in
 * sends people here by default, so one workspace still goes straight in;
 * `?new`, which the workspace switcher links to, stays here to list
 * workspaces, and `?create` opens the form to create another. Someone with a
 * workspace is welcomed back to the one in use most recently, and creating
 * another waits behind a button; someone with none is welcomed and creates
 * their first. `?shadow=1`, from the landing page's "Try it on your bills",
 * ticks shadow mode on the form.
 *
 * Also where an invitation on another device, another browser, or from
 * Google sign-in, is found again: the `vx_after_sign_in` cookie
 * (src/lib/auth/after-sign-in.ts) only covers the same browser, so any open
 * invitation for this person's address is listed here too, and finding one
 * holds off the single-workspace redirect — the person came here for a
 * reason, even with one workspace already.
 */
export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const user = await verifySession("/onboarding");
  const [memberships, invitations] = await Promise.all([
    membershipsOf(user.id),
    // Best-effort: this is the default landing page after every sign-in, so a
    // failure here must not take the page down with it — the workspace list
    // below still works without it.
    pendingInvitationsFor(user.id).catch(() => {
      console.error("pending invitations unavailable");
      return [];
    }),
  ]);
  const query = await searchParams;
  const creating = query.create !== undefined;
  if (memberships.length === 1 && query.new === undefined && !creating && invitations.length === 0) {
    redirect(orgHref(memberships[0].slug, HOME_PATH));
  }
  // Arc mainnet is offered only to a person on the deployment's allowlist while it is on (mainnet go-live M1, M2).
  const mainnetOffered = mayUseMainnet(user.email, currentConfig());
  const shadowChosen = query.shadow === "1";
  const workspaces = byRecentActivity(memberships);
  const split = workspaces.length > RECENT;

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader width="column">
        <SiteHeaderLink href="/docs">Docs</SiteHeaderLink>
        <AccountMenu email={user.email} placement="header" />
      </SiteHeader>
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className={cn("w-full", SITE_COLUMN)}>
          <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em] text-ink">{memberships.length ? "Welcome back" : "Welcome to Vestiarion"}</h1>
          {invitations.length > 0 && (
            <section aria-labelledby="invitations-title" className="mt-6">
              <h2 id="invitations-title" className="text-lg font-semibold text-ink">
                Invitations for you
              </h2>
              <ul className="mt-4 space-y-2">
                {invitations.map((invitation) => (
                  <Card asChild key={invitation.invitationId} tone="agent">
                    <li className="flex items-center gap-3 px-4 py-3">
                      <Avatar name={invitation.orgName} tone="agent" shape="square" size="lg" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-ink">{invitation.orgName}</p>
                        <p className="text-xs text-ink-3">
                          Invited as <span className="capitalize">{invitation.role}</span> · expires {expiresFormat.format(new Date(invitation.expiresAt))}
                        </p>
                      </div>
                      <AcceptInvitationByIdForm invitationId={invitation.invitationId} />
                    </li>
                  </Card>
                ))}
              </ul>
            </section>
          )}
          {memberships.length ? (
            <>
              <p className="mt-2 text-[0.9375rem] text-ink-2">Choose a workspace to continue. You can switch at any time from the navigation.</p>
              {split && <h2 className="mt-8 font-mono text-xs font-semibold uppercase tracking-[0.11em] text-ink-3">Recent</h2>}
              <WorkspaceList workspaces={split ? workspaces.slice(0, RECENT) : workspaces} markFirst={workspaces.length > 1} className={split ? "mt-3" : "mt-6"} />
              {split && (
                <>
                  <h2 className="mt-8 font-mono text-xs font-semibold uppercase tracking-[0.11em] text-ink-3">Other workspaces</h2>
                  <WorkspaceList workspaces={workspaces.slice(RECENT)} className="mt-3" />
                </>
              )}
              <Disclosure
                id="create-workspace"
                variant="bare"
                defaultOpen={creating}
                className="mt-8 scroll-mt-24"
                summaryClassName="inline-flex h-10 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-sm font-medium text-ink shadow-control transition-colors duration-150 ease-standard hover:border-agent-line hover:text-agent group-open/disclosure:border-agent-line"
                summary={
                  <>
                    <Plus aria-hidden className="size-4" />
                    Create a new workspace
                  </>
                }
              >
                <div className="mt-4">
                  <CreateWorkspaceForm mainnetOffered={mainnetOffered} shadowChosen={shadowChosen} />
                </div>
              </Disclosure>
            </>
          ) : (
            <>
              <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-2">
                Create your first workspace, then add one of your bills and see what the agent decides. A teammate can also invite you to theirs.
              </p>
              <div id="create-workspace" className="mt-6 scroll-mt-24">
                <CreateWorkspaceForm mainnetOffered={mainnetOffered} shadowChosen={shadowChosen} />
              </div>
            </>
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}

/** Workspaces to open, most recent first; `markFirst` marks the first as the most recent, on the list that leads the page. */
function WorkspaceList({ workspaces, markFirst = false, className }: { workspaces: OrgMembership[]; markFirst?: boolean; className?: string }) {
  return (
    <ul className={cn("space-y-2", className)}>
      {workspaces.map((membership, index) => {
        const active = membership.lastActiveAt ? activeLine(membership.lastActiveAt) : "";
        return (
          <li key={membership.orgId}>
            <Card asChild interactive>
              <Link href={orgHref(membership.slug, HOME_PATH)} className="group flex items-center gap-3.5 px-4 py-3.5 text-ink">
                <Avatar name={membership.name} tone="agent" shape="square" size="lg" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[0.9375rem] font-medium">{membership.name}</span>
                    {markFirst && index === 0 && active && (
                      <Badge tone="agent" size="sm" className="shrink-0">
                        Most recent
                      </Badge>
                    )}
                  </span>
                  <WorkspaceMeta mode={membership.mode} network={membership.network} role={membership.role} className="mt-1" />
                  {active && <span className="mt-0.5 block text-xs text-ink-3">{active}</span>}
                </span>
                <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-3 transition-transform duration-150 ease-standard group-hover:translate-x-0.5 group-hover:text-agent" />
              </Link>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
