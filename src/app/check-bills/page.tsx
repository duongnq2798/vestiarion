import type { Metadata } from "next";
import Link from "next/link";
import { BillListChecker } from "@/components/bill-check/BillListChecker";
import { PublicMain } from "@/components/public/PublicMain";
import { ToolCta } from "@/components/public/ToolCta";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import { FREE_TOOL_COUNT_LINE } from "@/lib/free-tools";
import { X_HANDLE } from "@/lib/site-links";

// The root layout adds " · Vestiarion" to the page's title; the social cards carry the name themselves.
const TITLE = "Duplicate invoice check for your bill list, free";
const SOCIAL_TITLE = "Bill list check — duplicate invoices, and discounts and late fees due this week";
const DESCRIPTION =
  "Paste or drop your bill list from QuickBooks, Xero, Zoho Books or a spreadsheet. It finds bills you may be about to pay twice, bills of the same amount about a month apart, and early-payment discounts and late fees in the next 7 days, with what each is worth. Free, and nothing you paste leaves your browser.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/check-bills" },
  openGraph: { title: SOCIAL_TITLE, description: DESCRIPTION, url: "/check-bills", type: "website", siteName: "Vestiarion", locale: "en_US" },
  twitter: { card: "summary_large_image", site: X_HANDLE, title: SOCIAL_TITLE, description: DESCRIPTION },
};

/**
 * /check-bills (docs/superpowers/specs/2026-10-28-check-bills-design.md CB1): a free page anyone can run on a bill list
 * before paying it. Static: the list is read and checked in the browser, so no bill reaches the server. Not under
 * /tools, which serves downloads. Its start button is the shared `ToolCta`, and its footer names the tool, so both starts
 * on the page credit a workspace opened after them to this tool, from outside the checker's code (CB11;
 * docs/superpowers/specs/2026-10-28-free-tool-attribution-design.md TA3, TA5, TA6).
 */
export default function CheckBillsPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader>
        <SiteHeaderLink href="/">Home</SiteHeaderLink>
        <SiteHeaderLink href="/docs">Docs</SiteHeaderLink>
      </SiteHeader>
      <PublicMain width="record">
        <div className="mx-auto w-full max-w-2xl">
          <Eyebrow>Free tool</Eyebrow>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-3xl">Check your bill list for duplicates and deadlines</h1>
          <p className="mt-3 text-base leading-relaxed text-ink-2">
            Paste your bills, or drop the CSV your accounting software exports. It finds bills you may be about to pay twice, bills of the same
            amount about a month apart, and early-payment discounts and late fees in the next 7 days, with what each is worth.
          </p>
          {/* True whether analytics is set up or not (free tool attribution TA6). */}
          <p className="mt-2 text-sm leading-relaxed text-ink-3">The check runs in this page, and nothing you paste is kept. {FREE_TOOL_COUNT_LINE}</p>

          <div className="mt-8">
            <BillListChecker />
          </div>

          <section aria-labelledby="how-it-works" className="mt-14 border-t border-line pt-8">
            <h2 id="how-it-works" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              How it works
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-2">
              <li>
                It reads your columns the way Vestiarion&apos;s bill import does, and asks only what the list cannot say, such as whether 03/04 is
                the 3rd of April or March 4.
              </li>
              <li>
                Bills of one vendor are compared by amount, purchase order, description and due date, with the rule Vestiarion&apos;s agent uses
                before it pays. This page also compares their invoice numbers, which the agent&apos;s rule does not: one written another way, such
                as BP-1042 and bp 1042, counts as the same number. A placeholder such as N/A in place of an invoice number or a purchase order
                counts as none.
              </li>
              <li>
                Two bills for the same amount 24 to 32 days apart are usually a monthly charge, so the rule does not call them duplicates. When the
                month before a charge with one description is in the list too, this page does not call it a repeat of the months before either.
                These bills are listed apart, unless one is already a likely duplicate, for you to check each is a new month&apos;s bill.
              </li>
              <li>
                A discount or a late fee is counted only when your list gives its terms. A late fee with no start date starts the day after the
                bill is due.
              </li>
              <li>You can download your list back, with a last column saying what was found on each row.</li>
            </ul>
          </section>

          <section aria-labelledby="does-not" className="mt-10">
            <h2 id="does-not" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              What it does not do
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-2">
              <li>
                It does not know which bills you have paid. A likely duplicate is a pair to look at before you pay, not proof that one is wrong, and
                a list where it finds nothing can still hold a bill sent twice.
              </li>
              <li>It does not compare bills of different vendors, or see anything outside the list.</li>
              <li>It checks the first 5,000 bills of a list.</li>
              <li>
                It does not check payment details. For a wallet address you are about to pay, use the{" "}
                <Link href="/check-address" className="font-medium text-agent underline underline-offset-4">
                  address lookalike checker
                </Link>
                .
              </li>
            </ul>
          </section>

          <section aria-labelledby="check-bills-in-vestiarion" className="mt-10 rounded-2xl border border-line bg-surface px-5 py-6 sm:px-6">
            <h2 id="check-bills-in-vestiarion" className="text-lg font-semibold tracking-[-0.01em] text-ink">
              What Vestiarion does with your bills
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              Vestiarion runs its duplicate check, purchase-order match, sanctions screening and a payee lock on every new bill, and weighs
              early-payment discounts and late fees, before it pays. Start a shadow workspace and drop this same file into its bill import.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-ink-3">
              The import takes up to 200 bills at a time, for vendors you have added in Counterparties, and shows what happens to every row before
              anything is added.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <ToolCta tool="check-bills" />
              <Button asChild variant="secondary">
                <Link href="/docs/guides/import-bills">How the bill import works</Link>
              </Button>
            </div>
            <p className="mt-3 text-sm text-ink-3">In shadow mode it decides on your real bills while you keep paying them as you do now.</p>
          </section>
        </div>
      </PublicMain>
      <SiteFooter tool="check-bills" />
    </div>
  );
}
