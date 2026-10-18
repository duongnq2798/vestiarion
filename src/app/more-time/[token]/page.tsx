import type { Metadata } from "next";
import { CloudOff, Unlink } from "lucide-react";
import { TermDecision } from "@/components/terms/TermDecision";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { previewTermRequest, type TermRequestPreview } from "@/lib/terms/requests";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "A request for more time",
  robots: { index: false, follow: false },
};

type TermsPageProps = {
  params: Promise<{ token: string }>;
};

/**
 * Where a request for more time opens (docs/superpowers/specs/2026-10-17-term-requests-design.md X4). No session: the
 * link is the credential. An open request names the business, the invoice, the new date and the full amount, with Agree
 * and Decline; a used, withdrawn, expired or unknown link shows one sentence and names no one. Opening it changes
 * nothing; only an answer does.
 */
export default async function TermsPage({ params }: TermsPageProps) {
  const { token } = await params;
  let request: TermRequestPreview | null = null;
  let failed = false;
  try {
    request = await previewTermRequest(token);
  } catch {
    console.error("term request preview failed");
    failed = true;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-lg">
          {failed ? (
            <EmptyState icon={<CloudOff />} titleAs="h1" title="This page could not load. Try again in a moment." />
          ) : !request ? (
            <EmptyState icon={<Unlink />} titleAs="h1" title="This link is no longer valid. Ask the business that sent it for a new one." />
          ) : (
            <TermDecision token={token} request={request} />
          )}
        </div>
      </main>
      <SiteFooter compact loop="more_time" />
    </div>
  );
}
