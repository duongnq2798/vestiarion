import type { Metadata } from "next";
import { CalendarX2, CloudOff, EyeOff, Unlink } from "lucide-react";
import { SupplierStatusView } from "@/components/supplier/SupplierStatusView";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { utcDay } from "@/lib/copy";
import { linkSocialMetadata } from "@/lib/link-previews";
import { networkProfile } from "@/lib/network";
import { readSupplierStatus, type SupplierStatusRead } from "@/lib/supplier-status/public";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // A fixed title: the business's and the supplier's names are on the page, never in the tab or a card.
  title: "Your payments",
  robots: { index: false, follow: false },
  // The card for this kind of link, rendered at build time and naming nothing of the link (mainnet polish E1).
  ...linkSocialMetadata("supplier"),
};

type SupplierStatusPageProps = {
  params: Promise<{ token: string }>;
};

/**
 * Where a supplier's payment status link opens (docs/superpowers/specs/2026-10-18-supplier-status-design.md V2-V4, V7).
 * No session and no wallet: the link is the credential, and the bills are read again on every view. A malformed, unknown
 * or stopped link shows one sentence and names no one; an expired one says only that it expired, and when. Opening it
 * changes nothing.
 */
export default async function SupplierStatusPage({ params }: SupplierStatusPageProps) {
  const { token } = await params;
  let read: SupplierStatusRead = { state: "dead" };
  let failed = false;
  try {
    read = await readSupplierStatus(token);
  } catch {
    console.error("supplier status read failed");
    failed = true;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 justify-center px-4 py-8 sm:py-14">
        <div className="w-full max-w-2xl">
          {failed ? (
            <EmptyState icon={<CloudOff />} titleAs="h1" title="Your payments could not load. Try again in a moment." />
          ) : read.state === "expired" ? (
            <EmptyState
              icon={<CalendarX2 />}
              titleAs="h1"
              title="This link has expired."
              body={`It worked until ${utcDay(read.expiresAt)}. Ask the business that sent it for a new one.`}
            />
          ) : read.state === "unavailable" ? (
            <EmptyState
              icon={<EyeOff />}
              titleAs="h1"
              title="Payment status is not shown for this business right now."
              body="Ask the business that sent the link where your payment stands."
            />
          ) : read.state === "dead" ? (
            <EmptyState icon={<Unlink />} titleAs="h1" title="This link no longer works. Ask the business that sent it for a new one." />
          ) : (
            <SupplierStatusView view={read.view} />
          )}
        </div>
      </main>
      <SiteFooter compact networkLabel={read.state === "live" ? networkProfile(read.network).label : undefined} />
    </div>
  );
}
