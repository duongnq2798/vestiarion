import Link from "next/link";
import { landingPrefetch } from "@/components/landing/prefetch";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { groupCounts, QUALITY_LAB_RESULTS } from "@/lib/quality-lab/results";
import { QUALITY_LAB_SHADOW_RESULTS } from "@/lib/quality-lab/shadow-results";
import { scoreWords, shadowReplayWords, wrongPaymentWords } from "@/lib/quality-lab/words";

/** The docs page with every scenario and its result. */
export const QUALITY_LAB_HREF = "/docs/research/quality-lab";

/**
 * The Quality Lab's result (docs/superpowers/specs/2026-10-26-quality-lab-design.md QL7), on /open and /how-it-decides:
 * the committed results' score and wrong payments with their real numbers, each group's count, how the scenarios run,
 * what right and a wrong payment mean, and the docs page. A server component over the file the lab's test holds equal
 * to its run, so nothing here is typed by hand. It names no network: the lab runs over a fake provider, on no chain.
 * Under the score, one line on the team's own shadow-mode decisions replayed through today's code, from the replay's
 * committed file (docs/superpowers/specs/2026-10-26-quality-lab-shadow-replay-design.md SR10).
 */
export function QualityLabResult({ id, heading: Heading = "h2", className }: { id: string; heading?: "h2" | "h3"; className?: string }) {
  const { summary } = QUALITY_LAB_RESULTS;
  return (
    <div className={cn("rounded-2xl border border-line bg-surface p-5 sm:p-6", className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          {/* The caption is inside the heading, so the heading and a section it labels name what is scored (QL7). */}
          <Heading id={id} className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            <Eyebrow className="block text-xs">Quality Lab</Eyebrow>
            <span className="mt-2 block">{scoreWords(summary)}</span>
          </Heading>
          <p className="mt-3 text-[0.9375rem] leading-7 text-ink-2">
            Each scenario runs through the real decision code on every change, with the model&apos;s answers scripted, often to what an attacker
            would want.
          </p>
          <p className="mt-2 text-[0.9375rem] leading-7 text-ink-2">{shadowReplayWords(QUALITY_LAB_SHADOW_RESULTS.summary)}</p>
        </div>
        <Badge tone={summary.wrongPayments === 0 ? "proof" : "refused"} dot className="font-mono">
          {wrongPaymentWords(summary.wrongPayments)}
        </Badge>
      </div>

      <ul className="mt-5 grid gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-3">
        {groupCounts().map(({ group, right, total }) => (
          <li key={group.id} className="flex items-baseline justify-between gap-3 bg-surface px-4 py-2.5 text-sm">
            <span className="min-w-0 text-ink-2">{group.title}</span>
            <span className="shrink-0 font-mono font-semibold text-ink">{`${right} of ${total}`}</span>
          </li>
        ))}
      </ul>

      <div className="mt-5 space-y-2 text-sm leading-6 text-ink-2">
        <p>A scenario is right when money moved or stopped as expected, with the expected status and rule.</p>
        <p>
          A wrong payment is any transfer or schedule where money should stop, a transfer to an address other than the one on file or for an
          amount other than the bill&apos;s, or a second transfer for one bill.
        </p>
      </div>
      <Link
        href={QUALITY_LAB_HREF}
        prefetch={landingPrefetch(QUALITY_LAB_HREF)}
        className="mt-4 inline-block text-[0.9375rem] font-semibold text-agent underline-offset-4 hover:underline"
      >
        Every scenario and its result →
      </Link>
    </div>
  );
}
