import type { Metadata } from "next";
import { CircleCheck, Clock, Unlink } from "lucide-react";
import Link from "next/link";
import AcceptInvitationForm from "@/components/AcceptInvitationForm";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { verifySession } from "@/lib/auth/session";
import { invitationPreview } from "@/lib/platform/members";

export const metadata: Metadata = { title: "Accept invitation" };

type InvitePageProps = {
  params: Promise<{ token: string }>;
};

/**
 * Where an invitation link opens. Reading it has no side effect: the
 * invitation is only accepted once the visitor submits
 * `AcceptInvitationForm`, which posts to `src/app/invite/actions.ts`. The
 * session gate runs first, so a signed-out visitor is sent to
 * `/login?next=/invite/<token>` and lands back here once signed in.
 */
export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const user = await verifySession(`/invite/${token}`);
  const invitation = await invitationPreview(token);
  const workspaces = (
    <Button asChild variant="secondary">
      <Link href="/onboarding">Your workspaces</Link>
    </Button>
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          {!invitation ? (
            <EmptyState icon={<Unlink />} titleAs="h1" title="This invitation link is not valid" action={workspaces} />
          ) : invitation.state === "used" ? (
            <EmptyState icon={<CircleCheck />} titleAs="h1" title="This invitation has already been accepted" action={workspaces} />
          ) : invitation.state === "expired" ? (
            <EmptyState icon={<Clock />} titleAs="h1" title="This invitation has expired" body="Ask for a new one." action={workspaces} />
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">
                {"You’re invited to join "}
                <strong className="font-semibold">{invitation.orgName}</strong>
                {` as ${invitation.role}.`}
              </h1>
              <div className="mt-6">
                <AcceptInvitationForm token={token} />
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
