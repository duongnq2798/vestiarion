import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { formatFigure, formatRatio } from "@/components/open/OpenNumbersTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
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
import { FEATURED_PAYMENT, featuredContractUrl, featuredTxUrl } from "./featured-proof";
import { LatestDecisionCard } from "./LatestDecision";
import type { LandingNumbers } from "./LiveProof";
import { latestOwnPaymentUrl } from "./provenance";
import { RecentDecisionList } from "./RecentDecisions";
import { SignatureCheck } from "./SignatureCheck";

/**
 * The landing's proof (docs/superpowers/specs/2026-10-11-landing-clarity-design.md P1-P3), told as one story: a real
 * payment on Arc mainnet from the agent's decision through the rule that held it and the person who approved it to the
 * transaction anyone can check, then the open numbers in three groups (customers, the agent's decisions, payments
 * settled), customers apart from the team and each network on its own, and where to check every figure without us.
 */

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
 * The section's words, the featured payment and the links are drawn at once; each part read from production streams in
 * behind its own fallback (landing stream S1), so no read holds back the page above it, the hero included.
 */
export function Proof({ numbers, facts }: { numbers: Promise<LandingNumbers>; facts: Promise<ProofFacts> }) {
  return (
    <section id="proof" aria-labelledby="proof-title" className="scroll-mt-16 border-b border-line bg-ground">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        <Reveal>
          <div className="max-w-3xl">
            <Eyebrow className="text-agent">Proof, not promises</Eyebrow>
            <h2 id="proof-title" className="mt-3 text-balance text-3xl font-semibold leading-tight tracking-[-0.04em] text-ink sm:text-5xl">
              Don&apos;t take our word for it.
            </h2>
            <p className="mt-4 max-w-2xl text-pretty text-[0.9375rem] leading-relaxed text-ink-2 sm:text-lg">
              Real agent decisions. Onchain payment receipts. Publicly verifiable records.
            </p>
          </div>
        </Reveal>

        <FeaturedPayment />

        <div className="mt-5 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
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
      </div>
    </section>
  );
}

/** "09:43 UTC", from an instant. */
const utcTime = (iso: string) => `${iso.slice(11, 16)} UTC`;

/**
 * One payment on Arc mainnet, told step by step beside the transaction that settled it (featured-proof.ts): what the
 * agent decided, the rule in code that held it, the person who approved it, and the contract it was paid through.
 */
function FeaturedPayment() {
  const p = FEATURED_PAYMENT;
  return (
    <article aria-labelledby="featured-payment-title" className="mt-8 overflow-hidden rounded-2xl border border-line bg-surface">
      {/* Real money's evidence carries the proof colour's thin rule, as Arc mainnet's figures do. */}
      <span aria-hidden className="block h-0.5 bg-proof" />
      <div className="grid md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Badge tone="proof" size="sm" className="font-mono uppercase tracking-[0.08em]">
              {`${p.network.label} · Real USDC`}
            </Badge>
            <time dateTime={p.confirmedAt} className="font-mono text-xs text-ink-3">
              Oct 7, 2026
            </time>
          </div>
          <h3 id="featured-payment-title" className="mt-3 text-balance text-xl font-semibold tracking-[-0.02em] text-ink sm:text-2xl">
            A real payment, with a verifiable trail.
          </h3>
          <p className="mt-1.5 max-w-xl text-pretty text-sm leading-relaxed text-ink-2">
            {`A workspace our team runs, paying its first bill on ${p.network.label}: ${p.amount} USDC to a supplier it had never paid.`}
          </p>
          <ol className="mt-5 grid">
            {p.steps.map((step, index) => (
              <li key={step.kind} className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0">
                {/* The rail that joins one step to the next; the last step has nothing after it. */}
                {index < p.steps.length - 1 && <span aria-hidden className="absolute bottom-0 left-[0.8125rem] top-7 w-px bg-line" />}
                <span
                  aria-hidden
                  className="mt-0.5 grid size-7 place-items-center rounded-full border border-line-strong bg-surface font-mono text-xs font-semibold text-ink-2"
                >
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3">
                    <span>{step.kind}</span>
                    <span aria-hidden>·</span>
                    <time dateTime={step.at} className="normal-case tracking-normal">
                      {utcTime(step.at)}
                    </time>
                  </p>
                  <p className="mt-1 text-[0.9375rem] font-semibold leading-snug text-ink">{step.title}</p>
                  {"detail" in step && (
                    <p className="mt-0.5 max-w-xl text-pretty text-sm leading-relaxed text-ink-2">
                      {step.detail}
                      {"rule" in step && (
                        <>
                          {" "}
                          <code className="whitespace-nowrap rounded-md border border-refused-line bg-refused-soft px-1.5 py-0.5 font-mono text-xs text-refused">
                            {step.rule}
                          </code>
                        </>
                      )}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div className="flex min-w-0 flex-col border-t border-line bg-ground/50 p-5 sm:p-6 md:border-l md:border-t-0">
          <p className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3">On the {p.network.label} explorer</p>
          <dl className="mt-3 grid gap-2.5 text-sm">
            <Fact label="Amount">
              <span className="font-semibold text-ink tabular-nums">{p.amount} USDC</span>
            </Fact>
            <Fact label="Status">
              <Badge tone="proof" size="sm" dot>
                Confirmed
              </Badge>
            </Fact>
            <Fact label="Paid through">
              <a
                href={featuredContractUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-agent underline-offset-4 hover:underline"
              >
                VestiarionSpendingLimit
                <ArrowUpRight aria-hidden className="size-3.5" />
                <span className="sr-only">{`, the contract on the ${p.network.label} explorer (opens in a new tab)`}</span>
              </a>
            </Fact>
            <Fact label="Confirmed">
              <time dateTime={p.confirmedAt} className="font-mono text-xs text-ink-2">
                {utcMinute(p.confirmedAt)}
              </time>
            </Fact>
            <Fact label="Network fee">
              <span className="font-mono text-xs text-ink-2 tabular-nums">{p.feeUsdc} USDC</span>
            </Fact>
            <Fact label="Transaction">
              <Hash value={p.txHash} href={featuredTxUrl} className="text-sm" />
            </Fact>
          </dl>
          <div className="mt-5 flex flex-col gap-1 md:mt-auto md:pt-5">
            <Button asChild size="lg" className="w-full justify-center">
              <a href={featuredTxUrl} target="_blank" rel="noopener noreferrer" data-cta="proof-featured-explorer">
                Verify on Arc Explorer
                <ArrowUpRight aria-hidden />
                <span className="sr-only">{`: the ${p.amount} USDC payment on ${p.network.label} (opens in a new tab)`}</span>
              </a>
            </Button>
            <a
              href={`${GITHUB_URL}#mainnet-proof`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center justify-center gap-1 text-sm font-medium text-agent underline-offset-4 hover:underline"
            >
              Read the whole trail
              <ArrowUpRight aria-hidden className="size-3.5" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}

/** A fact about the featured transaction: its name on the left, its value on the right. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 border-b border-line/70 pb-2.5 last:border-b-0 last:pb-0">
      <dt className="shrink-0 text-ink-3">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

/** One of the three groups of figures: a heading and what it counts, then its figures. */
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
 * customers agreed with it in shadow mode, where nothing is paid until a person agrees.
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
    <div aria-busy="true" className="mt-4">
      <p className="sr-only">{`Loading ${what}`}</p>
      {/* As tall as three figures, so nothing below moves when they stream in. */}
      <Skeleton className="h-[13.5rem] rounded-xl" />
    </div>
  );
}

function LatestFallback() {
  return (
    <div aria-busy="true" className="mt-4">
      <p className="sr-only">Loading the agent&apos;s latest decision</p>
      <Skeleton className="h-[7.5rem] rounded-xl" />
    </div>
  );
}
