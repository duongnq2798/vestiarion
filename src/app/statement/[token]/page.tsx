import type { Metadata } from "next";
import { CalendarX2, CloudOff, Unlink } from "lucide-react";
import { StatementView } from "@/components/portal/StatementView";
import { PublicMain } from "@/components/public/PublicMain";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { utcDay } from "@/lib/copy";
import { readStatement, type StatementRead } from "@/lib/customer-portal/public";
import { linkSocialMetadata } from "@/lib/link-previews";
import { networkProfile } from "@/lib/network";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // A fixed title: the business's and the customer's names are on the page, never in the tab or a card.
  title: "Your statement",
  robots: { index: false, follow: false },
  // The card for this kind of link, rendered at build time and naming nothing of the link (mainnet polish E1).
  ...linkSocialMetadata("statement"),
};

type StatementPageProps = {
  params: Promise<{ token: string }>;
};

/**
 * Where a customer's statement link opens (docs/superpowers/specs/2026-10-13-customer-portal-design.md P3, P6). No
 * session and no wallet: the link is the credential, and the statement is read again on every view. A malformed,
 * unknown or stopped link shows one sentence and names no one; an expired one says only that it expired, and when.
 * Opening it changes nothing.
 */
export default async function StatementPage({ params }: StatementPageProps) {
  const { token } = await params;
  let read: StatementRead = { state: "dead" };
  let failed = false;
  try {
    read = await readStatement(token);
  } catch {
    console.error("statement read failed");
    failed = true;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <PublicMain width="record">
          {failed ? (
            <EmptyState icon={<CloudOff />} titleAs="h1" title="This statement could not load. Try again in a moment." />
          ) : read.state === "expired" ? (
            <EmptyState
              icon={<CalendarX2 />}
              titleAs="h1"
              title="This link has expired."
              body={`It worked until ${utcDay(read.expiresAt)}. Ask the business that sent it for a new one.`}
            />
          ) : read.state === "dead" ? (
            <EmptyState icon={<Unlink />} titleAs="h1" title="This link no longer works. Ask the business that sent it for a new one." />
          ) : (
            <StatementView view={read.view} token={token} />
          )}
      </PublicMain>
      <SiteFooter compact loop="statement" networkLabel={read.state === "live" ? networkProfile(read.network).label : undefined} />
    </div>
  );
}
