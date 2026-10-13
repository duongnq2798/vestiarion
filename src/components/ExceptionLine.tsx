import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { decideByWords, ownersWords, PRIORITY_LABELS, type ExceptionFacts, type ExceptionPriority } from "@/lib/exceptions";

const TONE: Record<ExceptionPriority, NonNullable<BadgeProps["tone"]>> = { overdue: "refused", today: "held", week: "agent", later: "neutral" };

/**
 * A held payable as an exception someone owns (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md E1-E3): its
 * priority, the day it must be decided by, and who can act. On the Approvals card in full; on its row on Bills, with one
 * name and how many more.
 */
export function ExceptionLine({ facts, viewerEmail, compact = false, className }: { facts: ExceptionFacts; viewerEmail?: string | null; compact?: boolean; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs", className)}>
      <Badge size="sm" tone={TONE[facts.priority]} shape="tag">
        {PRIORITY_LABELS[facts.priority]}
      </Badge>
      <span className={facts.priority === "overdue" ? "font-medium text-refused" : "text-ink-2"}>{decideByWords(facts.decideBy)}</span>
      <span className="text-ink-3">{ownersWords(facts.owners, viewerEmail, compact ? 1 : 2)}</span>
    </div>
  );
}
