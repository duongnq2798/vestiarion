import type { Metadata } from "next";
import { Clock, Unlink } from "lucide-react";
import Link from "next/link";
import { SlackConnectForm } from "@/components/SlackConnectForm";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { membershipsOf } from "@/lib/auth/membership";
import { verifySession } from "@/lib/auth/session";
import { installOfTeam } from "@/lib/slack/installs";
import { readLinkRequest } from "@/lib/slack/links";

export const metadata: Metadata = { title: "Connect Slack" };
export const dynamic = "force-dynamic";

type SlackConnectPageProps = {
  searchParams: Promise<{ code?: string | string[] }>;
};

/**
 * Where `/vestiarion connect`'s one-time link opens (docs/superpowers/specs/2026-10-03-slack-design.md S4). Reading it
 * has no side effect: the Slack account is linked only when the signed-in member presses Connect, and the page first
 * says which Slack account, which Slack workspace, and which Vestiarion workspace and role it will act as. A signed-out
 * visitor signs in and comes back here.
 */
export default async function SlackConnectPage({ searchParams }: SlackConnectPageProps) {
  const { code: raw } = await searchParams;
  const code = typeof raw === "string" ? raw : "";
  const user = await verifySession(`/integrations/slack/connect?code=${encodeURIComponent(code)}`);
  const request = await readLinkRequest(code);
  const install = request ? await installOfTeam(request.teamId) : null;
  const membership = install ? ((await membershipsOf(user.id)).find((candidate) => candidate.orgId === install.orgId) ?? null) : null;
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
          {!request ? (
            <EmptyState
              icon={<Clock />}
              titleAs="h1"
              title="This Slack link has expired or was already used"
              body="In Slack, type /vestiarion connect for a new one. It works once, for 10 minutes."
              action={workspaces}
            />
          ) : !install ? (
            <EmptyState icon={<Unlink />} titleAs="h1" title="This Slack workspace is no longer connected to Vestiarion" action={workspaces} />
          ) : !membership ? (
            <EmptyState
              icon={<Unlink />}
              titleAs="h1"
              title="You are not a member of the workspace this Slack is connected to"
              body="Sign in with the account that is a member, or ask an owner to invite you."
              action={workspaces}
            />
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Connect your Slack account</h1>
              <p className="mt-3 text-sm text-ink-2">
                The Slack account <strong className="font-semibold text-ink">{request.slackUserName ? `@${request.slackUserName}` : request.slackUserId}</strong>
                {install.teamName ? ` in ${install.teamName}` : ""} will act as you in{" "}
                <strong className="font-semibold text-ink">{membership.name}</strong>, with your role there ({membership.role}): its{" "}
                <code className="font-mono text-xs">/vestiarion</code> commands and the buttons it presses.
              </p>
              <p className="mt-2 text-sm text-ink-3">Connect only an account that is yours. You can disconnect it from Settings at any time.</p>
              <div className="mt-6">
                <SlackConnectForm orgSlug={membership.slug} code={code} />
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
