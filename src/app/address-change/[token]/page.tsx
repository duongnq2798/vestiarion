import type { Metadata } from "next";
import { CloudOff, Unlink } from "lucide-react";
import { AddressChangeAnswer } from "@/components/address-change/AddressChangeAnswer";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { previewAddressChange, type AddressChangePreview } from "@/lib/address-change-check";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Did you change your payment address?",
  robots: { index: false, follow: false },
};

type AddressChangePageProps = {
  params: Promise<{ token: string }>;
};

/**
 * Where "Was this you?" opens (docs/superpowers/specs/2026-10-22-address-change-check-design.md AC3). No session: the
 * link is the credential. An open check names the business and both addresses, with the two answers; a used, replaced,
 * expired or unknown link shows one sentence and names no one. Opening it changes nothing, so a mail scanner that follows
 * the link answers nothing. A security page, so its footer carries no link back to Vestiarion.
 */
export default async function AddressChangePage({ params }: AddressChangePageProps) {
  const { token } = await params;
  let change: AddressChangePreview | null = null;
  let failed = false;
  try {
    change = await previewAddressChange(token);
  } catch {
    console.error("address change preview failed");
    failed = true;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-lg">
          {failed ? (
            <EmptyState icon={<CloudOff />} titleAs="h1" title="This page could not load. Try again in a moment." />
          ) : !change ? (
            <EmptyState
              icon={<Unlink />}
              titleAs="h1"
              title="This link is no longer valid. If you did not change your payment address, contact the business that pays you directly."
            />
          ) : (
            <AddressChangeAnswer token={token} change={change} />
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
