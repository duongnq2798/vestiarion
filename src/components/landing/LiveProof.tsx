import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { formatFigure, formatPercent, formatRatio } from "@/components/open/OpenNumbersTable";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import { Skeleton } from "@/components/ui/Skeleton";
import { BrandMark } from "@/components/vx/BrandMarks";
import { Hash } from "@/components/vx/Primitives";
import { utcDay, utcMinute } from "@/lib/copy";
import { ARC_MAINNET, ARC_TESTNET, type NetworkProfile } from "@/lib/network";
import type { OpenNumbers } from "@/lib/platform/open-numbers";
import { CountUp } from "./CountUp";
import { latestOwnPaymentUrl } from "./provenance";

/** Both networks' all-time open numbers; either is null when it could not be read. */
export interface LandingNumbers {
  mainnet: OpenNumbers | null;
  testnet: OpenNumbers | null;
}

/**
 * The landing's measurements are the open numbers (docs/superpowers/specs/2026-10-08-landing-proof-design.md P3): every
 * workspace's, read from the production database, Arc mainnet first and then Arc testnet, each counted on its own and
 * never added to the other. As on /open, the headline figures are customers', with the team's total beside them, and
 * the team's latest payment on each network links to its explorer. Customers' payments are counted, never listed.
 */
export function LiveProof({ numbers }: { numbers: Promise<LandingNumbers> }) {
  return (
    <section id="measurements" aria-labelledby="measurements-title" className="mx-auto max-w-6xl scroll-mt-16 px-4 pb-14 pt-16 sm:px-6 sm:pb-20 sm:pt-24">
      <Reveal>
        <div className="mb-8 max-w-3xl sm:mb-10">
          <Eyebrow className="text-xs">Open numbers, read live</Eyebrow>
          <h2 id="measurements-title" className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">
            Real workspaces, real payments, counted in the open.
          </h2>
          <p className="mt-4 max-w-2xl text-[0.9375rem] leading-relaxed text-ink-2">
            {`Read from Vestiarion's production database as this page loads. Customers' workspaces are counted apart from the team's own, and ${ARC_MAINNET.label} apart from ${ARC_TESTNET.label}, never added together.`}
          </p>
          <p className="mt-3 max-w-2xl text-[0.9375rem] leading-relaxed text-ink-2">
            Since 24 September, each production decision sits in the ledger beside the written policy&apos;s answer to the same facts. Where they differed, and the payment code refused:{" "}
            <Link href="/docs/research/model-vs-policy" className="font-semibold text-agent underline-offset-4 hover:underline">
              When the model and the policy disagree →
            </Link>
          </p>
        </div>
        <Suspense fallback={<NumbersFallback />}>
          <Figures source={numbers} />
        </Suspense>
        <p className="mt-5 text-[0.9375rem] text-ink-2">
          Every figure, by period:{" "}
          <Link href="/open" className="font-semibold text-agent underline-offset-4 hover:underline">
            Open numbers →
          </Link>
        </p>
      </Reveal>
    </section>
  );
}

async function Figures({ source }: { source: Promise<LandingNumbers> }) {
  const { mainnet, testnet } = await source;
  return <NetworkPanels mainnet={mainnet} testnet={testnet} />;
}

function NumbersFallback() {
  return (
    <div aria-busy="true">
      <p className="sr-only">Loading the open numbers</p>
      <Skeleton className="h-[52rem] rounded-2xl sm:h-[30rem] lg:h-[17rem]" />
    </div>
  );
}

/** Arc mainnet beside Arc testnet, each in its own panel. */
export function NetworkPanels({ mainnet, testnet }: LandingNumbers) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <NetworkPanel id="mainnet" profile={ARC_MAINNET} money="Real USDC" numbers={mainnet} />
      <NetworkPanel id="testnet" profile={ARC_TESTNET} money="Test USDC" numbers={testnet} />
    </div>
  );
}

function NetworkPanel({ id, profile, money, numbers }: { id: string; profile: NetworkProfile; money: string; numbers: OpenNumbers | null }) {
  const titleId = `measurements-${id}`;
  const real = id === "mainnet";
  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface">
      {/* Real money's network carries a thin rule in the proof colour; the test network stays neutral. */}
      {real && <span aria-hidden className="h-0.5 bg-proof" />}
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          {/* Both networks are Arc's; the mark sits beside the name, which says which one. */}
          <BrandMark brand="arc" size={20} />
          <h3 id={titleId} className="text-xl font-semibold tracking-tight text-ink">
            {profile.label}
          </h3>
        </div>
        <Badge tone={real ? "proof" : "neutral"} size="sm" className="font-mono uppercase tracking-[0.08em]">
          {money}
        </Badge>
      </header>
      {numbers === null ? (
        <p className="border-t border-line px-5 py-6 text-sm leading-6 text-ink-2 sm:px-6">
          {`The ${profile.label} numbers could not be read right now.`} Try{" "}
          <Link href="/open" className="font-semibold text-agent underline-offset-4 hover:underline">
            Open numbers
          </Link>{" "}
          in a minute.
        </p>
      ) : (
        <PanelFigures numbers={numbers} profile={profile} />
      )}
    </section>
  );
}

/**
 * One network's figures, led by whoever has paid on it (landing proof cards,
 * docs/superpowers/specs/2026-10-17-landing-proof-cards-design.md): customers' figures once any customer has paid there,
 * with the team's own on a line under them; until then the team's own payments, under a heading that says they are the
 * team's, with where customers stand on the line under them. A figure that counts the team never stands where a reader
 * takes it for customers' (landing clarity P2), and the two are never added together.
 */
function PanelFigures({ numbers, profile }: { numbers: OpenNumbers; profile: NetworkProfile }) {
  const { customers, ours } = numbers.sides;
  return customers.payments === 0 && ours.payments > 0 ? <TeamFigures numbers={numbers} profile={profile} /> : <CustomerFigures numbers={numbers} profile={profile} />;
}

/** The figures customers brought to a network, then the team's own on a line of its own. */
function CustomerFigures({ numbers, profile }: { numbers: OpenNumbers; profile: NetworkProfile }) {
  const { customers, ours } = numbers.sides;
  const latest = numbers.ourPayments[0];
  const latestUrl = latestOwnPaymentUrl(numbers, profile);
  return (
    <>
      <FiguresHeading>Customers</FiguresHeading>
      <FigureGrid count={3}>
        <Figure label="Workspaces" value={customers.workspacesOpened === 0 ? "Not yet" : formatFigure(customers.workspacesOpened, "count")}>
          {customers.workspacesOpened === 0
            ? "None opened outside the team yet"
            : `${formatFigure(customers.liveWorkspaces, "count")} live, ${formatFigure(customers.firstPayments, "count")} ${customers.firstPayments === 1 ? "has" : "have"} paid`}
        </Figure>
        <Figure label="Payments settled" value={customers.payments === 0 ? "None yet" : formatFigure(customers.payments, "count")}>
          {customers.payments === 0 ? "No customer has paid here yet" : `${formatFigure(customers.usdcPaid, "usdc")} USDC paid`}
        </Figure>
        <Judgement numbers={numbers} />
      </FigureGrid>
      <SideLine who="Vestiarion team">
        <span>
          {ours.payments === 0
            ? "No payment by our own workspaces yet."
            : `${formatFigure(ours.payments, "count")} ${ours.payments === 1 ? "payment" : "payments"}, ${formatFigure(ours.usdcPaid, "usdc")} USDC, from our own workspaces`}
        </span>
        {latest && latestUrl && (
          <>
            <span aria-hidden className="hidden sm:inline">
              ·
            </span>
            <span>latest</span>
            <time dateTime={latest.at} className="font-mono text-xs text-ink-3">
              {utcMinute(latest.at)}
            </time>
            <Hash value={latest.txHash} href={latestUrl} className="text-sm" />
          </>
        )}
      </SideLine>
    </>
  );
}

/**
 * A network no customer has paid on yet, led by the team's own payments there: how many, how much, and the latest on
 * its explorer, under a heading that names the team; then where customers stand, on a line of their own.
 */
function TeamFigures({ numbers, profile }: { numbers: OpenNumbers; profile: NetworkProfile }) {
  const { customers, ours } = numbers.sides;
  const latest = numbers.ourPayments[0];
  const latestUrl = latestOwnPaymentUrl(numbers, profile);
  const shown = latest && latestUrl;
  return (
    <>
      <FiguresHeading>Paid by the Vestiarion team</FiguresHeading>
      <FigureGrid count={shown ? 3 : 2}>
        <Figure label="Payments settled" value={formatFigure(ours.payments, "count")}>
          From our own workspaces
        </Figure>
        <Figure label="USDC paid" value={formatFigure(ours.usdcPaid, "usdc")}>
          <Link href={`/open#our-payments-${profile.id}`} className="font-medium text-agent underline-offset-4 hover:underline">
            Each one on Open numbers
          </Link>
        </Figure>
        {shown && (
          <Figure label="Latest payment" value={utcDay(latest.at).replace(/, \d{4}$/, "")} counted={false}>
            <span className="flex flex-wrap items-center gap-x-2">
              <time dateTime={latest.at} className="font-mono text-xs text-ink-3">
                {`${new Date(latest.at).toISOString().slice(11, 16)} UTC`}
              </time>
              <Hash value={latest.txHash} href={latestUrl} className="whitespace-nowrap text-sm" />
            </span>
          </Figure>
        )}
      </FigureGrid>
      <SideLine who="Customers">
        <span>
          {customers.workspacesOpened === 0
            ? `None on ${profile.label} yet`
            : `${formatFigure(customers.workspacesOpened, "count")} ${customers.workspacesOpened === 1 ? "workspace" : "workspaces"} opened, no payment yet`}
        </span>
      </SideLine>
    </>
  );
}

/** Whose figures follow: customers', or the team's own. */
function FiguresHeading({ children }: { children: ReactNode }) {
  return <p className="border-t border-line px-5 pb-1 pt-4 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3 sm:px-6">{children}</p>;
}

/** Two or three figures, side by side from `sm`, one under the other on a phone. */
function FigureGrid({ count, children }: { count: 2 | 3; children: ReactNode }) {
  return <dl className={cn("grid flex-1 grid-cols-1 gap-px bg-line", count === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>{children}</dl>;
}

/** The side that does not lead a panel, on a line of its own under its figures: the team's, or the customers'. */
function SideLine({ who, children }: { who: string; children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line bg-ground/50 px-5 py-3.5 text-sm text-ink-2 sm:px-6">
      <span className="basis-full font-medium text-ink sm:basis-auto">{who}</span>
      <span aria-hidden className="hidden sm:inline">
        ·
      </span>
      {children}
    </p>
  );
}

/**
 * How the agent's calls held up for customers, as the third of their figures: in shadow mode, how many of its decisions
 * customers agreed with, as a count out of the verdicts given; else the share of customers' invoices paid on time; else
 * that no customer has given a verdict yet. Never the team's own figures, which sit under "Customers" too.
 */
function Judgement({ numbers }: { numbers: OpenNumbers }) {
  const { customers } = numbers.sides;
  const given = customers.verdictsGiven;
  const agreed = customers.verdictsAgreed;
  if (given !== null && agreed !== null && given > 0) {
    return (
      <Figure label="Agreed with the agent" value={formatRatio(agreed, given)}>
        {`in shadow mode, ${formatPercent(agreed, given)}`}
      </Figure>
    );
  }
  const onTime = customers.invoicesPaidOnTime;
  const paid = customers.invoicesPaidOnArc;
  if (onTime !== null && paid !== null && paid > 0) {
    return (
      <Figure label="Invoices paid on time" value={formatPercent(onTime, paid)}>
        {`customers' invoices, ${formatRatio(onTime, paid)}`}
      </Figure>
    );
  }
  return (
    <Figure label="Agreed with the agent" value="None yet">
      No verdict from a customer yet
    </Figure>
  );
}

/**
 * One figure: its value large above its label, then what it means. The label comes first for a screen reader. On a
 * phone the value sits at the right of its label, as a row, so three figures do not stand three screens tall. The value
 * is set in the sans with even-width digits; times and hashes keep the mono. `counted` is false for a value that is not
 * an amount, such as a date, which is shown as it is rather than counted up.
 */
function Figure({ label, value, counted = true, children }: { label: string; value: string; counted?: boolean; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 bg-surface px-5 py-4 sm:flex sm:flex-col sm:items-stretch sm:px-6 sm:py-5">
      <dt className="text-sm font-semibold text-ink sm:order-2 sm:mt-2.5">{label}</dt>
      {/* Kept to one line: three figures share half the page's width beside the other network from lg up. */}
      <dd className="row-span-2 whitespace-nowrap text-right text-2xl font-semibold leading-none tracking-[-0.035em] text-ink tabular-nums sm:order-1 sm:text-left sm:text-3xl lg:text-[2rem]">
        {counted ? <CountUp value={value} /> : value}
      </dd>
      <dd className="mt-0.5 text-sm leading-6 text-ink-2 sm:order-3 sm:mt-1">{children}</dd>
    </div>
  );
}
