import type { Metadata } from "next";
import { CircleCheck, CloudOff, Unlink } from "lucide-react";
import { PayInvoice } from "@/components/PayInvoice";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { homeChain, networkOfChain } from "@/lib/payee-chains";
import { paidAtDiscount, payLinkDiscount } from "@/lib/customer-offers/store";
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
 *
 * Settled, it says what arrived, never the invoice's whole amount when part of it was marked a fee, which never arrived
 * (0103 settles a receivable once payments and fees cover it), and who says so: Circle reported the payments complete,
 * and the business applied them in Vestiarion (settlement lifecycle I17).
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
  // Best effort: a balance that cannot be read asks for the whole invoice, as before. A settled invoice with no payment
  // applied in part says the whole invoice arrived, as a whole match (one transfer of exactly its amount) does; one whose
  // balance could not be read says only what was invoiced, never that all of it arrived (I17).
  let balanceRead = true;
  const balance = preview
    ? await payLinkBalance(preview).catch(() => {
        console.error("pay link balance not read");
        balanceRead = false;
        return null;
      })
    : null;
  // A discount the client accepted (customer discounts C5, C6): asked for while it applies; once paid at it, what arrived
  // was the discounted amount, never the whole invoice. Best effort, as the balance: unread, the invoice is as before.
  const discount = preview && preview.status === "open" && !balance ? await payLinkDiscount(preview.orgId, preview.invoiceId, preview.amount).catch(() => null) : null;
  const discounted = preview && preview.status === "received" && !balance ? await paidAtDiscount(preview.orgId, preview.invoiceId).catch(() => null) : null;
  const arrived: number | null = balance ? balance.received : discounted !== null ? discounted : balanceRead ? (preview?.amount ?? 0) : null;
  const network = preview ? homeChain(networkOfChain(preview.chain)).label : undefined;

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
              <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink">{preview.orgName} marked this invoice paid. Thank you.</h1>
              <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                {(arrived === null || Math.round(arrived * 1_000_000) !== Math.round(preview.amount * 1_000_000)) && (
                  <>
                    <dt className="text-ink-3">Invoiced</dt>
                    <dd className="text-ink">
                      {AMOUNT.format(preview.amount)} {preview.currency}
                    </dd>
                  </>
                )}
                {arrived !== null && (
                  <>
                    <dt className="text-ink-3">Arrived</dt>
                    <dd className="text-ink">
                      {AMOUNT.format(arrived)} {preview.currency} on {network}
                    </dd>
                  </>
                )}
                {preview.memo && (
                  <>
                    <dt className="text-ink-3">For</dt>
                    <dd className="break-words text-ink">{preview.memo}</dd>
                  </>
                )}
              </dl>
              {arrived !== null && (
                <p className="mt-4 text-xs leading-5 text-ink-3">
                  Circle reported what arrived as complete on {network}, and {preview.orgName} applied it to this invoice in Vestiarion.
                </p>
              )}
            </section>
          ) : (
            <PayInvoice preview={preview} balance={balance} token={token} discount={discount} />
          )}
        </div>
      </main>
      <SiteFooter compact networkLabel={preview ? homeChain(networkOfChain(preview.chain)).label : undefined} />
    </div>
  );
}
