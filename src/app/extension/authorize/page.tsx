import type { Metadata } from "next";
import { LogIn, PlugZap, ShieldAlert, Unlink } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ExtensionConsentForm } from "@/components/extension/ExtensionConsentForm";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { membershipsOf } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { getSessionUser } from "@/lib/auth/session";
import { checkAuthorizeRequest, firstParam, redirectWith } from "@/lib/extension/authorize-request";
import { extensionSettingsFromEnv, scopeString } from "@/lib/extension/settings";

export const metadata: Metadata = { title: "Connect the Chrome extension", robots: { index: false } };
export const dynamic = "force-dynamic";

type AuthorizePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Where Vestiarion Invoice Capture's Connect opens, inside `chrome.identity.launchWebAuthFlow`
 * (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C12, C13). Reading it has no side effect: a code is
 * issued only when the signed-in person picks a workspace where they can add bills and presses Allow. A client or a
 * redirect address that is not an allowed extension's own is refused here, never redirected to.
 */
export default async function ExtensionAuthorizePage({ searchParams }: AuthorizePageProps) {
  const raw = await searchParams;
  const params = {
    response_type: firstParam(raw.response_type),
    client_id: firstParam(raw.client_id),
    redirect_uri: firstParam(raw.redirect_uri),
    code_challenge: firstParam(raw.code_challenge),
    code_challenge_method: firstParam(raw.code_challenge_method),
    state: firstParam(raw.state),
    scope: firstParam(raw.scope),
  };
  const settings = extensionSettingsFromEnv();
  const check = settings ? checkAuthorizeRequest(settings, params) : null;
  if (check?.kind === "redirect_error") redirect(check.redirectTo);

  const user = check?.kind === "ok" ? await getSessionUser() : null;
  const here = `/extension/authorize?${new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === "string")).toString()}`;
  const workspaces = user ? (await membershipsOf(user.id)).filter((membership) => can(membership.role, "records.write")) : [];

  let body;
  if (!settings) {
    body = <EmptyState icon={<Unlink />} titleAs="h1" title="Invoice capture is not set up on this deployment yet" body="Ask the person who runs it to allow the Chrome extension." />;
  } else if (!check || check.kind === "bad_client") {
    body = (
      <EmptyState
        icon={<ShieldAlert />}
        titleAs="h1"
        title="This extension cannot connect to Vestiarion"
        body="Only Vestiarion Invoice Capture can connect here. Install it from its guide, then press Connect Vestiarion in it."
        action={
          <Button asChild variant="secondary">
            <Link href="/docs/guides/invoice-capture">Read the guide</Link>
          </Button>
        }
      />
    );
  } else if (check.kind !== "ok") {
    body = null;
  } else if (!user) {
    body = (
      <EmptyState
        icon={<LogIn />}
        titleAs="h1"
        title="Sign in to connect the extension"
        body="Sign in to Vestiarion in a browser tab, then come back to this window and choose Continue. With Google, you can sign in right here."
        action={
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <a href={here}>Continue</a>
            </Button>
            <Button asChild variant="secondary">
              <Link href={`/login?next=${encodeURIComponent(here)}`}>Sign in here</Link>
            </Button>
          </div>
        }
      />
    );
  } else if (workspaces.length === 0) {
    body = (
      <EmptyState
        icon={<Unlink />}
        titleAs="h1"
        title="None of your workspaces lets you add bills"
        body="The extension sends drafts to a workspace where you are an owner or admin. Ask an owner to make you an admin there, or create your own workspace."
        action={
          <Button asChild variant="secondary">
            <a href={redirectWith(check.request.redirectUri, { error: "access_denied", state: check.request.state })}>Cancel</a>
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        <div className="flex items-center gap-3">
          <PlugZap aria-hidden className="size-6 text-agent" />
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Connect Vestiarion Invoice Capture</h1>
        </div>
        <p className="mt-3 text-sm text-ink-2">
          The Chrome extension <code className="font-mono text-xs">{check.request.clientId}</code> asks to send invoices you capture to a workspace
          as drafts, for a person to review.
        </p>
        <div className="mt-6">
          <ExtensionConsentForm
            workspaces={workspaces.map(({ slug, name, role }) => ({ slug, name, role }))}
            clientId={check.request.clientId}
            redirectUri={check.request.redirectUri}
            codeChallenge={check.request.codeChallenge}
            state={check.request.state}
            scope={scopeString(check.request.scopes)}
            cancelHref={redirectWith(check.request.redirectUri, { error: "access_denied", state: check.request.state })}
          />
        </div>
        {user.email && <p className="mt-4 text-sm text-ink-3">Signed in as {user.email}.</p>}
      </>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-xl">{body}</div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
