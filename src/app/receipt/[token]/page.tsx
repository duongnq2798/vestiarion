import type { Metadata } from "next";
import { CloudOff, Unlink } from "lucide-react";
import { ReceiptView } from "@/components/receipt/ReceiptView";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { readReceipt, type ReceiptView as ReceiptViewData } from "@/lib/platform/receipts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payment receipt",
  robots: { index: false, follow: false },
};

type ReceiptPageProps = {
  params: Promise<{ token: string }>;
};

/**
 * Where a receipt link opens (docs/superpowers/specs/2026-10-01-payment-receipts-design.md P5). No session:
 * the link is the credential. A live link shows the receipt and its checks; every dead link — revoked,
 * replaced or unknown — shows the same sentence and names no one.
 */
export default async function ReceiptPage({ params }: ReceiptPageProps) {
  const { token } = await params;
  let view: ReceiptViewData | null = null;
  let failed = false;
  try {
    view = await readReceipt(token);
  } catch {
    console.error("receipt read failed");
    failed = true;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-2xl">
          {failed ? (
            <EmptyState icon={<CloudOff />} titleAs="h1" title="This receipt could not load. Try again in a moment." />
          ) : !view ? (
            <EmptyState icon={<Unlink />} titleAs="h1" title="This receipt link is no longer valid." />
          ) : (
            <ReceiptView view={view} />
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
