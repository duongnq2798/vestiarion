import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { formatFigure, formatRatio } from "@/components/open/OpenNumbersTable";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Heading } from "@/components/ui/Heading";
import { Section } from "@/components/ui/Section";
import { Reveal } from "@/components/ui/Reveal";
import { Skeleton } from "@/components/ui/Skeleton";
import { Hash } from "@/components/vx/Primitives";
import { utcMinute } from "@/lib/copy";
import { ARC_MAINNET, ARC_TESTNET, type NetworkProfile } from "@/lib/network";
import type { LatestDecisionShown } from "@/lib/platform/latest-decision";
import type { OpenNumbers } from "@/lib/platform/open-numbers";
import { earlierThan, type RecentDecisions } from "@/lib/platform/recent-decisions";
import { GITHUB_URL } from "@/lib/site-links";
import { CountUp } from "./CountUp";
import { EvidencePending } from "./EvidencePending";
import { LatestDecisionCard } from "./LatestDecision";
import type { LandingNumbers } from "./LiveProof";
import { landingPrefetch } from "./prefetch";
import { latestOwnPaymentUrl } from "./provenance";
import { RecentDecisionList } from "./RecentDecisions";
import { SignatureCheck } from "./SignatureCheck";

/** Public measurements and signed team decisions, independently streamed after the bill journey. */

/** Where to check the rest without us, after the public numbers. */
const CHECK_IT: ReadonlyArray<{
  href: string;
  label: string;
  external?: boolean;
}> = [
  {
    href: "/docs/guides/audit-export",
    label: "Verify a ledger export yourself",
  },
  {
    href: "/docs/research/model-vs-policy",
    label: "When the model and the written policy disagree",
  },
  { href: GITHUB_URL, label: "The source code, MIT licensed", external: true },
];

/** What the proof reads besides the open numbers: the team's latest decision, or null when there is none to show. */
export interface ProofFacts {
  latest: LatestDecisionShown | null;
}

/**
 * The section's words and links are drawn at once; each part read from production streams in
 * behind its own fallback (landing stream S1), so no read holds back the page above it, the hero included.
 */
export function Proof({ numbers, facts, recent }: { numbers: Promise<LandingNumbers>; facts: Promise<ProofFacts>; recent?: Promise<RecentDecisions | null> }) {
  return (
    <Section id="proof" tone="ground" aria-labelledby="proof-title" className="scroll-mt-16 border-b border-line">
        <Reveal>
          <div className="max-w-3xl">
            <Eyebrow className="text-agent">Proof, not promises</Eyebrow>
            <Heading id="proof-title" className="mt-3 max-w-4xl text-balance">
              Don&apos;t take our word for it.
            </Heading>
            <p className="mt-4 max-w-2xl text-pretty text-[0.9375rem] leading-relaxed text-ink-2 sm:text-lg">
              Real agent decisions. Onchain payment receipts. Publicly verifiable records.
            </p>
          </div>
        </Reveal>

        {recent && <Suspense fallback={null}><Earlier source={recent} latest={facts} /></Suspense>}

        <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          <Group id="proof-customers" title="Customer activity" lede="Businesses outside our team, never mixed with our own.">
            <Suspense fallback={<GroupFallback what="customer activity" />}>
              <Customers source={numbers} />
            </Suspense>
          </Group>
          <Group id="proof-decisions" title="Agent decisions" lede="Each one signed; rules in code check every payment.">
            <Suspense fallback={<GroupFallback what="the agent's decisions" />}>
              <Decisions source={numbers} />
            </Suspense>
            <Suspense fallback={<LatestFallback />}>
              <Latest source={facts} />
            </Suspense>
          </Group>
          <Group id="proof-payments" title="Payments settled" lede="Confirmed on Arc, each network apart." className="md:col-span-2 lg:col-span-1">
            <Suspense fallback={<GroupFallback what="the payments settled" />}>
              <Payments source={numbers} />
            </Suspense>
          </Group>
        </div>

        <div className="mt-8 flex flex-col gap-x-8 gap-y-3 border-t border-line pt-6 lg:flex-row lg:items-center lg:justify-between">
          <Link href="/open" className="inline-flex min-h-11 items-center gap-1 text-base font-semibold text-agent underline-offset-4 hover:underline">
            Explore the public proof
            <ArrowUpRight aria-hidden className="size-4" />
          </Link>
          <ul className="flex flex-col gap-x-6 gap-y-1 sm:flex-row sm:flex-wrap">
            {CHECK_IT.map((item) => (
              <li key={item.href}>
                {item.external ? (
                  <a
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-ink-2 underline-offset-4 hover:text-agent hover:underline"
                  >
                    {item.label}
                    <ArrowUpRight aria-hidden className="size-3.5" />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <Link
                    href={item.href}
                    prefetch={landingPrefetch(item.href)}
                    className="inline-flex min-h-11 items-center text-sm font-medium text-ink-2 underline-offset-4 hover:text-agent hover:underline"
                  >
                    {item.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
        <Suspense fallback={null}>
          <ReadAt source={numbers} />
        </Suspense>
    </Section>
  );
}

function Group({ id, title, lede, className, children }: { id: string; title: string; lede: string; className?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={cn("flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-5 sm:p-6", className)}>
      <h3 id={id} className="text-base font-semibold tracking-tight text-ink">
        {title}
      </h3>
      <p className="mt-1 text-pretty text-sm leading-relaxed text-ink-2">{lede}</p>
      {children}
    </section>
  );
}

/**
 * One figure in a group: its label and what it means on the left, its value on the right. A screen reader hears the
 * label, then the value, then what it means.
 */
function Figure({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 border-t border-line py-3">
      <dt className="col-start-1 row-start-1 text-sm font-semibold text-ink">{label}</dt>
      <dd className="col-start-2 row-span-2 row-start-1 whitespace-nowrap text-2xl font-semibold leading-none tracking-[-0.035em] text-ink tabular-nums">
        <CountUp value={value} />
      </dd>
      <dd className="col-start-1 row-start-2 mt-0.5 text-pretty text-[0.8125rem] leading-5 text-ink-3">{children}</dd>
    </div>
  );
}

/** Said in a group whose network could not be read; the other network still shows. */
function Unread({ network }: { network: string }) {
  return (
    <p className="mt-4 border-t border-line pt-3.5 text-sm leading-6 text-ink-2">
      {`The ${network} numbers could not be read right now.`} Try{" "}
      <Link href="/open" className="font-semibold text-agent underline-offset-4 hover:underline">
        Open numbers
      </Link>{" "}
      in a minute.
    </p>
  );
}

/**
 * Customers' own figures, on Arc testnet where they have paid so far, and where they stand on Arc mainnet. Never the
 * team's: those are in Payments settled, named as the team's.
 */
export function CustomerFigures({ mainnet, testnet }: LandingNumbers) {
  if (!testnet) return <Unread network={ARC_TESTNET.label} />;
  const c = testnet.sides.customers;
  const onMainnet = mainnet?.sides.customers;
  return (
    <>
      <dl className="mt-4">
        <Figure label="Workspaces opened" value={formatFigure(c.workspacesOpened, "count")}>
          {`${formatFigure(c.liveWorkspaces, "count")} live, on ${ARC_TESTNET.label}`}
        </Figure>
        <Figure label="Reached a first payment" value={c.firstPayments === null ? "—" : formatFigure(c.firstPayments, "count")}>
          {c.medianMinutesToFirstPayment === null
            ? "after opening a workspace"
            : `a median ${formatFigure(c.medianMinutesToFirstPayment, "duration")} after opening`}
        </Figure>
        <Figure label="Payments settled" value={formatFigure(c.payments, "count")}>
          {`${formatFigure(c.usdcPaid, "usdc")} test USDC paid`}
        </Figure>
      </dl>
      <p className="mt-auto border-t border-line pt-3.5 text-[0.8125rem] leading-5 text-ink-3">
        {onMainnet === undefined
          ? `${ARC_MAINNET.label}: not read right now`
          : onMainnet.workspacesOpened === 0
            ? `No customer on ${ARC_MAINNET.label} yet`
            : `${ARC_MAINNET.label}: ${formatFigure(onMainnet.workspacesOpened, "count")} opened, ${formatFigure(onMainnet.payments, "count")} paid`}
      </p>
    </>
  );
}

/**
 * The agent's decisions in every workspace, customers' and ours, each network's count beside the sum, and how often
 * customers agreed with it in shadow mode, where nothing is paid until a person agrees, unless an owner lets the agent
 * pay vendors that earned it under their rule.
 */
export function DecisionFigures({ mainnet, testnet }: LandingNumbers) {
  if (!mainnet || !testnet) return <Unread network={!mainnet ? ARC_MAINNET.label : ARC_TESTNET.label} />;
  const decided = {
    main: mainnet.sides.total.modelDecisions,
    test: testnet.sides.total.modelDecisions,
  };
  const refused = {
    main: mainnet.sides.total.refusedByCode,
    test: testnet.sides.total.refusedByCode,
  };
  const given = testnet.sides.customers.verdictsGiven;
  const agreed = testnet.sides.customers.verdictsAgreed;
  const split = (n: { main: number; test: number }) =>
    `${formatFigure(n.test, "count")} on ${ARC_TESTNET.label}, ${formatFigure(n.main, "count")} on ${ARC_MAINNET.label}`;
  return (
    <dl className="mt-4">
      <Figure label="Decisions made" value={formatFigure(decided.main + decided.test, "count")}>
        {split(decided)}
      </Figure>
      <Figure label="Refused by code" value={formatFigure(refused.main + refused.test, "count")}>
        {split(refused)}
      </Figure>
      {/* Unread is not none: a verdict count that could not be read says so, never "None yet". */}
      <Figure label="Customers agreed" value={given === null || agreed === null ? "—" : given > 0 ? formatRatio(agreed, given) : "None yet"}>
        {given === null || agreed === null ? "with its decisions in shadow mode: not read just now" : "with its decisions, in shadow mode"}
      </Figure>
    </dl>
  );
}

/**
 * Payments confirmed on each network, apart: Arc mainnet's real USDC, then Arc testnet's test USDC, each saying whose
 * they are and linking the team's latest one to its explorer.
 */
export function PaymentFigures({ mainnet, testnet }: LandingNumbers) {
  return (
    <>
      <dl className="mt-4 md:grid md:grid-cols-2 md:gap-x-6 lg:block">
        {mainnet && <PaymentRow numbers={mainnet} profile={ARC_MAINNET} unit="real USDC" />}
        {testnet && <PaymentRow numbers={testnet} profile={ARC_TESTNET} unit="test USDC" />}
      </dl>
      {!mainnet && <Unread network={ARC_MAINNET.label} />}
      {!testnet && <Unread network={ARC_TESTNET.label} />}
    </>
  );
}

function PaymentRow({ numbers, profile, unit }: { numbers: OpenNumbers; profile: NetworkProfile; unit: string }) {
  const { customers, ours, total } = numbers.sides;
  const latest = numbers.ourPayments[0];
  const latestUrl = latestOwnPaymentUrl(numbers, profile);
  const whose =
    customers.payments === 0
      ? `all by our own workspaces, ${formatFigure(ours.usdcPaid, "usdc")} ${unit}`
      : `${formatFigure(customers.payments, "count")} by customers, ${formatFigure(ours.payments, "count")} by our team, ${formatFigure(total.usdcPaid, "usdc")} ${unit}`;
  return (
    <Figure label={`On ${profile.label}`} value={formatFigure(total.payments, "count")}>
      {whose}
      {latest && latestUrl && (
        <span className="mt-1 flex flex-wrap items-center gap-x-1.5">
          <span>Latest:</span>
          <Hash value={latest.txHash} href={latestUrl} className="text-[0.8125rem]" />
        </span>
      )}
    </Figure>
  );
}

async function Customers({ source }: { source: Promise<LandingNumbers> }) {
  return <CustomerFigures {...await source} />;
}

async function Decisions({ source }: { source: Promise<LandingNumbers> }) {
  return <DecisionFigures {...await source} />;
}

async function Payments({ source }: { source: Promise<LandingNumbers> }) {
  return <PaymentFigures {...await source} />;
}

/** When the figures were read, under the links: every one is read from production as the page loads. */
async function ReadAt({ source }: { source: Promise<LandingNumbers> }) {
  const { mainnet, testnet } = await source;
  const at = testnet?.generatedAt ?? mainnet?.generatedAt;
  if (!at) return null;
  return (
    <p className="mt-3 text-xs text-ink-3">
      Figures read from Vestiarion&apos;s production database as this page loaded, <time dateTime={at}>{utcMinute(at)}</time>.
    </p>
  );
}

/**
 * The team's latest decision, in a line under the decision figures: what it was, when and where, and its signature
 * checked in the reader's browser. Nothing when there is none to show.
 */
export function LatestLine({ latest }: { latest: LatestDecisionShown | null }) {
  if (!latest) return null;
  return (
    <div className="mt-auto grid gap-2 border-t border-line pt-3">
      <p className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3">
        Latest decision · <time dateTime={latest.at}>{latest.ago}</time> · {latest.network}
      </p>
      <p className="text-pretty text-sm font-medium leading-snug text-ink">{latest.headline}</p>
      <SignatureCheck link={latest.link} publicKeys={latest.publicKeys} />
    </div>
  );
}

async function Earlier({ source, latest }: { source: Promise<RecentDecisions | null>; latest: Promise<ProofFacts> }) {
  const [recent, facts] = await Promise.all([source, latest]);
  if (!recent) return null;
  return <RecentDecisionList recent={{ ...recent, decisions: facts.latest ? earlierThan(recent.decisions, facts.latest.seq) : recent.decisions.slice(0, 3) }} />;
}

async function Latest({ source }: { source: Promise<ProofFacts> }) {
  const { latest } = await source;
  return <LatestLine latest={latest} />;
}

/**
 * The team's latest decision with the ones before it, as a panel of its own, for a page that shows them in full. The
 * landing shows the latest one as a line (LatestLine).
 */
export function LatestPanel({ latest, recent = null }: { latest: LatestDecisionShown | null; recent?: RecentDecisions | null }) {
  if (!latest) return null;
  return (
    <div className="mt-10 rounded-2xl border border-line bg-surface p-5 shadow-surface sm:p-6">
      <LatestDecisionCard decision={latest} headingLevel={3} />
      {recent && (
        <RecentDecisionList
          recent={{
            decisions: earlierThan(recent.decisions, latest.seq),
            pastWeek: recent.pastWeek,
          }}
        />
      )}
    </div>
  );
}

function GroupFallback({ what }: { what: string }) {
  return (
    <EvidencePending className="mt-4">
      <p className="sr-only">{`Loading ${what}`}</p>
      {/* As tall as three figures, so nothing below moves when they stream in. */}
      <Skeleton className="h-[13.5rem] rounded-xl" />
    </EvidencePending>
  );
}

function LatestFallback() {
  return (
    <EvidencePending className="mt-4">
      <p className="sr-only">Loading the agent&apos;s latest decision</p>
      <Skeleton className="h-[7.5rem] rounded-xl" />
    </EvidencePending>
  );
}
