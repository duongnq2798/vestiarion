import { ArrowRight, ArrowUpRight, ChartColumn, FileCheck, GitBranch, ShieldCheck, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import { Skeleton } from "@/components/ui/Skeleton";
import { ProvenanceList, type ProvenanceLeg } from "@/components/vx/Provenance";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";
import type { LatestDecisionShown } from "@/lib/platform/latest-decision";
import { earlierThan, type RecentDecisions } from "@/lib/platform/recent-decisions";
import { GITHUB_URL } from "@/lib/site-links";
import { LatestDecisionCard } from "./LatestDecision";
import { NetworkPanels, type LandingNumbers } from "./LiveProof";
import { RecentDecisionList } from "./RecentDecisions";

/**
 * The landing's proof (docs/superpowers/specs/2026-10-11-landing-clarity-design.md P1-P3), in one section: the agent's
 * latest real decision with its signature checked in the reader's browser and the decisions before it
 * (docs/superpowers/specs/2026-10-11-landing-recent-decisions-design.md), the open numbers with customers apart from
 * the team and each network on its own, what runs live now, and where to check each of them without us.
 */

/**
 * The two checks that need no trust in us first: the signed ledger, then the agent's decisions against the rules. Each
 * has a small icon of its own, so the four tell apart at a glance.
 */
const CHECK_IT: ReadonlyArray<{ href: string; label: string; icon: LucideIcon; external: boolean }> = [
  { href: "/docs/guides/audit-export", label: "Verify a ledger export yourself", icon: FileCheck, external: false },
  { href: "/docs/research/model-vs-policy", label: "When the model and the written policy disagree", icon: ShieldCheck, external: false },
  { href: "/open", label: "Every figure on Open numbers", icon: ChartColumn, external: false },
  { href: GITHUB_URL, label: "The source code, MIT licensed", icon: GitBranch, external: true },
];

/** What the proof reads besides the open numbers: the team's latest decision, the ones before it, and which legs run live. */
export interface ProofFacts {
  latest: LatestDecisionShown | null;
  /** Null when they could not be read: the latest decision then stands alone. */
  recent: RecentDecisions | null;
  provenance: ProvenanceLeg[];
}

/**
 * The section's words and links are drawn at once; each part read from production streams in behind its own fallback
 * (landing stream S1), so no read holds back the page above it, the hero included.
 */
export function Proof({ numbers, facts }: { numbers: Promise<LandingNumbers>; facts: Promise<ProofFacts> }) {
  return (
    <section id="proof" aria-labelledby="proof-title" className="scroll-mt-16 border-b border-line bg-ground">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <Reveal>
          <div className="max-w-3xl">
            <Eyebrow className="text-agent">Proof</Eyebrow>
            <h2 id="proof-title" className="mt-3 text-balance text-3xl font-semibold leading-tight tracking-[-0.04em] text-ink sm:text-5xl">
              Don&apos;t take our word for it.
            </h2>
            <p className="mt-4 max-w-2xl text-pretty text-[0.9375rem] leading-relaxed text-ink-2 sm:text-lg">
              {`These figures are read from Vestiarion's production database as this page loads. Customers are counted apart from our own team, and ${ARC_MAINNET.label}, with real money, apart from ${ARC_TESTNET.label}, never added together.`}
            </p>
          </div>
        </Reveal>

        <Suspense fallback={<DecisionFallback />}>
          <Latest source={facts} />
        </Suspense>

        <div className="mt-5">
          <Suspense fallback={<NumbersFallback />}>
            <Figures source={numbers} />
          </Suspense>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-6 border-t border-line pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-12">
          <div className="min-w-0">
            <p className="mb-2.5 font-mono text-xs uppercase tracking-[0.14em] text-ink-3">
              Live capabilities ·{" "}
              <Link href="/open#mainnet" className="text-agent underline decoration-agent/40 underline-offset-4 hover:decoration-agent">
                Live on Arc mainnet
              </Link>
            </p>
            <Suspense fallback={<Skeleton className="h-[8.5rem] rounded-2xl" />}>
              <Live source={facts} />
            </Suspense>
          </div>
          <div className="min-w-0">
            <p className="mb-2.5 font-mono text-xs uppercase tracking-[0.14em] text-ink-3">Verify it yourself</p>
            <ul className="grid gap-1.5">
              {CHECK_IT.map((item) => (
                <li key={item.href}>
                  {item.external ? (
                    <a
                      href={item.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-6 items-center gap-1.5 text-[0.9375rem] font-medium text-agent underline-offset-4 hover:underline"
                    >
                      <item.icon aria-hidden className="size-4 text-ink-3" />
                      {item.label}
                      <ArrowUpRight aria-hidden className="size-4" />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    <Link href={item.href} className="inline-flex min-h-6 items-center gap-1.5 text-[0.9375rem] font-medium text-agent underline-offset-4 hover:underline">
                      <item.icon aria-hidden className="size-4 text-ink-3" />
                      {item.label}
                      <ArrowRight aria-hidden className="size-4" />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The team's latest decision, with the ones before it under it when they could be read; nothing when there is no latest
 * decision to show, since the earlier ones come from the same workspaces.
 */
export function LatestPanel({ latest, recent = null }: { latest: LatestDecisionShown | null; recent?: RecentDecisions | null }) {
  if (!latest) return null;
  return (
    <div className="mt-10 rounded-2xl border border-line bg-surface p-5 shadow-surface sm:p-6">
      <LatestDecisionCard decision={latest} headingLevel={3} />
      {recent && <RecentDecisionList recent={{ decisions: earlierThan(recent.decisions, latest.seq), pastWeek: recent.pastWeek }} />}
    </div>
  );
}

async function Latest({ source }: { source: Promise<ProofFacts> }) {
  const { latest, recent } = await source;
  return <LatestPanel latest={latest} recent={recent} />;
}

async function Live({ source }: { source: Promise<ProofFacts> }) {
  const { provenance } = await source;
  return <ProvenanceList legs={provenance} />;
}

async function Figures({ source }: { source: Promise<LandingNumbers> }) {
  const { mainnet, testnet } = await source;
  return <NetworkPanels mainnet={mainnet} testnet={testnet} />;
}

function DecisionFallback() {
  return (
    <div aria-busy="true" className="mt-10">
      <p className="sr-only">Loading the agent&apos;s latest decisions</p>
      {/* As tall as the latest decision with the three before it, as measured, so nothing below jumps when it streams in. */}
      <Skeleton className="h-[88rem] rounded-2xl sm:h-[61rem] lg:h-[45rem]" />
    </div>
  );
}

function NumbersFallback() {
  return (
    <div aria-busy="true">
      <p className="sr-only">Loading the open numbers</p>
      <Skeleton className="h-[46rem] rounded-2xl sm:h-[26rem] lg:h-[16rem]" />
    </div>
  );
}
