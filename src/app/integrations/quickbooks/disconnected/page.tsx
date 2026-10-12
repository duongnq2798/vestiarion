import type { Metadata } from "next";
import { Unplug } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { membershipsOf } from "@/lib/auth/membership";
import { verifySession } from "@/lib/auth/session";
import { confirmDisconnected, type DisconnectedOutcome } from "@/lib/connectors/disconnected";
import { quickBooksProvider } from "@/lib/quickbooks/provider";
import { quickBooksSettingsFromEnv } from "@/lib/quickbooks/settings";

export const metadata: Metadata = { title: "QuickBooks disconnected" };
export const dynamic = "force-dynamic";

type DisconnectedPageProps = { searchParams: Promise<{ realmId?: string | string[] }> };

const REALM = /^\d{1,32}$/;

function Line({ result }: { result: DisconnectedOutcome }) {
  const company = result.organisation ?? "your QuickBooks company";
  const settings = `/o/${result.slug}/settings#quickbooks`;
  const words =
    result.outcome === "disconnected"
      ? `QuickBooks says ${company} was disconnected there, so ${result.workspace} reads nothing more from it. Bills already added stay in Vestiarion.`
      : result.outcome === "still_connected"
        ? `QuickBooks still accepts ${result.workspace}'s connection to ${company}. To stop it, choose Disconnect QuickBooks in Settings.`
        : `QuickBooks did not answer about ${result.workspace}'s connection to ${company}. Vestiarion asks again on its next sync, and Settings says if it needs you.`;
  return (
    <li className="space-y-2 px-4 py-3">
      <p className="text-sm text-ink-2">{words}</p>
      <Button asChild size="sm" variant="secondary">
        <Link href={settings}>{result.workspace} settings</Link>
      </Button>
    </li>
  );
}

/**
 * QuickBooks' Disconnect URL (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q12), registered as
 * https://www.vestiarion.xyz/integrations/quickbooks/disconnected: QuickBooks sends a person here after they disconnect
 * the app on its side. Only the workspaces where they manage integrations are looked at, and a connection is marked
 * disconnected only when QuickBooks refuses it now: the page records what QuickBooks confirms, never what a link says.
 */
export default async function QuickBooksDisconnectedPage({ searchParams }: DisconnectedPageProps) {
  const { realmId } = await searchParams;
  const realm = typeof realmId === "string" && REALM.test(realmId) ? realmId : null;
  const user = await verifySession(`/integrations/quickbooks/disconnected${realm ? `?realmId=${realm}` : ""}`);
  const settings = quickBooksSettingsFromEnv();
  if (!settings) notFound();
  const results = await confirmDisconnected(
    { userId: user.id, workspaces: await membershipsOf(user.id), externalOrgId: realm },
    { provider: quickBooksProvider(settings) }
  );
  const title = results.some((result) => result.outcome === "disconnected")
    ? "QuickBooks is disconnected"
    : results.some((result) => result.outcome === "still_connected")
      ? "QuickBooks is still connected"
      : "QuickBooks did not answer";

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-lg">
          {results.length === 0 ? (
            <EmptyState
              icon={<Unplug />}
              titleAs="h1"
              title="Nothing to disconnect here"
              body="No workspace you manage is connected to QuickBooks now. If you disconnected Vestiarion in QuickBooks, it is disconnected here already, or the company was connected to a workspace someone else manages."
              action={
                <Button asChild variant="secondary">
                  <Link href="/onboarding">Your workspaces</Link>
                </Button>
              }
            />
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">{title}</h1>
              <p className="mt-3 text-sm text-ink-2">Vestiarion asked QuickBooks about each workspace you manage that was connected to it.</p>
              <ul className="mt-6 divide-y divide-line rounded-lg border border-line">
                {results.map((result) => (
                  <Line key={result.slug} result={result} />
                ))}
              </ul>
            </>
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
