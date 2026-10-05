import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { orgHref } from "@/lib/auth/org-paths";
import { laterBy, type TrailStep } from "@/lib/decision-trail";
import { txUrl } from "@/lib/payee-chains";
import type { Network } from "@/lib/network";
import { Hash } from "./Primitives";

const DOT: Record<TrailStep["who"], string> = {
  agent: "bg-agent",
  person: "bg-ink-2",
  system: "bg-ink-3",
};

const WHO: Record<TrailStep["who"], string> = { agent: "Agent", person: "Person", system: "System" };

/** The id a link opens the trail at: the toast's "How it decided" (`ScrollToHash` opens it and the row around it). */
export function trailAnchor(decisionId: string): string {
  return `trail-${decisionId}`;
}

/**
 * How the agent decided, step by step (decision trail spec R1–R3): each signed entry about the payable, oldest first,
 * with its time to the second and how long after the step before it, what was checked, the transaction it sent and
 * the audit log entry it is. Folded until opened; a link to `#trail-<id>` opens it.
 */
export function DecisionTrail({
  id,
  steps,
  orgSlug,
  network,
  defaultOpen = false,
}: {
  id: string;
  steps: TrailStep[];
  orgSlug: string;
  /** The workspace's network: each step's transaction is linked on its explorer. */
  network: Network;
  /** Open from the start: for a guide's screenshot. */
  defaultOpen?: boolean;
}) {
  if (steps.length === 0) return null;
  return (
    <details id={trailAnchor(id)} open={defaultOpen} className="group/trail scroll-mt-24 border-t border-line first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-sm font-medium text-ink-2 transition-colors duration-150 ease-standard hover:text-ink sm:px-5 [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2">
          <ChevronRight aria-hidden className="size-4 text-ink-3 transition-transform duration-200 ease-standard group-open/trail:rotate-90" />
          How the agent decided
        </span>
        <span className="text-xs font-normal text-ink-3">
          {steps.length} {steps.length === 1 ? "step" : "steps"} · signed
        </span>
      </summary>
      <ol className="space-y-3 px-4 pb-4 pt-1 sm:px-5">
        {steps.map((step, index) => {
          const later = laterBy(index > 0 ? steps[index - 1].at : null, step.at);
          return (
            <li key={step.seq} className="relative pl-5">
              <span aria-hidden className={cn("absolute left-0 top-1.5 size-2 rounded-full", DOT[step.who])} />
              {index < steps.length - 1 && <span aria-hidden className="absolute left-[3px] top-4 h-[calc(100%+0.25rem)] w-px bg-line" />}
              <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-xs text-ink-3">
                <time dateTime={step.at}>{step.at.slice(11, 19)} UTC</time>
                {later && <span>· {later}</span>}
                <span className="sr-only">{WHO[step.who]}</span>
                <Link href={orgHref(orgSlug, `/audit#seq-${step.seq}`)} className="hover:text-ink hover:underline">
                  #{String(step.seq).padStart(4, "0")}
                </Link>
              </p>
              <p className={cn("mt-0.5 text-sm", step.tone === "stopped" ? "text-held" : "text-ink")}>{step.text}</p>
              {step.notes.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-ink-2">
                  {step.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
              {step.txHash && (
                <p className="mt-1 text-xs text-ink-3">
                  Transaction <Hash value={step.txHash} href={txUrl(network, step.txHash)} />
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
