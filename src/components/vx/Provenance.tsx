import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";

export interface ProvenanceLeg {
  label: string;
  detail: string;
  live: boolean;
}

/**
 * What is live and what is simulated, one badge per leg, each saying so in
 * words. `compact` is for the status strip above every workspace page: smaller
 * badges, and each leg's detail only where there is room for it, so on a phone
 * the three legs share two lines instead of taking three.
 */
export function ProvenanceBar({ legs, compact = false }: { legs: ProvenanceLeg[]; compact?: boolean }) {
  return (
    <ul aria-label="Live and simulated product capabilities" className={cn("flex flex-wrap", compact ? "gap-1.5" : "gap-2")}>
      {legs.map((leg) => (
        <li key={leg.label}>
          <Badge
            tone={leg.live ? "proof" : "simulated"}
            size={compact ? "sm" : "md"}
            dot
            className={cn("gap-2 font-medium text-ink", compact ? "text-xs" : "text-[0.8125rem]")}
          >
            <span>
              {leg.label}{" "}
              <span className={cn("font-normal text-ink-2", compact && "hidden md:inline")}>· {leg.detail}</span>
            </span>
            <span className={cn("font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em]", leg.live ? "text-proof" : "text-ink-2")}>
              {leg.live ? "Live" : "Simulated"}
            </span>
          </Badge>
        </li>
      ))}
    </ul>
  );
}
