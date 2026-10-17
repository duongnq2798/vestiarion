import type { Metadata } from "next";
import { CloudOff, Unlink } from "lucide-react";
import { OfferDecision } from "@/components/early-pay/OfferDecision";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { offerByAgent, previewOffer, type OfferPreview } from "@/lib/early-pay/offers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "An offer to pay you early",
  robots: { index: false, follow: false },
};

type OfferPageProps = {
  params: Promise<{ token: string }>;
};

/**
 * Where an early-payment offer opens (docs/superpowers/specs/2026-10-16-early-payment-offers-design.md E4). No session:
 * the link is the credential. An open offer names the business, the invoice and what the supplier receives today, with
 * Accept and Decline; a used, withdrawn, expired or unknown link shows one sentence and names no one. Opening it changes
 * nothing; only an answer does.
 */
export default async function OfferPage({ params }: OfferPageProps) {
  const { token } = await params;
  let offer: OfferPreview | null = null;
  let failed = false;
  let canCounter = false;
  try {
    offer = await previewOffer(token);
    // The agent's own offers may be countered (offer counters N1).
    canCounter = offer ? await offerByAgent(token) : false;
  } catch {
    console.error("early-payment offer preview failed");
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
            <OfferDecision token={token} offer={offer} canCounter={canCounter} />
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
