import type { Metadata } from "next";
import { CloudOff, Unlink } from "lucide-react";
import { PayeeJourney } from "@/components/payee/PayeeJourney";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { payeeLinkStatus } from "@/lib/platform/payee-links";
import type { PayeeLinkStatus } from "@/lib/payee-journey";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your payment",
  robots: { index: false, follow: false },
};

type PayeePageProps = {
  params: Promise<{ token: string }>;
};

/**
 * Where a payee link opens (spec 2026-09-30-payee-links-design.md §2, and the freelancer journey,
 * 2026-10-02-freelancer-journey-design.md). No session: the link is the credential. A usable link
 * asks for the payee's address; a link used within 30 days shows that payee's status, step by step,
 * up to the payment (R1). A revoked, expired or unknown link shows one sentence and names no one.
 * Opening it changes nothing; only the submitted form uses the link.
 */
export default async function PayeePage({ params }: PayeePageProps) {
  const { token } = await params;
  let status: PayeeLinkStatus | null = null;
  let failed = false;
  try {
    status = await payeeLinkStatus(token);
  } catch {
    console.error("payee link status failed");
    failed = true;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          {failed ? (
            <EmptyState icon={<CloudOff />} titleAs="h1" title="This page could not load. Try again in a moment." />
          ) : !status ? (
            <EmptyState icon={<Unlink />} titleAs="h1" title="This link is no longer valid. Ask the business that sent it for a new one." />
          ) : (
            <PayeeJourney token={token} status={status} />
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
