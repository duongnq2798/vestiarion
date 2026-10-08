import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Eyebrow } from "@/components/ui/Eyebrow";
import type { LatestDecisionShown } from "@/lib/platform/latest-decision";
import { SignatureCheck } from "./SignatureCheck";

/**
 * The newest decision the agent made in one of the team's own workspaces, right under the hero
 * (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md L2): what happened and who decided, in words that
 * name no one, its transaction, and its signature checked in the reader's browser. Nothing to show, nothing rendered.
 */
export function LatestDecision({ decision }: { decision: LatestDecisionShown | null }) {
  if (!decision) return null;
  return (
    <section aria-labelledby="latest-decision-title" className="border-b border-line bg-surface">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 sm:px-6 sm:py-10 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start lg:gap-12">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-proof motion-safe:animate-pulse" />
            <h2 id="latest-decision-title" className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-proof">
              The agent&apos;s latest decision
            </h2>
            <Eyebrow>
              <span aria-hidden>· </span>
              <time dateTime={decision.at}>{decision.ago}</time> · {decision.network}
            </Eyebrow>
          </div>
          <p className="mt-3 text-pretty font-serif text-2xl leading-snug text-ink sm:text-3xl">{decision.headline}</p>
          {decision.why && <p className="mt-2 max-w-2xl text-[0.9375rem] leading-relaxed text-ink-2">{decision.why}</p>}
          {decision.facts.length > 0 && (
            <ul className="mt-5 flex flex-wrap gap-2">
              {decision.facts.map((fact) => (
                <li key={fact.label}>
                  <Badge tone={fact.tone} size="sm">
                    <span className="font-normal">{fact.label}:</span>
                    <span className="font-semibold">{fact.value}</span>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs text-ink-3">From one of the Vestiarion team&apos;s own workspaces. Its words, names and reasoning stay in the workspace.</p>
        </div>
        <div className="grid gap-4 rounded-2xl border border-line bg-ground/60 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <span className="font-mono text-xs text-ink-3">Ledger entry #{decision.seq}</span>
            {decision.txUrl && (
              <a
                href={decision.txUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-xs font-medium text-agent underline-offset-2 hover:underline"
              >
                View transaction
                <ArrowUpRight aria-hidden className="size-3.5" />
              </a>
            )}
          </div>
          <SignatureCheck link={decision.link} publicKeys={decision.publicKeys} />
          <Link href="/open" className="text-xs font-medium text-agent underline-offset-2 hover:underline">
            See every figure on Open numbers
          </Link>
        </div>
      </div>
    </section>
  );
}
