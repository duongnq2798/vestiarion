import type { Metadata } from "next";
import { CloudOff, Unlink } from "lucide-react";
import { DiscountDecision } from "@/components/customer-offers/DiscountDecision";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { previewDiscount, type DiscountPreview } from "@/lib/customer-offers/store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "A discount for paying early",
  robots: { index: false, follow: false },
};

type DiscountPageProps = {
  params: Promise<{ token: string }>;
};

/**
 * Where an early-payment discount opens (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md C4). No
 * session: the link is the credential. An open offer names the business, the invoice, the full amount and due date, and
 * the discounted amount and pay-by day, with Accept and No thanks; a used, withdrawn, expired or unknown link shows one
 * sentence and names no one. Opening it changes nothing; only an answer does.
 */
export default async function DiscountPage({ params }: DiscountPageProps) {
  const { token } = await params;
  let offer: DiscountPreview | null = null;
  let failed = false;
  try {
    offer = await previewDiscount(token);
  } catch {
    console.error("customer discount preview failed");
    failed = true;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-lg">
          {failed ? (
            <EmptyState icon={<CloudOff />} titleAs="h1" title="This page could not load. Try again in a moment." />
          ) : !offer ? (
            <EmptyState icon={<Unlink />} titleAs="h1" title="This link is no longer valid. Ask the business that sent it for a new one." />
          ) : (
            <DiscountDecision token={token} offer={offer} />
          )}
        </div>
      </main>
      <SiteFooter compact loop="customer_discount" />
    </div>
  );
}
