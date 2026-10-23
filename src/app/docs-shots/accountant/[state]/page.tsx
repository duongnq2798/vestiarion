import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountantConsole } from "@/components/accountant/AccountantConsole";
import MembersPanel from "@/components/MembersPanel";
import UsagePanel from "@/components/UsagePanel";
import { cn } from "@/components/ui/cn";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { AccountMenu } from "@/components/vx/AccountMenu";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { PageHead } from "@/components/vx/Shell";
import { SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import { sectionTitle } from "@/components/vx/nav";
import { triageFilter } from "@/lib/accountant/triage";
import { canAssignRole, ORG_ROLES } from "@/lib/auth/roles";
import {
  ACCOUNTANT_EMAIL,
  ACCOUNTANT_INVITATIONS,
  ACCOUNTANT_LIMITS,
  ACCOUNTANT_MEMBERS,
  ACCOUNTANT_NOW,
  ACCOUNTANT_PORTFOLIO,
  ACCOUNTANT_USAGE,
} from "../../accountant-fixture";

/**
 * The accountant console, a workspace's usage and the invitation with the accountant role, with sample data, for the
 * partner's review of docs/superpowers/specs/2026-10-13-accountant-console-design.md
 * (`docs/superpowers/specs/accountant-console-shots/`). Built by the pages' own components; a form sent from here
 * reaches no workspace, as no slug here is one. Like /docs-shots, it answers only where `DOCS_SCREENSHOTS=1` is set,
 * read per request: everywhere else, a 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Accountant console states", robots: { index: false, follow: false } };

const STATES = ["console", "console-mine", "usage", "invite"] as const;
type State = (typeof STATES)[number];

export default async function AccountantStatePage({ params }: { params: Promise<{ state: string }> }) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { state } = await params;
  if (!(STATES as readonly string[]).includes(state)) notFound();
  const shown = state as State;

  if (shown === "console" || shown === "console-mine") {
    return (
      <div className="flex min-h-dvh flex-col" data-accountant-state={shown}>
        <SiteHeader width="wide">
          <SiteHeaderLink href="/onboarding?new">Workspaces</SiteHeaderLink>
          <SiteHeaderLink href="/docs">Docs</SiteHeaderLink>
          <AccountMenu email={ACCOUNTANT_EMAIL} placement="header" />
        </SiteHeader>
        <main id="main" className="mx-auto w-full max-w-[88rem] flex-1 px-4 py-8 sm:px-6 sm:py-12">
          <div className="mb-8 max-w-2xl space-y-2">
            <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em] text-ink">Accountant console</h1>
            <p className="text-[0.9375rem] leading-relaxed text-ink-2">
              Every workspace you are a member of, and what needs attention in each: payments waiting for a decision, bills to co-sign, addresses to
              confirm, payments to book, receivables to follow up and connectors to fix. Amounts stay with their own workspace and currency; nothing here
              is added up.
            </p>
          </div>
          <AccountantConsole portfolio={ACCOUNTANT_PORTFOLIO} now={ACCOUNTANT_NOW} filter={triageFilter(shown === "console-mine" ? { mine: "1" } : {})} />
        </main>
        <SiteFooter compact />
      </div>
    );
  }

  return (
    <MotionProvider>
      <main id="main" data-accountant-state={shown} className="min-h-dvh bg-ground">
        <div className={cn(CONTENT_FRAME, "pb-10 pt-6")}>
          {shown === "usage" ? (
            <>
              <PageHead title={sectionTitle("settings")} sub="This workspace's settings: notifications, going live, usage, developers and integrations." />
              <UsagePanel orgSlug="northstar-studio" usage={ACCOUNTANT_USAGE} limits={ACCOUNTANT_LIMITS} />
            </>
          ) : (
            <>
              <PageHead
                title={sectionTitle("members")}
                sub="Everyone in this workspace, and the invitations still open. Anyone may leave on their own; an owner or admin invites, changes roles and removes."
              />
              <MembersPanel
                orgSlug="northstar-studio"
                members={ACCOUNTANT_MEMBERS}
                invitations={ACCOUNTANT_INVITATIONS}
                viewerId="shot-owner"
                viewerRole="owner"
                assignable={ORG_ROLES.filter((role) => canAssignRole("owner", role))}
                inviteRole="accountant"
              />
            </>
          )}
        </div>
      </main>
    </MotionProvider>
  );
}
