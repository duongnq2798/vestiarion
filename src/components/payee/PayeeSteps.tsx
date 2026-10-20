import { Check } from "lucide-react";
import { cn } from "@/components/ui/cn";
import type { PayeeStage } from "@/lib/payee-journey";

/** The three steps of getting paid through a payee link, named the same on every screen (freelancer journey §2). */
export const PAYEE_STEPS = ["Your address", "Confirmation", "Payment"] as const;

/** The step a link that asks for the payee's invoice adds after the address (payee invoice link P4). */
export const INVOICE_STEP = "Your invoice";

const CURRENT: Record<PayeeStage, number> = { address: 0, invoice: 1, confirming: 1, paying: 2, paid: 3 };

/**
 * Where the payee is: "Step 2 of 3", and a bar for each step, done, current or still to come. A link that asks for the
 * payee's invoice has four steps, its invoice second; `invoicePending`, when a payment moved on before the invoice was
 * sent, leaves that step undone.
 */
export function PayeeSteps({ stage, withInvoice = false, invoicePending = false }: { stage: PayeeStage; withInvoice?: boolean; invoicePending?: boolean }) {
  const steps: readonly string[] = withInvoice ? [PAYEE_STEPS[0], INVOICE_STEP, PAYEE_STEPS[1], PAYEE_STEPS[2]] : PAYEE_STEPS;
  const current = withInvoice && stage !== "address" && stage !== "invoice" ? CURRENT[stage] + 1 : CURRENT[stage];
  return (
    <div className="border-b border-line pb-5">
      <p className="font-mono text-xs font-semibold uppercase tracking-[0.08em] text-ink-2">{stage === "paid" ? "All done" : `Step ${current + 1} of ${steps.length}`}</p>
      <ol aria-label="Payment steps" className={cn("mt-2 grid gap-x-2 gap-y-3", withInvoice ? "grid-cols-2 min-[520px]:grid-cols-4" : "grid-cols-3")}>
        {steps.map((label, index) => {
          const state = withInvoice && invoicePending && index === 1 && index < current ? "next" : index < current ? "done" : index === current ? "current" : "next";
          return (
            <li key={label} aria-current={state === "current" ? "step" : undefined} className="grid min-w-0 content-start gap-2">
              <span aria-hidden className={cn("h-1 rounded-full", state === "done" ? "bg-proof" : state === "current" ? "bg-agent" : "bg-line")} />
              <span className={cn("flex items-start gap-1 text-xs leading-5 [overflow-wrap:anywhere]", state === "next" ? "text-ink-3" : "font-medium text-ink")}>
                {state === "done" && <Check aria-hidden className="mt-1 size-3 shrink-0 text-proof" />}
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
