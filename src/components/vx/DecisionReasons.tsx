import { Card } from "@/components/ui/Card";
import { utcMinute } from "@/lib/copy";
import type { DecisionReasonsRead } from "@/lib/decision-reasons";

/**
 * The reasons people in this workspace gave as they went against the agent, newest first (docs/superpowers/specs/
 * 2026-10-14-capability-and-reasons-design.md R13): what they did and where, the reason in their words, and the build
 * of the app that asked. For owners and admins, on Insights. Before migration 0120 runs here, it says it is not set up.
 */
export function DecisionReasons({ read }: { read: DecisionReasonsRead }) {
  return (
    <Card asChild className="min-w-0 overflow-hidden p-5 sm:p-6">
      <section aria-labelledby="decision-reasons-title">
        <h2 id="decision-reasons-title" className="text-lg font-semibold tracking-tight text-ink">
          Why people went against the agent
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-2">
          The reasons given, when anyone gave one, as they disagreed with a decision in shadow mode, rejected or returned a bill, or paid a bill the agent
          held. Giving one is always optional.
        </p>
        <div className="mt-5">
          {!read.available ? (
            <p className="text-sm text-ink-3">Reasons are not set up in this workspace yet.</p>
          ) : read.reasons.length === 0 ? (
            <p className="text-sm text-ink-3">No reasons yet. The next one anyone gives shows here.</p>
          ) : (
            <ul className="divide-y divide-line">
              {read.reasons.map((reason, index) => (
                <li key={`${reason.givenAt}-${index}`} className="py-3 first:pt-0 last:pb-0">
                  <p className="text-sm text-ink [overflow-wrap:anywhere]">{`“${reason.reason}”`}</p>
                  <p className="mt-1 text-xs text-ink-3">{[reason.what, reason.surface, utcMinute(reason.givenAt), `build ${reason.appVersion}`].join(" · ")}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </Card>
  );
}
