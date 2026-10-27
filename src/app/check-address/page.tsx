import type { Metadata } from "next";
import Link from "next/link";
import { AddressChecker } from "@/components/address-check/AddressChecker";
import { PublicMain } from "@/components/public/PublicMain";
import { ToolCta } from "@/components/public/ToolCta";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import snapshot from "@/lib/data/ofac-sdn-evm-wallets.json";
import { FREE_TOOL_COUNT_LINE } from "@/lib/free-tools";
import { X_HANDLE } from "@/lib/site-links";

// The root layout adds " · Vestiarion" to the page's title; the social cards carry the name themselves.
const TITLE = "Address lookalike checker";
const SOCIAL_TITLE = "Address lookalike checker — catch address poisoning before you pay";
const DESCRIPTION =
  "Paste the address you are about to pay and the ones you know. It tells you if it is made to look like one of them, if a character in it is hidden, from another alphabet or fails its checksum, and if it is on OFAC's sanctions list. Free, and nothing you paste leaves your browser.";

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
 * no address reaches the server. Not under /tools, which serves downloads. Its start button is the shared `ToolCta`,
 * and its footer names the tool, so both starts on the page credit a workspace opened after them to this tool
 * (docs/superpowers/specs/2026-10-28-free-tool-attribution-design.md TA3, TA5, TA6).
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
            Paste the address you are about to pay, and the addresses you already have for your payees. It tells you if it is made to look like
            one of them, the trick called address poisoning, if a character in it is hidden, from another alphabet or fails its checksum, and if it
            is on OFAC&apos;s sanctions list.
          </p>
          {/* True whether analytics is set up or not (free tool attribution TA6). */}
          <p className="mt-2 text-sm leading-relaxed text-ink-3">The check runs in this page, and nothing you paste is kept. {FREE_TOOL_COUNT_LINE}</p>

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
              What Vestiarion does inside a workspace
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              Vestiarion is an AI agent for bills and payments. It never pays a changed payout address until a person confirms it. With its payee
              lock on, someone other than whoever entered it confirms it when anyone else can, a call or a message must use a contact you had
              before the change, and the payment can wait up to 72 hours after it. Counterparties warns when a payee&apos;s address shares its
              first 6 and last 4 characters with another payee&apos;s, or with the same payee&apos;s earlier one, and the agent checks every payout
              address against OFAC&apos;s list. Each step is signed into a ledger anyone can verify.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <ToolCta tool="check-address" />
              <Button asChild variant="secondary">
                <Link href="/docs/guides/first-payment#payee-lock">How the payee lock works</Link>
              </Button>
            </div>
          </section>
        </div>
      </PublicMain>
      <SiteFooter tool="check-address" />
    </div>
  );
}
