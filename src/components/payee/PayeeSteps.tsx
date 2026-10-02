import { Check } from "lucide-react";
import { cn } from "@/components/ui/cn";
import type { PayeeStage } from "@/lib/payee-journey";

/** The three steps of getting paid through a payee link, named the same on every screen (freelancer journey §2). */
export const PAYEE_STEPS = ["Your address", "Confirmation", "Payment"] as const;

const CURRENT: Record<PayeeStage, number> = { address: 0, confirming: 1, paying: 2, paid: 3 };

/** Where the payee is: "Step 2 of 3", and a bar for each step, done, current or still to come. */
export function PayeeSteps({ stage }: { stage: PayeeStage }) {
  const current = CURRENT[stage];
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">{stage === "paid" ? "All done" : `Step ${current + 1} of 3`}</p>
      <ol aria-label="Payment steps" className="mt-2 grid grid-cols-3 gap-2">
        {PAYEE_STEPS.map((label, index) => {
          const state = index < current ? "done" : index === current ? "current" : "next";
          return (
            <li key={label} aria-current={state === "current" ? "step" : undefined} className="grid gap-1.5">
              <span aria-hidden className={cn("h-1 rounded-full", state === "done" ? "bg-proof" : state === "current" ? "bg-agent" : "bg-line")} />
              <span className={cn("flex items-center gap-1 text-xs", state === "next" ? "text-ink-3" : "font-medium text-ink")}>
                {state === "done" && <Check aria-hidden className="size-3 text-proof" />}
                {label}
                {state === "done" && <span className="sr-only"> (done)</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
