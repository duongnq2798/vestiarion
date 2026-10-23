import type { Metadata } from "next";
import Link from "next/link";
import { dismissChecklistAction } from "@/app/actions/onboarding";
import { AccountantConsole } from "@/components/accountant/AccountantConsole";
import { ClientLinks } from "@/components/accountant/ClientLinks";
import { DocsLink } from "@/components/DocsLink";
import { AccountMenu } from "@/components/vx/AccountMenu";
import { ChecklistVisit } from "@/components/vx/ChecklistVisit";
import { GettingStarted } from "@/components/vx/GettingStarted";
import { SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import { readPortfolio } from "@/lib/accountant/read";
import { triageFilter } from "@/lib/accountant/triage";
import { membershipsOf } from "@/lib/auth/membership";
import { verifySession } from "@/lib/auth/session";
import { readAccountantOnboarding } from "@/lib/onboarding/accountant";
import { listClientLinks, mayInviteClients } from "@/lib/platform/client-links";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Accountant console", robots: { index: false, follow: false } };

/**
 * The accountant console (docs/superpowers/specs/2026-10-13-accountant-console-design.md): every workspace the
 * signed-in person is a member of, and one queue of what needs attention across them. The session is checked here, and
 * the workspaces are the person's own memberships, read afresh on this request; each workspace's items are read in its
 * own scope, as this person (`readPortfolio`). A workspace someone was removed from is gone on the next load.
 *
 * Someone who keeps the books of a workspace (the accountant role) also sees their checklist here, where an invitation
 * lands them (onboarding by role R3, R6): this page open is its first step, read in each such workspace as them, and
 * recorded there once the page is in the browser (`ChecklistVisit`), never while it renders. "Don't show again" records
 * the dismissal in the workspace its steps open, and it stays dismissed here.
 *
 * Someone who is an accountant in at least one workspace also gets Invite a client, their client invite links
 * (docs/superpowers/specs/2026-10-23-accountant-client-links-design.md AC1), read by their own user id, and the
 * checklist's optional step for it (AC6). Before migration 0143 runs, it says the feature is not available yet.
 */
export default async function AccountantPage({ searchParams }: { searchParams: Promise<{ kind?: string | string[]; workspace?: string | string[]; mine?: string | string[] }> }) {
  const user = await verifySession("/accountant");
  const now = new Date();
  const [portfolio, query, memberships] = await Promise.all([readPortfolio(user.id, now), searchParams, membershipsOf(user.id)]);
  const filter = triageFilter(query);
  // A read that fails says the links are not available, as before the migration: the console still shows.
  const clientLinks = mayInviteClients(memberships)
    ? await listClientLinks(user.id, memberships, now).catch((error: unknown) => {
        console.error("accountant console: client links not read", error instanceof Error ? error.message : "unknown error");
        return { available: false, links: [], everUsed: false };
      })
    : null;
  const onboarding = await readAccountantOnboarding(user.id, memberships, portfolio, filter.workspace, clientLinks?.available ? clientLinks.everUsed : undefined);

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader width="wide">
        <SiteHeaderLink href="/onboarding?new">Workspaces</SiteHeaderLink>
        <SiteHeaderLink href="/docs">Docs</SiteHeaderLink>
        <AccountMenu email={user.email} placement="header" />
      </SiteHeader>
      <main id="main" className="mx-auto w-full max-w-[88rem] flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl space-y-2">
            <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em] text-ink">Accountant console</h1>
            <p className="text-[0.9375rem] leading-relaxed text-ink-2">
              Every workspace you are a member of, and what needs attention in each: payments waiting for a decision, bills to co-sign, addresses to
              confirm, payments to book, receivables to follow up and connectors to fix. Amounts stay with their own workspace and currency; nothing here
              is added up.
            </p>
          </div>
          <DocsLink href="/docs/guides/accountants" topic="the accountant console" />
        </div>
        {onboarding && (
          <GettingStarted
            slug={onboarding.slug}
            checklist={onboarding.checklist}
            isOwner={false}
            dismiss={onboarding.canDismiss ? dismissChecklistAction : undefined}
          />
        )}
        {onboarding && onboarding.unrecorded.length > 0 && <ChecklistVisit page="accountant" slugs={onboarding.unrecorded} queue={filter.workspace} />}
        <AccountantConsole portfolio={portfolio} now={now} filter={filter} />
        {clientLinks && (
          <div className="mt-10">
            <ClientLinks available={clientLinks.available} links={clientLinks.links} />
          </div>
        )}
        <p className="mt-10 text-xs text-ink-3">
          Only workspaces you are a member of are listed, read with your role in each. To be added to another, ask its owner or an admin to invite you
          from its <span className="font-medium">Members</span> page{clientLinks ? ", or send a new client a link from Invite a client" : ""}.{" "}
          <Link href="/onboarding?new" className="font-medium text-agent underline-offset-2 hover:underline">All your workspaces</Link>
        </p>
      </main>
      <SiteFooter compact />
    </div>
  );
}
