import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Headline, NetworkNumbers, QuietNetwork } from "@/components/open/NetworkNumbers";
import { PeriodNav } from "@/components/open/PeriodNav";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { BrandMark } from "@/components/vx/BrandMarks";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { utcMinute } from "@/lib/copy";
import { ARC_MAINNET, ARC_TESTNET, type NetworkProfile } from "@/lib/network";
import { parsePeriod, readOpenNumbers, type OpenNumbers, type Period } from "@/lib/platform/open-numbers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Open numbers",
  description:
    "Vestiarion in production, read live from its database: customers' workspaces, payments settled, USDC paid, how the agent's payment decisions turned out and what stopped it, with Arc mainnet and Arc testnet counted apart, and customers counted apart from our own workspaces.",
  alternates: { canonical: "/open" },
};

interface OpenPageProps {
  searchParams: Promise<{ period?: string | string[]; since?: string | string[] }>;
}

/** Arc mainnet first, then Arc testnet: each counted on its own, never added to the other (network foundation N7). */
const NETWORKS: ReadonlyArray<{ section: "mainnet" | "testnet"; profile: NetworkProfile; about: string; money: string }> = [
  { section: "mainnet", profile: ARC_MAINNET, about: "Payments with real money, on Arc mainnet.", money: "Real money" },
  { section: "testnet", profile: ARC_TESTNET, about: "Payments on Arc testnet.", money: "Test money" },
];

/** One network's numbers, or null when they could not be read: the other network's section still shows. */
async function numbersFor(period: Period, profile: NetworkProfile): Promise<OpenNumbers | null> {
  try {
    return await readOpenNumbers(period, profile.id);
  } catch (error) {
    console.error(`open numbers: ${profile.id} could not be read`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** Nothing to count yet: no workspace live on the network and no payment settled on it. */
const empty = (numbers: OpenNumbers) => numbers.sides.total.liveWorkspaces === 0 && numbers.sides.total.payments === 0;

/** Enough to draw the whole dashboard: a payment settled on the network in the period. */
const settled = (numbers: OpenNumbers) => numbers.sides.total.payments > 0;

/** What the trust strip under the heading promises; the method below says how each is kept. */
const PROMISES: ReadonlyArray<{ title: string; body: string }> = [
  { title: "Customers counted apart", body: "Workspaces the team runs to build and test the product are counted apart from customers', and every figure says whose it is." },
  { title: "One network at a time", body: "Arc mainnet and Arc testnet are each counted on their own, and never added together." },
  { title: "Checkable on chain", body: "Our own payments link to the explorer. Customers' are counted, never listed." },
];

/**
 * The open numbers (docs/superpowers/specs/2026-09-30-open-numbers-design.md):
 * platform-wide usage, public, read on every request through the aggregate
 * functions, one network at a time. A network where a payment settled in the
 * period gets the full section, customers' figures first, and the first such
 * network's headline figures sit under the heading. A network with no payment
 * yet, or whose numbers cannot be read, is a compact card after them, so a
 * dashboard of zeros never shows. The database's own message is logged, never
 * shown.
 */
export default async function OpenPage({ searchParams }: OpenPageProps) {
  const period = parsePeriod(await searchParams);
  const read = await Promise.all(NETWORKS.map((network) => numbersFor(period, network.profile)));
  const readAt = read.find((numbers) => numbers !== null)?.generatedAt ?? null;
  const networks = NETWORKS.map((network, index) => ({ ...network, numbers: read[index] }));
  const full = networks.filter((network) => network.numbers !== null && settled(network.numbers));
  const lead = full[0];
  const compact = networks.filter((network) => !full.includes(network));

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex-1 px-4 py-12 sm:px-6 sm:py-16">
        <div className="mx-auto w-full max-w-6xl">
          <header className="max-w-3xl">
            <p className="flex flex-wrap items-center gap-3">
              <Eyebrow className="text-agent">Open numbers</Eyebrow>
              {readAt && (
                <Badge tone="proof" size="sm" className="font-mono">
                  <span aria-hidden className="size-1.5 rounded-full bg-proof" />
                  Live · read <time dateTime={readAt}>{utcMinute(readAt)}</time>
                </Badge>
              )}
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.035em] text-ink sm:text-5xl">Vestiarion, in production</h1>
            <p className="mt-5 text-lg leading-8 text-ink-2">
              Who uses Vestiarion, what its agent decided, what stopped it, and what settled. Every figure is read from Vestiarion&apos;s production
              database when this page loads, with nothing entered by hand.
            </p>
          </header>

          <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
            <PeriodNav period={period} />
            <p className="text-xs text-ink-3">Figures can be up to a minute old. Days are UTC.</p>
          </div>
          {period.fallback && <p className="mt-3 text-sm text-ink-2">That period could not be read, so this shows all time.</p>}

          {lead?.numbers && <Headline numbers={lead.numbers} period={period} network={lead.profile} />}

          <ul className="mt-4 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
            {PROMISES.map((promise) => (
              <li key={promise.title} className="bg-surface px-5 py-4">
                <p className="text-sm font-semibold text-ink">{promise.title}</p>
                <p className="mt-1 text-sm leading-6 text-ink-2">{promise.body}</p>
              </li>
            ))}
          </ul>

          {full.map(({ section, profile, about, money, numbers }) => (
            <section key={section} aria-labelledby={section} className="mt-20 border-t border-line pt-12">
              <NetworkHead id={section} label={profile.label} about={about} money={money} />
              {numbers && <NetworkNumbers numbers={numbers} period={period} network={profile} />}
            </section>
          ))}

          {compact.length > 0 && (
            <div className={full.length > 0 ? "mt-20 grid gap-6 border-t border-line pt-12 md:grid-cols-2" : "mt-14 grid gap-6 md:grid-cols-2"}>
              {compact.map(({ section, profile, about, money, numbers }) => (
                <section key={section} aria-labelledby={section} className="min-w-0">
                  <NetworkHead id={section} label={profile.label} about={about} money={money} compact />
                  {numbers === null ? (
                    <Callout tone="held" className="mt-4" title={`The ${profile.label} numbers could not be read right now.`}>
                      Nothing is wrong with your connection. Try again in a minute.
                    </Callout>
                  ) : !empty(numbers) ? (
                    <QuietNetwork numbers={numbers} period={period} network={profile} />
                  ) : (
                    <EmptyState
                      compact
                      className="mt-4"
                      title={`No workspace runs on ${profile.label} yet.`}
                      body={`Its payments will be counted here, apart from ${profile.id === "arc-mainnet" ? ARC_TESTNET.label : ARC_MAINNET.label}.`}
                    />
                  )}
                </section>
              ))}
            </div>
          )}

          <section aria-labelledby="method" className="mt-20 border-t border-line pt-12">
            <Eyebrow>Methodology</Eyebrow>
            <h2 id="method" className="mt-1.5 text-2xl font-semibold tracking-tight text-ink">
              How the figures are counted
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-2">
              The same definitions hold for every figure on this page, on both networks and for every period.
            </p>
            <div className="mt-5 grid gap-3 lg:grid-cols-2">
              <Method title="Networks, periods and freshness">
                <li>
                  Arc mainnet and Arc testnet are counted apart, and nothing is ever added across them. A workspace belongs to one network, chosen
                  when it goes live and kept from then on; a payment belongs to its workspace&apos;s network.
                </li>
                <li>Rows marked now are totals at the moment of reading; the others cover the period chosen above.</li>
                <li>A deleted workspace takes its activity out of these figures with it.</li>
                <li>Figures can be up to a minute old.</li>
              </Method>
              <Method title="Customers and our workspaces">
                <li>
                  A workspace is a customer&apos;s when someone outside the Vestiarion team opened it. The team&apos;s own workspaces, and any whose creator has
                  since deleted their account, are counted as ours; only workspaces the team opened list their payments.
                </li>
                <li>A person counts as a customer when they are not on the team and belong to a customer&apos;s workspace.</li>
                <li>Sample data that a workspace loads to try the product never counts.</li>
              </Method>
              <Method title="Payments and money">
                <li>A payment counts once Circle confirms it on its network. Sandbox workspaces simulate their payments, and those never count.</li>
                <li>
                  A workspace&apos;s first payment is the first one Circle confirms on its network, and the time to it runs from when the
                  workspace was opened. A workspace holding payments from before it was opened counts, but not towards the time.
                  A dash means there is no time to measure in the period.
                </li>
                <li>A contractor milestone counts once a settled payment has paid it.</li>
                <li>USDC in wallets is the USDC in live workspaces&apos; Circle wallets on that network, as last read from the chain.</li>
              </Method>
              <Method title="The agent's decisions">
                <li>
                  A payment decision is the agent&apos;s decision on an invoice to pay or a contractor milestone, counted by what happened.
                  Paid, sent or scheduled is carried out by the agent itself; held, flagged or waiting for information is escalated to a
                  person. A payment a model proposed and code refused counts as escalated.
                </li>
                <li>
                  The written rule-based policy decides every case beside the model. The model disagrees with it when the two choose a different
                  action; the model&apos;s choice still has to pass the same checks in code.
                </li>
                <li>A decision is refused by code when a hard limit blocked it, whether a model or the written policy proposed it.</li>
                <li>
                  A flag is the agent saying an invoice should not be paid. A person upholds it by rejecting the invoice and overturns it
                  by paying it; sending it back to the agent counts as neither. A hold or a request for information asks a person to
                  decide, so it is not counted as agreement either way.
                </li>
                <li>
                  An invoice is paid on time when its payment settles on or before its due day (UTC). No person involved means nobody
                  approved, rejected or returned it; entering the invoice does not count.
                </li>
                <li>
                  A duplicate is caught when the agent stopped an invoice that repeats one already paid or on its way to being paid, with
                  the same purchase order and amount, and it was never paid since.
                </li>
              </Method>
              <Method title="What is never shown">
                <li>Customers&apos; payments appear only as counts and totals, never one by one or as a day&apos;s amount.</li>
                <li>The database&apos;s own error messages are never shown; a network whose numbers cannot be read says so instead.</li>
              </Method>
            </div>
          </section>
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}

/** A network's heading, with Arc's mark and whether its payments move real money. */
function NetworkHead({ id, label, about, money, compact = false }: { id: string; label: string; about: string; money: string; compact?: boolean }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2.5">
          {/* Both networks are Arc's; the mark sits beside the name, which says which one. */}
          <BrandMark brand="arc" size={compact ? 16 : 24} />
          <h2 id={id} className={compact ? "text-xl font-semibold tracking-tight text-ink" : "text-3xl font-semibold tracking-[-0.03em] text-ink"}>
            {label}
          </h2>
        </div>
        <p className="mt-1.5 text-sm leading-6 text-ink-2">{about}</p>
      </div>
      <Badge tone={id === "mainnet" ? "proof" : "neutral"} size="sm" className="font-mono uppercase tracking-[0.08em]">
        {money}
      </Badge>
    </div>
  );
}

/** One group of definitions, folded until opened. */
function Method({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Disclosure summary={title} className="self-start">
      <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-ink-2 marker:text-ink-3">{children}</ul>
    </Disclosure>
  );
}
