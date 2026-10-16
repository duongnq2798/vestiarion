import { Clock, Link2, Lock } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConnectorConsent } from "@/components/ConnectorConsent";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { NativeCheckbox, NativeRadioGroup } from "@/components/ui/NativeChoice";
import { BrandMark, PROVIDER_MARKS } from "@/components/vx/BrandMarks";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { accountingProviderOn } from "@/lib/accounting-providers";
import { membershipsOf } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { verifySession } from "@/lib/auth/session";
import { CONSENT_LABEL } from "@/lib/connectors/consent";
import { PROVIDER_LABELS, PROVIDER_WORDS, type AccountingProviderId } from "@/lib/connectors/provider";
import { pendingChoice } from "@/lib/connectors/token-store";
import { withOrg } from "@/lib/dal/scope";
import { networkProfile } from "@/lib/network";

export type ConnectSearchParams = Promise<{ org?: string | string[]; choose?: string | string[]; consent?: string | string[]; error?: string | string[] }>;

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

/** What each tool brings in, at the top of its connect page. */
const INTRO: Record<AccountingProviderId, string> = {
  xero: "Bring your approved bills in from Xero. Each one waits for you on Bills & receivables and becomes a payable only when you add it.",
  quickbooks: "Bring your open bills in from QuickBooks Online. Each one waits for you on Bills & receivables and becomes a payable only when you add it.",
  zohobooks: "Bring your open bills in from Zoho Books. Each one waits for you on Bills & receivables and becomes a payable only when you add it.",
};

/** What happens at the tool, for a tool whose grant is for one organisation it asks the person to pick (QuickBooks, Q4, Q5). */
const AT_THE_TOOL: Partial<Record<AccountingProviderId, string>> = {
  quickbooks: "QuickBooks asks you to sign in and pick the company to connect. A company connects to one Vestiarion workspace at a time.",
  zohobooks: "Zoho asks you to sign in in your own data center and allow Vestiarion to read. If you have several organizations, you pick one here next.",
};

/**
 * What becomes of the organisations not picked, after a tool that authorized several: Xero's grant stays on each until the
 * person removes it there (X4); a Zoho token reaches every organization of the account, and Vestiarion reads only the
 * one picked (Zoho Books connector Z5).
 */
const OTHERS: Partial<Record<AccountingProviderId, string>> = {
  xero: "The others stay authorised in Xero until you remove them there, under Settings, Connected apps.",
  zohobooks: "Vestiarion reads only the one you pick.",
};

/** "an organisation", "a company". */
const withArticle = (noun: string) => `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;

function errors(label: string, organisation: string): Record<string, string> {
  return {
    forbidden: `Only an owner or admin of a workspace connects ${label} to it.`,
    not_set_up: `${label} is not set up on this deployment yet.`,
    expired: `The time to pick ${withArticle(organisation)} ran out. Start again.`,
    pick: `Pick one of the ${organisation}s ${label} listed.`,
  };
}

/**
 * Connecting an accounting tool (docs/superpowers/specs/2026-10-12-xero-connector-design.md X4, X12;
 * docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q4, Q13, QuickBooks' Connect/Reconnect URL).
 * Reading this page has no side effect. The person picks the workspace, among those they may manage integrations for
 * (the one a Settings card names in `?org=`, or the only one, picked already), reads what Vestiarion does with the
 * tool's data and ticks I agree; Continue posts to the connect route, which checks all of it again. The choices are
 * real inputs with labels, so the form works as soon as the page is there. After a tool that authorized several
 * organisations (Xero), the person picks one here, from the pending grant only they can read.
 */
export async function AccountingConnect({ provider, searchParams }: { provider: AccountingProviderId; searchParams: ConnectSearchParams }) {
  const params = await searchParams;
  const org = one(params.org);
  const choose = one(params.choose);
  const user = await verifySession(`/integrations/${provider}/connect${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  if (!accountingProviderOn(provider)) notFound();
  const label = PROVIDER_LABELS[provider];
  const organisation = PROVIDER_WORDS[provider].organisation;
  const workspaces = (await membershipsOf(user.id)).filter((membership) => can(membership.role, "integrations.manage"));
  const chosen = workspaces.find((membership) => membership.slug === org) ?? (workspaces.length === 1 ? workspaces[0] : null);
  const error = errors(label, organisation)[one(params.error)] ?? null;
  const pending =
    choose && chosen && /^[0-9a-f-]{36}$/.test(choose)
      ? await withOrg(chosen.orgId, () => pendingChoice(chosen.orgId, choose, user.id), { userId: user.id }).catch(() => null)
      : null;
  const atTheTool = AT_THE_TOOL[provider];
  // The tool's mark beside the heading, decoration beside its written name (integration marks design).
  const mark = PROVIDER_MARKS[provider];

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-lg">
          {workspaces.length === 0 ? (
            <EmptyState
              icon={<Lock />}
              titleAs="h1"
              title={`Only an owner or admin connects ${label}`}
              body={`Ask an owner or admin of your workspace to connect ${label}, or sign in with the account that is one.`}
              action={
                <Button asChild variant="secondary">
                  <Link href="/onboarding">Your workspaces</Link>
                </Button>
              }
            />
          ) : choose && !pending ? (
            <EmptyState
              icon={<Clock />}
              titleAs="h1"
              title={`The time to pick ${withArticle(organisation)} ran out`}
              body={`Start again: ${label} asks you once more which ${organisation} to connect.`}
              action={
                <Button asChild>
                  <Link href={`/integrations/${provider}/connect${chosen ? `?org=${chosen.slug}` : ""}`}>Connect {label}</Link>
                </Button>
              }
            />
          ) : pending && chosen ? (
            <>
              <h1 className="flex items-start gap-3 text-2xl font-semibold tracking-[-0.02em] text-ink">
                <span className="flex h-8 shrink-0 items-center">
                  <BrandMark brand={mark} size={24} />
                </span>
                <span>
                  Pick the {label} {organisation}
                </span>
              </h1>
              <p className="mt-3 text-sm text-ink-2">
                {label} gave access to more than one {organisation}. Pick the one whose bills come into{" "}
                <strong className="font-semibold text-ink">{chosen.name}</strong>.{OTHERS[provider] ? ` ${OTHERS[provider]}` : ""}
              </p>
              {error && (
                <p role="alert" className="mt-4 text-sm text-refused">
                  {error}
                </p>
              )}
              <form method="post" action={`/api/integrations/${provider}/choose`} className="mt-6 space-y-5">
                <input type="hidden" name="org" value={chosen.slug} />
                <input type="hidden" name="choice" value={pending.id} />
                <NativeRadioGroup
                  legend={`${organisation[0].toUpperCase()}${organisation.slice(1)}`}
                  name="organisation"
                  required
                  options={pending.choices.map((choice) => ({ value: choice.externalOrgId, label: choice.name }))}
                />
                <Button type="submit" icon={<Link2 aria-hidden />}>
                  Connect this {organisation}
                </Button>
              </form>
            </>
          ) : (
            <>
              <h1 className="flex items-start gap-3 text-2xl font-semibold tracking-[-0.02em] text-ink">
                <span className="flex h-8 shrink-0 items-center">
                  <BrandMark brand={mark} size={24} />
                </span>
                <span>Connect {label}</span>
              </h1>
              <p className="mt-3 text-sm text-ink-2">{INTRO[provider]}</p>
              {error && (
                <p role="alert" className="mt-4 text-sm text-refused">
                  {error}
                </p>
              )}
              <form method="post" action={`/api/integrations/${provider}/connect`} className="mt-6 space-y-5">
                {workspaces.length === 1 ? (
                  <>
                    <input type="hidden" name="org" value={workspaces[0].slug} />
                    <p className="text-sm text-ink-2">
                      Workspace: <strong className="font-semibold text-ink">{workspaces[0].name}</strong>
                    </p>
                  </>
                ) : (
                  <NativeRadioGroup
                    legend="Workspace"
                    name="org"
                    required
                    defaultValue={chosen?.slug}
                    options={workspaces.map((membership) => ({
                      value: membership.slug,
                      label: membership.name,
                      description: networkProfile(membership.network).label,
                    }))}
                  />
                )}
                <ConnectorConsent provider={provider} title={`What Vestiarion does with ${label}'s data`} changed={one(params.consent) === "changed"} />
                <NativeCheckbox
                  name="consent"
                  value="yes"
                  required
                  label={CONSENT_LABEL}
                  description="Connecting records your agreement, with its date, on the connection and in the workspace's signed ledger."
                />
                {one(params.consent) === "missing" && (
                  <p role="alert" className="text-sm text-refused">
                    Tick I agree to connect {label}.
                  </p>
                )}
                {atTheTool && <p className="text-sm text-ink-2">{atTheTool}</p>}
                <Button type="submit" icon={<Link2 aria-hidden />}>
                  Continue to {label}
                </Button>
              </form>
              <p className="mt-4 text-sm text-ink-3">Signed in as {user.email ?? "you"}.</p>
            </>
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
