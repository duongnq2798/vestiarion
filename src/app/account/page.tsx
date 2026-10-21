import type { Metadata } from "next";
import DeleteAccountPanel from "@/components/DeleteAccountPanel";
import { GROUP_LABEL } from "@/components/settings-group-label";
import { cn } from "@/components/ui/cn";
import { AccountMenu } from "@/components/vx/AccountMenu";
import { SITE_COLUMN, SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import { verifySession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your account", robots: { index: false, follow: false } };

/**
 * The account's own page (docs/superpowers/specs/2026-10-21-delete-account-in-settings-design.md DA2), where the account
 * menu's **Account settings** leads: who is signed in, and the danger zone that deletes the account. Any signed-in
 * person reaches it, with or without a workspace; the session alone decides whose account it is.
 */
export default async function AccountPage() {
  const user = await verifySession("/account");
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader width="column">
        <SiteHeaderLink href="/onboarding?new">Workspaces</SiteHeaderLink>
        <SiteHeaderLink href="/docs">Docs</SiteHeaderLink>
        <AccountMenu email={user.email} placement="header" />
      </SiteHeader>
      <main id="main" className="flex-1 px-4 py-12 sm:py-16">
        <div className={cn("mx-auto w-full", SITE_COLUMN)}>
          <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em] text-ink">Your account</h1>
          <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">
            Signed in as <span className="break-all font-medium text-ink">{user.email ?? "this account"}</span>. Your notifications in each workspace
            are in its Settings, and your role on its Members page.
          </p>
          <div role="group" aria-labelledby="account-danger-zone" className="mt-10 border-t border-line pt-10">
            <p id="account-danger-zone" className={GROUP_LABEL}>
              Danger zone
            </p>
            <div className="mt-4">
              <DeleteAccountPanel />
            </div>
          </div>
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
