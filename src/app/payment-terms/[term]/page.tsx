import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PaymentTermsCalculator } from "@/components/payment-terms/PaymentTermsCalculator";
import { PaymentTermsCta } from "@/components/payment-terms/PaymentTermsCta";
import { TermLinks } from "@/components/payment-terms/TermLinks";
import { PublicMain } from "@/components/public/PublicMain";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import { utcDay } from "@/lib/copy";
import { breakEvenRate } from "@/lib/payment-terms/cost";
import { EXAMPLE_AMOUNT, EXAMPLE_CURRENCY, EXAMPLE_INVOICE_DATE, EXAMPLE_LATE_FEE, TERM_PAGES, termPage, workedExample, type TermPage } from "@/lib/payment-terms/pages";
import { money, percentWords } from "@/lib/payment-terms/terms";
import { X_HANDLE } from "@/lib/site-links";

type Props = { params: Promise<{ term: string }> };

/** One page per common term (docs/superpowers/specs/2026-10-28-payment-terms-design.md PT8). */
export function generateStaticParams() {
  return TERM_PAGES.map((page) => ({ term: page.slug }));
}

/** Any other term answers 404: only the public term is ever in the path. */
export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = termPage((await params).term);
  if (!page) return {};
  const url = `/payment-terms/${page.slug}`;
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: url },
    openGraph: { title: page.title, description: page.description, url, type: "article", siteName: "Vestiarion", locale: "en_US" },
    twitter: { card: "summary_large_image", site: X_HANDLE, title: page.title, description: page.description },
  };
}

const H2 = "text-lg font-semibold tracking-[-0.01em] text-ink";
const BODY = "mt-3 text-sm leading-relaxed text-ink-2";
const day = (value: string) => utcDay(`${value}T00:00:00.000Z`);
const usd = (value: number) => `${money(value)} ${EXAMPLE_CURRENCY}`;

/** What skipping the discount costs on three bases, with the formula filled in, and the break-even rate. */
function DiscountFormula({ page }: { page: TermPage }) {
  const { discount } = page.terms;
  const { costs } = workedExample(page);
  if (!discount || !costs) return null;
  const days = page.terms.netDays - discount.days;
  return (
    <section aria-labelledby="formula" className="mt-10">
      <h2 id="formula" className={H2}>
        What skipping the discount costs
      </h2>
      <p className={BODY}>
        {`Skipping the discount means paying the full amount ${days} days later than the discounted one. That is like borrowing the discounted amount for ${days} days and paying the discount for it: as a yearly rate, the discount divided by what is left after it, times the days in a year, divided by ${days}.`}
      </p>
      <ul className="mt-4 space-y-3">
        {costs.map((cost) => (
          <li key={cost.basis} className="rounded-xl border border-line bg-surface px-4 py-3">
            <span className="block text-xs text-ink-3">{cost.label}</span>
            <span className="font-mono text-[0.8125rem] text-ink">{cost.formula}</span>
          </li>
        ))}
      </ul>
      <p className={BODY}>
        {`The break-even rate is ${percentWords(breakEvenRate(discount, page.terms.netDays))} a year, simple on 365 days. If your cash earns, or your borrowing costs, less than that, paying by the discount deadline comes out ahead.`}
      </p>
    </section>
  );
}

/** The worked example on the fixed invoice: its dates, and what its discount or a late fee comes to. */
function Example({ page }: { page: TermPage }) {
  const example = workedExample(page);
  const { discount, netDays, endOfMonth } = page.terms;
  const from = endOfMonth ? `${day(example.countFrom)}, the last day of its month` : "the invoice date";
  return (
    <section aria-labelledby="example" className="mt-10">
      <h2 id="example" className={H2}>
        A worked example
      </h2>
      <p className={BODY}>{`An invoice for ${usd(EXAMPLE_AMOUNT)} dated ${day(EXAMPLE_INVOICE_DATE)}, on ${page.words}:`}</p>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-2">
        {discount && example.discountDeadline && example.paid !== null && example.saves !== null && example.costs ? (
          <>
            <li>{`Pay ${usd(example.paid)} by ${day(example.discountDeadline)}, the discount deadline, ${discount.days} days after ${from}.`}</li>
            <li>{`Or pay ${usd(EXAMPLE_AMOUNT)} by ${day(example.dueOn)}, the due date, ${netDays} days after ${from}.`}</li>
            <li>
              {`Skipping the discount costs ${usd(example.saves)} for ${netDays - discount.days} more days: ${example.costs.map((cost) => percentWords(cost.rate)).join(", ")} a year, simple on 365 days, simple on 360 and compounded.`}
            </li>
          </>
        ) : (
          <>
            <li>{`It is due ${day(example.dueOn)}: ${netDays} days after ${from}, every calendar day counted.`}</li>
            {example.lateFees && example.lateFees.length === 2 && (
              <li>
                {`With a late fee of ${EXAMPLE_LATE_FEE.value}% a month for each month or part of one, paying ${example.lateFees[0].daysLate} days late costs ${usd(example.lateFees[0].fee)}, and ${example.lateFees[1].daysLate} days late ${usd(example.lateFees[1].fee)}: ${example.lateFees[1].formula}.`}
              </li>
            )}
          </>
        )}
      </ul>
    </section>
  );
}

/**
 * /payment-terms/<term> (docs/superpowers/specs/2026-10-28-payment-terms-design.md PT8): what one common term means, its
 * formula, a worked example, and the calculator with the term filled in. Static, like /payment-terms.
 */
export default async function PaymentTermPage({ params }: Props) {
  const page = termPage((await params).term);
  if (!page) notFound();
  return (
    <div className="flex min-h-dvh flex-col">
      {/* Two links, as on the other public pages, so the header fits a 375 px phone; the wordmark goes home. */}
      <SiteHeader>
        <SiteHeaderLink href="/payment-terms">Calculator</SiteHeaderLink>
        <SiteHeaderLink href="/docs">Docs</SiteHeaderLink>
      </SiteHeader>
      <PublicMain width="record">
        <div className="mx-auto w-full max-w-2xl">
          <Eyebrow>Payment terms</Eyebrow>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-3xl">{`What ${page.words} means`}</h1>
          <p className="mt-3 text-base leading-relaxed text-ink-2">{page.meaning}</p>
          {!page.terms.discount && (
            <p className={BODY}>
              {page.terms.endOfMonth
                ? `Find the last day of the month the invoice is dated in, then count ${page.terms.netDays} calendar days from it, weekends included, unless the contract says otherwise.`
                : `Count ${page.terms.netDays} calendar days from the invoice date, weekends included, unless the contract says otherwise.`}
            </p>
          )}

          <DiscountFormula page={page} />
          <Example page={page} />

          <section aria-labelledby="calculator" className="mt-14 border-t border-line pt-8">
            <h2 id="calculator" className={H2}>
              {`Work out your own ${page.words} invoice`}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-3">Everything is worked out in this page. Nothing you type is sent anywhere or kept.</p>
            <div className="mt-6">
              <PaymentTermsCalculator initialTerms={page.words} />
            </div>
          </section>

          <section aria-labelledby="other-terms" className="mt-10">
            <h2 id="other-terms" className={H2}>
              Other common terms
            </h2>
            <TermLinks except={page.slug} />
            <p className={BODY}>
              Or enter any terms in the{" "}
              <Link href="/payment-terms" className="font-medium text-agent underline-offset-4 hover:underline">
                payment terms calculator
              </Link>
              .
            </p>
          </section>

          <PaymentTermsCta />
        </div>
      </PublicMain>
      <SiteFooter tool="payment-terms" />
    </div>
  );
}
