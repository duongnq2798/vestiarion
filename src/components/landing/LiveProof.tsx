import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { formatFigure, formatPercent, formatRatio } from "@/components/open/OpenNumbersTable";
import { Badge } from "@/components/ui/Badge";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import { Skeleton } from "@/components/ui/Skeleton";
import { BrandMark } from "@/components/vx/BrandMarks";
import { Hash } from "@/components/vx/Primitives";
import { utcMinute } from "@/lib/copy";
import { ARC_MAINNET, ARC_TESTNET, type NetworkProfile } from "@/lib/network";
import type { OpenNumbers } from "@/lib/platform/open-numbers";
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
      <NetworkPanel id="mainnet" profile={ARC_MAINNET} money="Real money" numbers={mainnet} />
      <NetworkPanel id="testnet" profile={ARC_TESTNET} money="Test money" numbers={testnet} />
    </div>
  );
}

function NetworkPanel({ id, profile, money, numbers }: { id: string; profile: NetworkProfile; money: string; numbers: OpenNumbers | null }) {
  const titleId = `measurements-${id}`;
  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          {/* Both networks are Arc's; the mark sits beside the name, which says which one. */}
          <BrandMark brand="arc" size={20} />
          <h3 id={titleId} className="text-xl font-semibold tracking-tight text-ink">
            {profile.label}
          </h3>
        </div>
        <Badge tone={id === "mainnet" ? "proof" : "neutral"} size="sm" className="font-mono uppercase tracking-[0.08em]">
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

function PanelFigures({ numbers, profile }: { numbers: OpenNumbers; profile: NetworkProfile }) {
  const { customers, total } = numbers.sides;
  const latest = numbers.ourPayments[0];
  const latestUrl = latestOwnPaymentUrl(numbers, profile);
  return (
    <>
      <dl className="grid flex-1 grid-cols-1 gap-px border-t border-line bg-line sm:grid-cols-3">
        <Figure label="Customer workspaces" value={customers.workspacesOpened === 0 ? "Not yet" : formatFigure(customers.workspacesOpened, "count")}>
          {customers.workspacesOpened === 0
            ? "None opened by anyone outside the team yet"
            : `${formatFigure(customers.liveWorkspaces, "count")} live now, ${formatFigure(customers.firstPayments, "count")} made a first payment`}
        </Figure>
        <Figure label="Payments settled" value={formatFigure(total.payments, "count")}>
          {`${customers.payments === 0 ? "None" : formatFigure(customers.payments, "count")} by customers, ${formatFigure(total.usdcPaid, "usdc")} USDC in all`}
        </Figure>
        <Judgement numbers={numbers} />
      </dl>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-5 py-3.5 text-sm text-ink-2 sm:px-6">
        {latest && latestUrl ? (
          <>
            <span>Our latest payment</span>
            <span aria-hidden>·</span>
            <time dateTime={latest.at} className="font-mono text-xs text-ink-3">
              {utcMinute(latest.at)}
            </time>
            <Hash value={latest.txHash} href={latestUrl} className="text-sm" />
          </>
        ) : (
          <span>No payment by our own workspaces yet.</span>
        )}
      </p>
    </>
  );
}

/**
 * How the agent's calls held up: in shadow mode, how often customers agreed with them, once any customer gave a
 * verdict; otherwise the share of invoices paid on time, every workspace's, as /open says it.
 */
function Judgement({ numbers }: { numbers: OpenNumbers }) {
  const { customers, total } = numbers.sides;
  const given = customers.verdictsGiven;
  const agreed = customers.verdictsAgreed;
  if (given !== null && agreed !== null && given > 0) {
    return (
      <Figure label="Customers agreed with the agent" value={formatPercent(agreed, given)}>
        {`${formatRatio(agreed, given)} decisions, in shadow mode`}
      </Figure>
    );
  }
  const onTime = total.invoicesPaidOnTime;
  const paid = total.invoicesPaidOnArc;
  if (onTime !== null && paid !== null && paid > 0) {
    return (
      <Figure label="Invoices paid on time" value={formatPercent(onTime, paid)}>
        {`${formatRatio(onTime, paid)}, every workspace`}
      </Figure>
    );
  }
  return (
    <Figure label="Invoices paid on time" value="—">
      Nothing to measure yet
    </Figure>
  );
}

/** One figure: its value large above its label, then what it means. The label comes first for a screen reader. */
function Figure({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col bg-surface px-5 py-5 sm:px-6">
      <dt className="order-2 mt-2.5 text-sm font-semibold text-ink">{label}</dt>
      {/* Kept to one line: three figures share half the page's width beside the other network from lg up. */}
      <dd className="order-1 whitespace-nowrap font-mono text-3xl font-semibold leading-none tracking-[-0.04em] text-ink tabular-nums lg:text-[1.75rem]">{value}</dd>
      <dd className="order-3 mt-1 text-sm leading-6 text-ink-2">{children}</dd>
    </div>
  );
}
