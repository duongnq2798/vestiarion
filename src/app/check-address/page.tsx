import type { Metadata } from "next";
import Link from "next/link";
import { AddressChecker } from "@/components/address-check/AddressChecker";
import { TRY_HREF } from "@/components/landing/cta";
import { PublicMain } from "@/components/public/PublicMain";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import snapshot from "@/lib/data/ofac-sdn-evm-wallets.json";
import { X_HANDLE } from "@/lib/site-links";

// The root layout adds " · Vestiarion" to the page's title; the social cards carry the name themselves.
const TITLE = "Address lookalike checker";
const SOCIAL_TITLE = "Address lookalike checker — catch address poisoning before you pay";
const DESCRIPTION =
  "Paste the address you are about to pay and the ones you know. It tells you if it is made to look like one of them, if a character in it is wrong or hidden, and if it is on OFAC's sanctions list. Free, and nothing you paste leaves your browser.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/check-address" },
  openGraph: { title: SOCIAL_TITLE, description: DESCRIPTION, url: "/check-address", type: "website", siteName: "Vestiarion", locale: "en_US" },
  twitter: { card: "summary_large_image", site: X_HANDLE, title: SOCIAL_TITLE, description: DESCRIPTION },
};

/** The OFAC list's date as the page writes it: "Oct 21, 2026". */
const listDate = new Date(snapshot.readAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * /check-address (docs/superpowers/specs/2026-10-21-address-checker-design.md AC6, AC7): a free page anyone can use
 * before paying an address. Static: the check runs in the browser against the dated OFAC snapshot the page carries, so
 * no address reaches the server. Not under /tools, which serves downloads.
 */
export default function CheckAddressPage() {
  const sanctioned = snapshot.wallets.map(({ address, name }) => ({ address, name }));
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader>
        <SiteHeaderLink href="/">Home</SiteHeaderLink>
        <SiteHeaderLink href="/docs">Docs</SiteHeaderLink>
      </SiteHeader>
      <PublicMain width="record">
        <div className="mx-auto w-full max-w-2xl">
          <Eyebrow>Free tool</Eyebrow>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-3xl">Check an address before you pay it</h1>
          <p className="mt-3 text-base leading-relaxed text-ink-2">
            Paste the address you are about to pay, and the addresses you have paid before. It tells you if it is made to look like one of them,
            the trick called address poisoning, if a character in it is wrong or hidden, and if it is on OFAC&apos;s sanctions list.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-ink-3">The check runs in this page. Nothing you paste is sent anywhere or kept.</p>

          <div className="mt-8">
            <AddressChecker sanctioned={sanctioned} listDate={listDate} />
          </div>

          <section aria-labelledby="poisoning" className="mt-14 border-t border-line pt-8">
            <h2 id="poisoning" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              What address poisoning is
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              Wallets and explorers show an address by its ends, like 0x7a2d…e10d. Someone makes an address with the same ends as one you pay, then
              sends you a transfer of nothing from it, so it sits in your history beside the real one. The next time you copy an address from your
              history, you may copy theirs. Nothing about the payment looks wrong until the payee asks where their money is.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              The same goes for an invoice whose payment details were changed, or an email that says a supplier has a new wallet. Compare the whole
              address with one you already had, and confirm a new one with the payee by a call or a message to a contact you had before.
            </p>
          </section>

          <section aria-labelledby="payee-lock" className="mt-10 rounded-2xl border border-line bg-surface px-5 py-6 sm:px-6">
            <h2 id="payee-lock" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              Vestiarion does this on every payment
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              Vestiarion is an AI agent for bills and payments. It never pays a changed payout address until a person confirms it. With its payee
              lock on, that person is someone other than whoever entered it, when anyone else can, the check uses a contact you had before the
              change, and the payment waits as long as you choose. Counterparties warns when an address looks like another payee&apos;s, or like the
              same payee&apos;s earlier one, and every payout address is checked against OFAC&apos;s list. Each step is signed into a ledger anyone
              can verify.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button asChild>
                <Link href={TRY_HREF} data-cta="check-address-start">
                  Try it on your bills
                </Link>
              </Button>
              <Button asChild variant="secondary">
                <Link href="/docs/guides/first-payment#payee-lock">How the payee lock works</Link>
              </Button>
            </div>
          </section>
        </div>
      </PublicMain>
      <SiteFooter />
    </div>
  );
}
