import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import { Skeleton } from "@/components/ui/Skeleton";
import { ProvenanceBar, type ProvenanceLeg } from "@/components/vx/Provenance";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";
import type { LatestDecisionShown } from "@/lib/platform/latest-decision";
import { GITHUB_URL } from "@/lib/site-links";
import { LatestDecisionCard } from "./LatestDecision";
import { NetworkPanels, type LandingNumbers } from "./LiveProof";

/**
 * The landing's proof (docs/superpowers/specs/2026-10-11-landing-clarity-design.md P1-P3), in one section: the agent's
 * latest real decision with its signature checked in the reader's browser, the open numbers with customers apart from
 * the team and each network on its own, what runs live now, and where to check each of them without us.
 */

const CHECK_IT = [
  { href: "/open", label: "Every figure on Open numbers", external: false },
  { href: "/docs/guides/audit-export", label: "Verify a ledger export yourself", external: false },
  { href: "/docs/research/model-vs-policy", label: "Where the model and the rules disagreed", external: false },
  { href: GITHUB_URL, label: "The source code, MIT licensed", external: true },
] as const;

/** What the proof reads besides the open numbers: the team's latest decision, and which legs run live. */
export interface ProofFacts {
  latest: LatestDecisionShown | null;
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
              What runs live right now ·{" "}
              <Link href="/open#mainnet" className="text-agent underline decoration-agent/40 underline-offset-4 hover:decoration-agent">
                Live on Arc mainnet
              </Link>
            </p>
            <Suspense fallback={<Skeleton className="h-20 rounded-2xl sm:h-[4.75rem]" />}>
              <Live source={facts} />
            </Suspense>
          </div>
          <div className="min-w-0">
            <p className="mb-2.5 font-mono text-xs uppercase tracking-[0.14em] text-ink-3">Check it without us</p>
            <ul className="grid gap-1.5">
              {CHECK_IT.map((item) => (
                <li key={item.href}>
                  {item.external ? (
                    <a
                      href={item.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-6 items-center gap-1 text-[0.9375rem] font-medium text-agent underline-offset-4 hover:underline"
                    >
                      {item.label}
                      <ArrowUpRight aria-hidden className="size-4" />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    <Link href={item.href} className="inline-flex min-h-6 items-center gap-1 text-[0.9375rem] font-medium text-agent underline-offset-4 hover:underline">
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

/** The team's latest decision, or nothing when there is none to show. */
export function LatestPanel({ latest }: { latest: LatestDecisionShown | null }) {
  if (!latest) return null;
  return (
    <div className="mt-10 rounded-2xl border border-line bg-surface p-5 shadow-surface sm:p-6">
      <LatestDecisionCard decision={latest} headingLevel={3} />
    </div>
  );
}

async function Latest({ source }: { source: Promise<ProofFacts> }) {
  const { latest } = await source;
  return <LatestPanel latest={latest} />;
}

async function Live({ source }: { source: Promise<ProofFacts> }) {
  const { provenance } = await source;
  return <ProvenanceBar legs={provenance} />;
}

async function Figures({ source }: { source: Promise<LandingNumbers> }) {
  const { mainnet, testnet } = await source;
  return <NetworkPanels mainnet={mainnet} testnet={testnet} />;
}

function DecisionFallback() {
  return (
    <div aria-busy="true" className="mt-10">
      <p className="sr-only">Loading the agent&apos;s latest decision</p>
      <Skeleton className="h-[30rem] rounded-2xl sm:h-[17rem] lg:h-[12.5rem]" />
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
