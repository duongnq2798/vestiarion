import type { Metadata } from "next";
import { PaymentTermsCalculator } from "@/components/payment-terms/PaymentTermsCalculator";
import { PaymentTermsCta } from "@/components/payment-terms/PaymentTermsCta";
import { TermLinks } from "@/components/payment-terms/TermLinks";
import { PublicMain } from "@/components/public/PublicMain";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import { X_HANDLE } from "@/lib/site-links";

// The root layout adds " · Vestiarion" to the page's title; the social cards carry the name themselves.
const TITLE = "Payment terms calculator: due date, 2/10 net 30 and late fees";
const DESCRIPTION =
  "Enter an invoice's date, amount and terms. It works out the due date and discount deadline, what skipping a discount such as 2/10 net 30 costs a year on three day counts, the late fee after any number of days, and the day to pay. Free, and it runs in your browser.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/payment-terms" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/payment-terms", type: "website", siteName: "Vestiarion", locale: "en_US" },
  twitter: { card: "summary_large_image", site: X_HANDLE, title: TITLE, description: DESCRIPTION },
};

const H2 = "text-lg font-semibold tracking-[-0.01em] text-ink";
const BODY = "mt-3 text-sm leading-relaxed text-ink-2";

/**
 * /payment-terms (docs/superpowers/specs/2026-10-28-payment-terms-design.md PT7): a free page anyone can use to work out
 * an invoice's dates, what its discount is worth and the day to pay it. Static: everything is worked out in the
 * browser, so nothing typed reaches the server. Not under /tools, which serves downloads.
 */
export default function PaymentTermsPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader>
        <SiteHeaderLink href="/">Home</SiteHeaderLink>
        <SiteHeaderLink href="/docs">Docs</SiteHeaderLink>
      </SiteHeader>
      <PublicMain width="record">
        <div className="mx-auto w-full max-w-2xl">
          <Eyebrow>Free tool</Eyebrow>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-3xl">Payment terms calculator</h1>
          <p className="mt-3 text-base leading-relaxed text-ink-2">
            Enter an invoice&apos;s date, amount and terms. It works out the due date and the discount deadline, what skipping the discount costs a
            year, what a late fee comes to, and the day to pay, with the reason.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-ink-3">Everything is worked out in this page. Nothing you type is sent anywhere or kept.</p>

          {/* A heading of its own, so the calculator's late-fee heading (an h3) follows an h2, as on the term pages. */}
          <section aria-labelledby="calculator" className="mt-8">
            <h2 id="calculator" className="sr-only">
              Work out an invoice
            </h2>
            <PaymentTermsCalculator />
          </section>

          <section aria-labelledby="how-the-calculator-works" className="mt-14 border-t border-line pt-8">
            <h2 id="how-the-calculator-works" className={H2}>
              How it works
            </h2>
            <p className={BODY}>
              Dates count every calendar day from the invoice date. With EOM terms, short for end of month, they count from the last day of the
              month the invoice is dated in: net 30 EOM on an invoice of Nov 2 is due Dec 30.
            </p>
            <p className={BODY}>
              2/10 net 30 takes 2% off when you pay within 10 days; otherwise the full amount is due in 30. On 100, that is 98 on day 10 or 100 on
              day 30, so skipping the discount is like borrowing 98 for 20 days and paying 2 for it. As a yearly rate, that is 2 ÷ 98 × 365 ÷ 20 =
              37.2% simple on a 365-day year, 36.7% on the 360-day year some lenders use, and 44.6% compounded. Lenders and textbooks state it on
              different bases, so all three are shown, each with its formula.
            </p>
            <p className={BODY}>
              The break-even rate is the simple 365-day figure. If your cash earns, or your borrowing costs, less than it, paying by the discount
              deadline comes out ahead.
            </p>
            <p className={BODY}>
              The day to pay comes from the written payment policy Vestiarion&apos;s agent is checked against: take a discount on its last day when it
              is worth at least what the cash would earn to the due date, otherwise pay on the due date, and pay a bill that is due or overdue at
              once. The sentence under it is the policy&apos;s own, with your rate applied to the discounted amount, the cash paying early would
              use, so the day changes exactly at the break-even rate.
            </p>
            <p className={BODY}>
              A late fee is worked out as the contract charges it: a percent a month for each month or part of one, a month counted as 30 days; a
              percent a month by the day, at the monthly percent × 12 ÷ 365 for each day; or a fixed amount, once. It starts the day after the due
              date, after any days of grace, and is charged on the amount alone.
            </p>
          </section>

          <section aria-labelledby="does-not-do" className="mt-10">
            <h2 id="does-not-do" className={H2}>
              What it does not do
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-2">
              <li>It does not read your invoice or contract: it works from what you type.</li>
              <li>It does not know the rules on late fees where you are, which can limit them. It charges only the fee you enter.</li>
              <li>It does not move a due date that falls on a weekend or holiday, or roll an invoice dated late in a month into the next one.</li>
              <li>It does not convert currencies: the currency is a label.</li>
            </ul>
          </section>

          <section aria-labelledby="common-terms" className="mt-10">
            <h2 id="common-terms" className={H2}>
              Common payment terms
            </h2>
            <TermLinks />
          </section>

          <PaymentTermsCta />
        </div>
      </PublicMain>
      <SiteFooter />
    </div>
  );
}
