import type { Metadata } from "next";
import AcceptInvitationForm from "@/components/AcceptInvitationForm";
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

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          {!invitation ? (
            <p className="text-sm text-ink-3">This invitation link is not valid.</p>
          ) : invitation.state === "used" ? (
            <p className="text-sm text-ink-3">This invitation has already been accepted.</p>
          ) : invitation.state === "expired" ? (
            <p className="text-sm text-ink-3">This invitation has expired. Ask for a new one.</p>
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">
                {"You're invited to join "}
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
