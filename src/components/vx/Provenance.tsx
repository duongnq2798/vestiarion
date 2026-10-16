import { ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";

export interface ProvenanceLeg {
  label: string;
  detail: string;
  live: boolean;
  /** Nothing can happen on this leg now, neither live nor simulated: a workspace held by its network (mainnet copy C12). */
  held?: boolean;
  /** Where the leg is shown live: a page of the site, or a transaction on an explorer, which opens in a new tab. */
  href?: string;
  /** What the link opens, for a screen reader, after the leg's own words. */
  hrefLabel?: string;
}

/**
 * What is live and what is simulated, one badge per leg, each saying so in
 * words. `compact` is for the status strip above every workspace page: smaller
 * badges, and each leg's detail only where there is room for it, so on a phone
 * the three legs share two lines instead of taking three. A leg with an `href`
 * is a link to what shows it live.
 */
export function ProvenanceBar({ legs, compact = false }: { legs: ProvenanceLeg[]; compact?: boolean }) {
  return (
    <ul aria-label="Live and simulated product capabilities" className={cn("flex flex-wrap", compact ? "gap-1.5" : "gap-2")}>
      {legs.map((leg) => (
        <li key={leg.label}>{leg.href ? <LinkedLeg leg={leg} href={leg.href} compact={compact} /> : <LegBadge leg={leg} compact={compact} />}</li>
      ))}
    </ul>
  );
}

function LinkedLeg({ leg, href, compact }: { leg: ProvenanceLeg; href: string; compact: boolean }) {
  const external = /^https?:\/\//.test(href);
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="group inline-flex rounded-full transition-transform duration-150 ease-standard motion-safe:hover:-translate-y-px"
    >
      <LegBadge leg={leg} compact={compact} linked />
      {leg.hrefLabel && <span className="sr-only">{`, ${leg.hrefLabel}${external ? " (opens in a new tab)" : ""}`}</span>}
    </a>
  );
}

function LegBadge({ leg, compact, linked = false }: { leg: ProvenanceLeg; compact: boolean; linked?: boolean }) {
  return (
    <Badge
      tone={leg.held ? "held" : leg.live ? "proof" : "simulated"}
      size={compact ? "sm" : "md"}
      dot
      className={cn("gap-2 font-medium text-ink", compact ? "text-xs" : "text-[0.8125rem]", linked && "transition-colors duration-150 ease-standard group-hover:border-proof")}
    >
      <span>
        {leg.label}{" "}
        <span className={cn("font-normal text-ink-2", compact && "hidden md:inline")}>· {leg.detail}</span>
      </span>
      <span className={cn("font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em]", leg.held ? "text-held" : leg.live ? "text-proof" : "text-ink-2")}>
        {leg.held ? "Held" : leg.live ? "Live" : "Simulated"}
      </span>
      {linked && <ArrowUpRight aria-hidden className="-ml-1 text-proof" />}
    </Badge>
  );
}

/**
 * The same legs as a list, one row each (landing proof cards, docs/superpowers/specs/2026-10-17-landing-proof-cards-
 * design.md): the leg, where it runs, then whether it is live, at the same place on every row. For a section with room
 * to read them, where badges of three widths wrapped unevenly. A row with an `href` is a link to what shows it live.
 */
export function ProvenanceList({ legs }: { legs: ProvenanceLeg[] }) {
  return (
    <ul aria-label="Live and simulated product capabilities" className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
      {legs.map((leg) => {
        const external = leg.href !== undefined && /^https?:\/\//.test(leg.href);
        return (
          <li key={leg.label}>
            {leg.href ? (
              <a
                href={leg.href}
                {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="flex min-h-11 items-center gap-3 px-4 py-2.5 transition-colors duration-150 ease-standard hover:bg-ground/60"
              >
                <LegRow leg={leg} linked />
                {leg.hrefLabel && <span className="sr-only">{`, ${leg.hrefLabel}${external ? " (opens in a new tab)" : ""}`}</span>}
              </a>
            ) : (
              <div className="flex min-h-11 items-center gap-3 px-4 py-2.5">
                <LegRow leg={leg} linked={false} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function LegRow({ leg, linked }: { leg: ProvenanceLeg; linked: boolean }) {
  const tone = leg.held ? "held" : leg.live ? "proof" : "simulated";
  return (
    <>
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", tone === "held" ? "bg-held" : tone === "proof" ? "bg-proof" : "border border-dashed border-ink-3")}
      />
      <span className="min-w-0 flex-1 text-[0.9375rem]">
        <span className="font-medium text-ink">{leg.label}</span> <span className="text-ink-2">· {leg.detail}</span>
      </span>
      <span className={cn("font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em]", tone === "held" ? "text-held" : tone === "proof" ? "text-proof" : "text-ink-2")}>
        {leg.held ? "Held" : leg.live ? "Live" : "Simulated"}
      </span>
      {/* The arrow's place is kept on every row, so each row's status lines up with the next. */}
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
        {linked && <ArrowUpRight className="size-4 text-proof" />}
      </span>
    </>
  );
}
