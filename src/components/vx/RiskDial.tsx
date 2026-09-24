import type { RiskTier } from "./types";
import { Money } from "./Primitives";

const STEP: Record<RiskTier, number> = { unscreened: 0, clear: 1, medium: 2, high: 3 };
const TEXT: Record<RiskTier, string> = { unscreened: "text-ink-3", clear: "text-ink", medium: "text-held", high: "text-refused" };
const FILL: Record<RiskTier, string> = { unscreened: "", clear: "bg-ink-2", medium: "bg-held", high: "bg-refused" };

export function RiskDial({ risk, baseline, effective }: { risk: RiskTier; baseline: number | null; effective: number | null }) {
  const step = STEP[risk];
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="w-28 shrink-0">
        <div className="flex gap-0.5" aria-hidden>
          {[1, 2, 3].map((item) => (
            <span key={item} className={`h-1.5 flex-1 first:rounded-l-full last:rounded-r-full ${risk === "unscreened" ? "hatch border border-dashed border-line-strong" : item <= step ? FILL[risk] : "bg-raised"}`} />
          ))}
        </div>
        <span className={`mt-1 block text-xs font-medium capitalize ${TEXT[risk]}`}>{risk}</span>
      </div>
      <div className="text-sm text-ink-2">
        {baseline != null && effective != null ? (
          <span><Money value={baseline} className="text-ink-3" /> <span aria-hidden>→</span> <Money value={effective} className="text-ink" /></span>
        ) : effective != null ? <Money value={effective} className="text-ink" /> : <span>No payment limit</span>}
      </div>
    </div>
  );
}
