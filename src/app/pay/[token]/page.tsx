import type { Metadata } from "next";
import { CircleCheck, CloudOff, Unlink } from "lucide-react";
import PaymentCheck from "@/components/PaymentCheck";
import { CopyButton } from "@/components/ui/CopyButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { previewPayLink, type PayLinkPreview } from "@/lib/platform/pay-links";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pay an invoice",
  robots: { index: false, follow: false },
};

type PayPageProps = {
  params: Promise<{ token: string }>;
};

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/**
 * Where a pay link opens (docs/superpowers/specs/2026-10-01-receivables-on-arc-design.md §2). No session:
 * the link is the credential, and it shows only what the client needs to pay (R2): who asks, how much,
 * by when, for what, and the address on Arc testnet. Every unusable link shows the same sentence and
 * names no one. Opening it changes nothing.
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
            <section className="rounded-2xl border border-line bg-surface p-6 shadow-surface">
              <p>
                <Eyebrow className="text-agent">Invoice</Eyebrow>
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink">
                {preview.orgName} asks {preview.clientName} to pay {AMOUNT.format(preview.amount)} {preview.currency}
              </h1>
              <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                <dt className="text-ink-3">Due</dt>
                <dd className="text-ink">{preview.dueDate}</dd>
                {preview.memo && (
                  <>
                    <dt className="text-ink-3">For</dt>
                    <dd className="break-words text-ink">{preview.memo}</dd>
                  </>
                )}
                <dt className="text-ink-3">Network</dt>
                <dd className="text-ink">Arc testnet</dd>
              </dl>
              {preview.payTo ? (
                <div className="mt-5 grid gap-2">
                  <p className="text-sm font-medium text-ink">Send exactly {AMOUNT.format(preview.amount)} {preview.currency} to</p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all rounded-lg border border-line bg-ground px-3 py-2 font-mono text-xs text-ink">{preview.payTo}</code>
                    <CopyButton value={preview.payTo} label="Copy address" variant="secondary">
                      Copy
                    </CopyButton>
                  </div>
                  <p className="text-xs leading-5 text-ink-3">
                    From any wallet on Arc testnet. Send the exact amount: that is how the payment is matched to this invoice.
                  </p>
                </div>
              ) : (
                <p className="mt-5 text-sm text-ink-2">{preview.orgName} has no address to receive payments yet. Ask them before you pay.</p>
              )}
              {preview.payTo && (
                <div className="mt-6 border-t border-line pt-5">
                  <PaymentCheck token={token} />
                </div>
              )}
            </section>
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
