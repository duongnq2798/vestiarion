import { Card } from "@/components/ui/Card";
import type { NextStep, NextSteps as Steps } from "@/lib/counterparties/page-view";

/**
 * Needs you and Waiting on them, under a counterparty's tiles: what is waiting and on whom, each line a link to the part
 * of the page that holds it (`nextSteps` in page-view.ts). Nothing here acts: the controls stay in their parts.
 */
export function NextSteps({ steps }: { steps: Steps }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <StepList title="Needs you" steps={steps.needsYou} empty="Nothing waits on your side." unread={steps.unread} />
      <StepList title="Waiting on them" steps={steps.waitingOnThem} empty="Nothing waits on them." unread={steps.unread} />
    </div>
  );
}

function StepList({ title, steps, empty, unread }: { title: string; steps: readonly NextStep[]; empty: string; unread: boolean }) {
  const id = `${title.toLowerCase().replace(/\s+/g, "-")}-title`;
  return (
    <Card className="p-4" role="group" aria-labelledby={id}>
      <h2 id={id} className="text-sm font-semibold text-ink">
        {title}
      </h2>
      {steps.length === 0 ? (
        <p className="mt-2 text-sm text-ink-3">{unread ? "Some parts were not read just now. Reload the page in a moment." : empty}</p>
      ) : (
        <ul className="mt-2 space-y-1.5 text-sm">
          {steps.map((step) => (
            <li key={`${step.section}-${step.words}`}>
              <a href={`#${step.section}`} className="font-medium text-agent underline-offset-4 hover:underline">
                {step.words}
              </a>
            </li>
          ))}
        </ul>
      )}
      {steps.length > 0 && unread && <p className="mt-2 text-xs text-ink-3">Some parts were not read just now, so this may not be all of it.</p>}
    </Card>
  );
}
