import {
  emptyCounterpartyHistory,
  type CounterpartyHistoryInputs,
} from "@/lib/agent/counterparty-history";

export function PerformanceHistory({
  score,
  inputs,
  compact = false,
}: {
  score: number | null;
  inputs: CounterpartyHistoryInputs | null;
  compact?: boolean;
}) {
  const facts = inputs ?? emptyCounterpartyHistory();
  const label = score == null ? "No history yet" : `${(score * 100).toFixed(1)}% clean`;

  return (
    <div className={compact ? "mt-2" : "mt-3"}>
      <p className="text-xs font-medium text-ink">Performance history · {label}</p>
      <details className="mt-1 text-xs text-ink-3">
        <summary className="cursor-pointer select-none hover:text-ink-2">Score inputs</summary>
        <p className="mt-1 max-w-md leading-relaxed">
          {facts.paidWithoutIntervention} clean payment(s) · {facts.informationRequested} information
          request(s) · {facts.heldOrFlagged} held/flagged · {facts.duplicateSubmissions} confirmed
          duplicate(s) · {facts.riskTierChanges} risk-tier change(s)
        </p>
      </details>
    </div>
  );
}
