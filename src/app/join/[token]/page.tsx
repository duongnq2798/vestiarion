import type { Metadata } from "next";
import { CloudOff, Unlink } from "lucide-react";
import Link from "next/link";
import JoinFromClientLinkForm from "@/components/JoinFromClientLinkForm";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { ROLE_SUMMARIES } from "@/lib/auth/roles";
import { verifySession } from "@/lib/auth/session";
import { clientLinkPreview, JOIN_REFUSALS, joinView, type JoinView } from "@/lib/platform/client-links";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Open your workspace", robots: { index: false, follow: false } };

type JoinPageProps = {
  params: Promise<{ token: string }>;
};

/**
 * Where an accountant's client link opens (docs/superpowers/specs/2026-10-23-accountant-client-links-design.md AC2). The
 * session gate runs first, as for an invitation: a signed-out visitor is sent to `/login?next=/join/<token>` and lands
 * back here, so nothing about the link shows before sign-in. Reading it has no side effect: the workspace is made only
 * once the client submits `JoinFromClientLinkForm`, which posts to `src/app/join/actions.ts`.
 *
 * An open link names the accountant by the address they sign in with, says what an accountant may do, and asks for a
 * name and an explicit consent. A link bound to another address, the accountant's own, and an expired, used or revoked
 * one show one sentence and offer nothing. Before migration 0143 runs, it says the feature is not available yet.
 */
export default async function JoinPage({ params }: JoinPageProps) {
  const { token } = await params;
  const user = await verifySession(`/join/${token}`);
  let view: JoinView | null = null;
  try {
    view = joinView(await clientLinkPreview(token), user);
  } catch {
    console.error("client link preview failed");
  }
  const workspaces = (
    <Button asChild variant="secondary">
      <Link href="/onboarding">Your workspaces</Link>
    </Button>
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-lg">
          {!view ? (
            <EmptyState icon={<CloudOff />} titleAs="h1" title="This page could not load. Try again in a moment." action={workspaces} />
          ) : view.kind !== "open" ? (
            <EmptyState icon={<Unlink />} titleAs="h1" title={JOIN_REFUSALS[view.kind]} action={workspaces} />
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">
                <strong className="font-semibold break-all">{view.accountantEmail}</strong>
                {" invites you to keep your books in Vestiarion."}
              </h1>
              <p className="mt-4 text-[0.9375rem] text-ink-2">They will be your workspace&apos;s accountant:</p>
              <Card className="mt-2 p-4">
                <p className="text-sm text-ink">{ROLE_SUMMARIES.accountant}</p>
              </Card>
              <div className="mt-6">
                <JoinFromClientLinkForm token={token} accountantEmail={view.accountantEmail} />
              </div>
              {user.email && <p className="mt-4 text-sm text-ink-3">Signed in as {user.email}.</p>}
            </>
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
