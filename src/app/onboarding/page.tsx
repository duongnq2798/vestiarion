import type { Metadata } from "next";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import AcceptInvitationByIdForm from "@/components/AcceptInvitationByIdForm";
import CreateWorkspaceForm from "@/components/CreateWorkspaceForm";
import { Avatar } from "@/components/ui/Avatar";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { AccountMenu } from "@/components/vx/AccountMenu";
import { SITE_COLUMN, SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import { WorkspaceMeta } from "@/components/vx/WorkspaceMeta";
import { HOME_PATH } from "@/components/vx/nav";
import { membershipsOf } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { verifySession } from "@/lib/auth/session";
import { currentConfig } from "@/lib/context";
import { mayUseMainnet } from "@/lib/mainnet";
import { pendingInvitationsFor } from "@/lib/platform/members";

export const metadata: Metadata = { title: "Workspaces" };

type OnboardingPageProps = {
  searchParams: Promise<{ new?: string | string[] }>;
};

const expiresFormat = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Where a signed-in person lands, and where they create a workspace. Signing
 * in sends people here by default, so one workspace still goes straight in;
 * `?new`, which the workspace switcher links to, stays here to list workspaces
 * and create another. Several: choose. None: create the first.
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
  if (memberships.length === 1 && query.new === undefined && invitations.length === 0) {
    redirect(orgHref(memberships[0].slug, HOME_PATH));
  }
  // Arc mainnet is offered only to a person on the deployment's allowlist while it is on (mainnet go-live M1, M2).
  const mainnetOffered = mayUseMainnet(user.email, currentConfig());

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader width="column">
        <SiteHeaderLink href="/docs">Docs</SiteHeaderLink>
        <AccountMenu email={user.email} placement="header" />
      </SiteHeader>
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className={cn("w-full", SITE_COLUMN)}>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">{memberships.length ? "Choose a workspace" : "No workspace yet"}</h1>
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
              <p className="mt-2 text-sm text-ink-3">Pick one to open. You can switch at any time from the navigation.</p>
              <ul className="mt-6 space-y-2">
                {memberships.map((membership) => (
                  <li key={membership.orgId}>
                    <Card asChild interactive>
                      <Link href={orgHref(membership.slug, HOME_PATH)} className="group flex items-center gap-3 px-4 py-3 text-ink">
                        <Avatar name={membership.name} tone="agent" shape="square" size="lg" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{membership.name}</span>
                          <WorkspaceMeta mode={membership.mode} network={membership.network} role={membership.role} className="mt-0.5" />
                        </span>
                        <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-3 transition-transform duration-150 ease-standard group-hover:translate-x-0.5 group-hover:text-agent" />
                      </Link>
                    </Card>
                  </li>
                ))}
              </ul>
              <h2 id="create-workspace" className="mt-10 scroll-mt-24 text-lg font-semibold text-ink">
                Create another workspace
              </h2>
              <div className="mt-4">
                <CreateWorkspaceForm mainnetOffered={mainnetOffered} />
              </div>
            </>
          ) : (
            <>
              <p className="mt-3 text-sm leading-relaxed text-ink-3">Create a workspace to run Vestiarion. An owner adds a wallet from Settings, and the agent pays from it. A teammate can also invite you to theirs.</p>
              <div id="create-workspace" className="mt-6 scroll-mt-24">
                <CreateWorkspaceForm mainnetOffered={mainnetOffered} />
              </div>
            </>
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
