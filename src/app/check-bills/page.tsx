import type { Metadata } from "next";
import Link from "next/link";
import { BillListChecker } from "@/components/bill-check/BillListChecker";
import { CheckBillsCta } from "@/components/bill-check/CheckBillsCta";
import { PublicMain } from "@/components/public/PublicMain";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
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
 * /tools, which serves downloads.
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
          <p className="mt-2 text-sm leading-relaxed text-ink-3">The check runs in this page. Nothing you paste is sent anywhere or kept.</p>

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
                as BP-1042 and bp 1042, counts as the same number, and a placeholder such as N/A counts as none.
              </li>
              <li>
                Two bills for the same amount 24 to 32 days apart are usually a monthly charge, so the rule does not call them duplicates, and this
                page does not call a later month of a charge with one description a repeat of an earlier month. They are listed apart, for you to
                check each is a new month&apos;s bill.
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

          <CheckBillsCta />
        </div>
      </PublicMain>
      <SiteFooter />
    </div>
  );
}
