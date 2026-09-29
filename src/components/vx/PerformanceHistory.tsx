import { Disclosure } from "@/components/ui/Disclosure";
import { emptyCounterpartyHistory, type CounterpartyHistoryInputs } from "@/lib/agent/counterparty-history";

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
      <Disclosure
        variant="bare"
        summary="Score inputs"
        className="mt-1 text-xs text-ink-3"
        summaryClassName="w-fit transition-colors duration-150 ease-standard hover:text-ink-2"
      >
        <p className="mt-1 max-w-md leading-relaxed">
          {facts.paidWithoutIntervention} clean payment(s) · {facts.informationRequested} information
          request(s) · {facts.heldOrFlagged} held/flagged · {facts.duplicateSubmissions} confirmed
          duplicate(s) · {facts.riskTierChanges} risk-tier change(s)
        </p>
        {/* Shown separately and outside the score, because a reviewer needs to
            see the holds that were deliberately not counted. Otherwise a
            counterparty with three held invoices and an unchanged score looks
            like a bug rather than a decision. */}
        {facts.heldByOurPolicy > 0 && (
          <p className="mt-1 max-w-md leading-relaxed">
            Not scored: {facts.heldByOurPolicy} hold(s) caused by our own payment limit or risk tier,
            which say nothing about how this counterparty behaves.
          </p>
        )}
        <p className="mt-1 max-w-md leading-relaxed">
          Pulled toward 50% until there is enough history to leave it, so a single outcome cannot
          read as a verdict. Evidence for closer review, never a payment guardrail.
        </p>
      </Disclosure>
    </div>
  );
}
