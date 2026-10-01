import type { Metadata } from "next";
import { CloudOff, Unlink } from "lucide-react";
import PayeeAddressForm from "@/components/PayeeAddressForm";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { previewPayeeLink, type PayeeLinkPreview } from "@/lib/platform/payee-links";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your payment address",
  robots: { index: false, follow: false },
};

type PayeePageProps = {
  params: Promise<{ token: string }>;
};

/**
 * Where a payee link opens (spec 2026-09-30-payee-links-design.md §2). No
 * session: the link is the credential. A usable link shows which business
 * wants to pay which payee, and one field (R4); every unusable link — used,
 * revoked, expired or unknown — shows the same sentence and names no one.
 * Opening it changes nothing; only the submitted form uses the link.
 */
export default async function PayeePage({ params }: PayeePageProps) {
  const { token } = await params;
  let preview: PayeeLinkPreview | null = null;
  let failed = false;
  try {
    preview = await previewPayeeLink(token);
  } catch {
    console.error("payee link preview failed");
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
          ) : (
            <section className="rounded-2xl border border-line bg-surface p-6 shadow-surface">
              <p>
                <Eyebrow className="text-agent">Payment address</Eyebrow>
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink">
                {preview.orgName} wants to pay {preview.counterpartyName} on Arc testnet
              </h1>
              <p className="mt-3 text-sm leading-6 text-ink-2">
                Enter the wallet address where you want to receive it. {preview.orgName} confirms it before paying you. This link works once.
              </p>
              <div className="mt-6">
                <PayeeAddressForm token={token} />
              </div>
            </section>
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
