import { Disclosure } from "@/components/ui/Disclosure";
import { decisionKindLabel } from "@/lib/autonomy-ladder";
import { utcDay } from "@/lib/copy";
import { earnedStatusWords, type EarnedVendorsView } from "@/lib/earned-vendors";

/**
 * Earned vendors under the owner's rule, in the report after How often you agreed
 * (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL18): the rule in words, then each vendor the ladder
 * lists by vendor with its status. A vendor reads as earned only once it is also signed, and then lists the verdicts
 * behind it. Earning changes nothing the agent may do (AL20), and the block says so.
 */

const usdc = (amount: number) => amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export function EarnedVendors({ view }: { view: EarnedVendorsView }) {
  // The ladder's By vendor rows: the vendors with a verdict, in its order (autonomy ladder AL5).
  const rows = view.statuses.filter((status) => status.given > 0);
  return (
    <section aria-labelledby="report-earned" className="space-y-3">
      <div>
        <h3 id="report-earned" className="text-sm font-semibold text-ink">
          Earned vendors
        </h3>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-3">
          {view.streak === null
            ? "No rule is set. An owner sets one in Settings, under Earned vendors."
            : `Under your rule: ${view.streak} agreed verdicts in a row on a vendor's payments. A disagreement, a bill flagged for review, or a check in code stopping one of its bills starts the count again. Earning changes nothing the agent may do.`}
        </p>
      </div>
      {view.streak !== null && rows.length > 0 && (
        <ul aria-label="Earned vendors" className="divide-y divide-line rounded-xl border border-line text-sm">
          {rows.map((status) => {
            const recorded = view.recorded.has(status.vendorId);
            return (
              <li key={status.vendorId} className="space-y-1.5 px-3 py-2.5">
                <p className="min-w-0 break-words">
                  <span className="font-medium text-ink">{status.name}</span> <span className="text-ink-2">{earnedStatusWords(status, recorded)}</span>
                </p>
                {status.state === "earned" && recorded && (
                  <Disclosure variant="bare" summary={<span className="text-xs font-medium text-agent">The verdicts behind it</span>}>
                    <ol className="mt-1 space-y-0.5 text-xs tabular-nums text-ink-2">
                      {status.counted.map((decision) => (
                        <li key={decision.seq}>
                          {[utcDay(decision.at), decisionKindLabel(decision.action), decision.amount === null ? null : `${usdc(decision.amount)} ${decision.currency ?? "USDC"}`, "Agreed"]
                            .filter(Boolean)
                            .join(" · ")}
                        </li>
                      ))}
                    </ol>
                  </Disclosure>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {view.streak !== null && <p className="text-xs text-ink-3">Each change is signed in the ledger as vendor_earned or vendor_earned_lost.</p>}
    </section>
  );
}
