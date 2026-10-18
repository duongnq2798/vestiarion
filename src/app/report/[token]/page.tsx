import type { Metadata } from "next";
import { CloudOff, Unlink } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { SharedReport } from "@/components/vx/SharedReport";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { linkSocialMetadata } from "@/lib/link-previews";
import { networkProfile } from "@/lib/network";
import { readSharedReport, type SharedReportShown } from "@/lib/platform/shared-report";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // A fixed title: the workspace's name, when the share shows it, is on the page and never in the tab or a card (S5).
  title: "Shared report",
  robots: { index: false, follow: false },
  // The card for this kind of link, rendered at build time and naming nothing of the link (mainnet polish E1).
  ...linkSocialMetadata("report"),
};

type SharedReportPageProps = {
  params: Promise<{ token: string }>;
};

/**
 * Where a shared report's link opens (docs/superpowers/specs/2026-10-10-shared-report-design.md S5, S14). No session:
 * the link is the credential, and the report is recomputed on every view. Every dead link (malformed, unknown, stopped,
 * or its workspace deleted) shows the same sentence, and a read that failed another; neither names the workspace.
 */
export default async function SharedReportPage({ params }: SharedReportPageProps) {
  const { token } = await params;
  let view: SharedReportShown | null = null;
  let failed = false;
  try {
    view = await readSharedReport(token);
  } catch {
    console.error("shared report read failed");
    failed = true;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 justify-center px-4 py-12 sm:py-16">
        <div className={view ? "w-full max-w-5xl" : "w-full max-w-2xl"}>
          {failed ? (
            <EmptyState icon={<CloudOff />} titleAs="h1" title="This report could not load. Try again in a moment." />
          ) : !view ? (
            <EmptyState icon={<Unlink />} titleAs="h1" title="This report is no longer shared." />
          ) : (
            <SharedReport view={view} />
          )}
        </div>
      </main>
      <SiteFooter compact loop="shared_report" networkLabel={view ? networkProfile(view.network).label : undefined} />
    </div>
  );
}
