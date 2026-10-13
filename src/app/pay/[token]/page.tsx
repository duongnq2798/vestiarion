import type { Metadata } from "next";
import { CircleCheck, CloudOff, Unlink } from "lucide-react";
import { PayInvoice } from "@/components/PayInvoice";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { homeChain, networkOfChain } from "@/lib/payee-chains";
import { payLinkBalance, previewPayLink, type PayLinkPreview } from "@/lib/platform/pay-links";
import { linkSocialMetadata } from "@/lib/link-previews";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pay an invoice",
  robots: { index: false, follow: false },
  // This page's own card, rendered at build time and naming nothing of the link (mainnet polish E1).
  ...linkSocialMetadata("pay"),
};

type PayPageProps = {
  params: Promise<{ token: string }>;
};

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/**
 * Where a pay link opens (docs/superpowers/specs/2026-10-01-receivables-on-arc-design.md §2). No session:
 * the link is the credential, and it shows only what the client needs to pay (R2): who asks, how much,
 * by when, for what, and the address on Arc testnet. Every unusable link shows the same sentence and
 * names no one. Opening it changes nothing. Once a payment was applied to the invoice, it asks for what is still owed
 * and says what arrived (docs/superpowers/specs/2026-10-12-allocations-design.md L11).
 * The open invoice itself is `PayInvoice`.
 */
export default async function PayPage({ params }: PayPageProps) {
  const { token } = await params;
  let preview: PayLinkPreview | null = null;
  let failed = false;
  try {
    preview = await previewPayLink(token);
  } catch {
    console.error("pay link preview failed");
    failed = true;
  }
  // Best effort: a balance that cannot be read asks for the whole invoice, as before.
  const balance =
    preview && preview.status === "open"
      ? await payLinkBalance(preview).catch(() => {
          console.error("pay link balance not read");
          return null;
        })
      : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          {failed ? (
            <EmptyState icon={<CloudOff />} titleAs="h1" title="This page could not load. Try again in a moment." />
          ) : !preview ? (
            <EmptyState icon={<Unlink />} titleAs="h1" title="This link is no longer valid. Ask the business that sent it for a new one." />
          ) : preview.status === "received" ? (
            <section className="rounded-2xl border border-line bg-surface p-6 shadow-surface">
              <p className="flex items-center gap-2">
                <CircleCheck aria-hidden className="size-4 text-proof" />
                <Eyebrow className="text-proof">Paid</Eyebrow>
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink">
                {preview.orgName} received {AMOUNT.format(preview.amount)} {preview.currency}. Thank you.
              </h1>
            </section>
          ) : (
            <PayInvoice preview={preview} balance={balance} token={token} />
          )}
        </div>
      </main>
      <SiteFooter compact networkLabel={preview ? homeChain(networkOfChain(preview.chain)).label : undefined} />
    </div>
  );
}
