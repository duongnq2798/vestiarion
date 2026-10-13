import type { Metadata } from "next";
import Link from "next/link";
import { AccountantConsole } from "@/components/accountant/AccountantConsole";
import { DocsLink } from "@/components/DocsLink";
import { AccountMenu } from "@/components/vx/AccountMenu";
import { SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import { readPortfolio } from "@/lib/accountant/read";
import { triageFilter } from "@/lib/accountant/triage";
import { verifySession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Accountant console", robots: { index: false, follow: false } };

/**
 * The accountant console (docs/superpowers/specs/2026-10-13-accountant-console-design.md): every workspace the
 * signed-in person is a member of, and one queue of what needs attention across them. The session is checked here, and
 * the workspaces are the person's own memberships, read afresh on this request; each workspace's items are read in its
 * own scope, as this person (`readPortfolio`). A workspace someone was removed from is gone on the next load.
 */
export default async function AccountantPage({ searchParams }: { searchParams: Promise<{ kind?: string | string[]; workspace?: string | string[]; mine?: string | string[] }> }) {
  const user = await verifySession("/accountant");
  const now = new Date();
  const [portfolio, query] = await Promise.all([readPortfolio(user.id, now), searchParams]);
  const filter = triageFilter(query);

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
              Every workspace you are a member of, and what needs attention in each: payments waiting for a decision, payments to book, receivables to
              follow up and connectors to fix. Amounts stay with their own workspace and currency; nothing here is added up.
            </p>
          </div>
          <DocsLink href="/docs/guides/accountants" topic="the accountant console" />
        </div>
        <AccountantConsole portfolio={portfolio} now={now} filter={filter} />
        <p className="mt-10 text-xs text-ink-3">
          Only workspaces you are a member of are listed, read with your role in each. To be added to another, ask its owner or an admin to invite you
          from its <span className="font-medium">Members</span> page. <Link href="/onboarding?new" className="font-medium text-agent underline-offset-2 hover:underline">All your workspaces</Link>
        </p>
      </main>
      <SiteFooter compact />
    </div>
  );
}
