import type { Metadata } from "next";
import { OpenNumbersTable, OUTCOME_ROWS } from "@/components/open/OpenNumbersTable";
import { OurPayments } from "@/components/open/OurPayments";
import { PaymentsChart } from "@/components/open/PaymentsChart";
import { PeriodNav } from "@/components/open/PeriodNav";
import { Callout } from "@/components/ui/Callout";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { utcMinute } from "@/lib/copy";
import { dailySeries, parsePeriod, readOpenNumbers, type OpenNumbers } from "@/lib/platform/open-numbers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Open numbers",
  description:
    "How much Vestiarion is used, read live from its production database: workspaces, payments settled on Arc testnet, USDC paid, and how the agent's payment decisions turned out, with customers counted apart from our own workspaces.",
  alternates: { canonical: "/open" },
};

interface OpenPageProps {
  searchParams: Promise<{ period?: string | string[]; since?: string | string[] }>;
}

/**
 * The open numbers (docs/superpowers/specs/2026-09-30-open-numbers-design.md):
 * platform-wide usage, public, read on every request through the one
 * aggregate function. When it cannot be read the page still renders and says
 * so; the database's own message is logged, never shown.
 */
export default async function OpenPage({ searchParams }: OpenPageProps) {
  const period = parsePeriod(await searchParams);
  let numbers: OpenNumbers | null = null;
  try {
    numbers = await readOpenNumbers(period);
  } catch (error) {
    console.error("open numbers: could not be read", error instanceof Error ? error.message : error);
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex-1 px-4 py-12 sm:px-6 sm:py-16">
        <div className="mx-auto w-full max-w-5xl">
          <header className="border-b border-line pb-6">
            <p>
              <Eyebrow className="text-agent">Open numbers</Eyebrow>
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-ink sm:text-[2.125rem]">How much Vestiarion is used</h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-ink-2">
              Every figure here is read from Vestiarion&apos;s production database when the page loads. Workspaces that customers opened are counted apart
              from ours, the ones the team runs to build and test the product.
            </p>
          </header>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <PeriodNav period={period} />
            {numbers && (
              <p className="font-mono text-xs text-ink-3">
                Read <time dateTime={numbers.generatedAt}>{utcMinute(numbers.generatedAt)}</time>
              </p>
            )}
          </div>
          {period.fallback && <p className="mt-3 text-sm text-ink-2">That period could not be read, so this shows all time.</p>}

          {numbers ? (
            <>
              <div className="mt-6">
                <OpenNumbersTable numbers={numbers} period={period} />
              </div>
              <section aria-labelledby="outcomes" className="mt-12">
                <h2 id="outcomes" className="text-xl font-semibold tracking-tight text-ink">
                  Outcomes
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-2">
                  How the agent&apos;s payment decisions turned out: what it carried out itself, what it handed to a person, what people did
                  with its warnings, and whether invoices were paid on time.
                </p>
                <div className="mt-4">
                  <OpenNumbersTable numbers={numbers} period={period} rows={OUTCOME_ROWS} label="Outcomes" />
                </div>
              </section>
              <PaymentsChart series={dailySeries(numbers.daily, period)} />
              <OurPayments payments={numbers.ourPayments} />
            </>
          ) : (
            <Callout tone="held" className="mt-6" title="The numbers could not be read right now.">
              Nothing is wrong with your connection. Try again in a minute.
            </Callout>
          )}

          <section aria-labelledby="method" className="mt-12 border-t border-line pt-8">
            <h2 id="method" className="text-xl font-semibold tracking-tight text-ink">
              What counts
            </h2>
            <ul className="mt-4 list-disc space-y-2 pl-6 text-sm leading-6 text-ink-2 marker:text-ink-3">
              <li>A payment counts once Circle confirms it on Arc testnet. Sandbox workspaces simulate their payments, and those never count.</li>
              <li>
                A workspace is a customer&apos;s when someone outside the Vestiarion team opened it. The team&apos;s own workspaces, and any whose creator has
                since deleted their account, are counted as ours; only workspaces the team opened list their payments.
              </li>
              <li>A person counts as a customer when they are not on the team and belong to a customer&apos;s workspace.</li>
              <li>A contractor milestone counts once a settled Arc testnet payment has paid it.</li>
              <li>
                A payment decision is the agent&apos;s decision on an invoice to pay or a contractor milestone, counted by what happened.
                Paid, sent or scheduled is carried out by the agent itself; held, flagged or waiting for information is escalated to a
                person. A payment a model proposed and code refused counts as escalated.
              </li>
              <li>
                A flag is the agent saying an invoice should not be paid. A person upholds it by rejecting the invoice and overturns it
                by paying it; sending it back to the agent counts as neither. A hold or a request for information asks a person to
                decide, so it is not counted as agreement either way.
              </li>
              <li>
                An invoice is paid on time when its Arc testnet payment settles on or before its due day (UTC). No person involved means
                nobody approved, rejected or returned it; entering the invoice does not count.
              </li>
              <li>
                A duplicate is caught when the agent stopped an invoice that repeats one already paid or on its way to being paid, with
                the same purchase order and amount, and it was never paid since.
              </li>
              <li>
                A workspace&apos;s first payment is the first one Circle confirms on Arc testnet, and the time to it runs from when the
                workspace was opened. A workspace holding payments from before it was opened counts, but not towards the time.
                A dash means there is no time to measure in the period.
              </li>
              <li>USDC in wallets is Arc testnet USDC in live workspaces&apos; Circle wallets, as last read from the chain.</li>
              <li>Customers&apos; payments appear only as counts and totals, never one by one or as a day&apos;s amount.</li>
              <li>Sample data that a workspace loads to try the product never counts.</li>
              <li>Rows marked now are totals at the moment of reading; the others cover the period chosen above.</li>
              <li>A deleted workspace takes its activity out of these figures with it.</li>
              <li>Figures can be up to a minute old.</li>
            </ul>
          </section>
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
