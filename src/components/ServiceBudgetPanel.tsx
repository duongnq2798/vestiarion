"use client";

import { ArrowDownToLine } from "lucide-react";
import { useState } from "react";
import { fundServiceBudgetAction, type FundGatewayResult } from "@/app/actions/treasury";
import { nextRequestId } from "@/components/GatewayPanel";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { ManageDisclosure } from "@/components/vx/ManageDisclosure";
import { utcDay } from "@/lib/copy";
import type { ServiceBudgetView } from "@/lib/service-budget";

const INITIAL: FundGatewayResult = { ok: false, message: "" };

const STATUS: Record<ServiceBudgetView["recent"][number]["status"], string> = { paid: "Bought", refused: "Not bought", failed: "Failed" };

/**
 * The agent's service budget on the console (docs/superpowers/specs/2026-10-02-x402-payee-history-design.md
 * R4, R5): what the Gateway signer holds to pay for lookups over x402, what the agent spent today against its
 * daily most, its last purchases, and for an owner or admin the form that adds to it from the operating wallet.
 */
export function ServiceBudgetPanel({
  orgSlug,
  budget,
  canFund,
  requestId: initialRequestId,
}: {
  orgSlug: string;
  budget: ServiceBudgetView;
  canFund: boolean;
  requestId: string;
}) {
  const [requestId, setRequestId] = useState(initialRequestId);
  const { state, formProps } = useActionForm(fundServiceBudgetAction, INITIAL, {
    resetOnSuccess: true,
    toastOnSuccess: true,
    onResult: (result) => setRequestId((current) => nextRequestId(result, current, () => crypto.randomUUID())),
  });

  return (
    <Card asChild className="overflow-hidden">
      <section>
        <div className="space-y-2 px-4 py-4 sm:px-5">
          <SectionHeader title="Service budget" meta="x402 over Circle Gateway" className="mb-1" />
          <p className="font-mono text-[0.9375rem] tabular-nums text-ink">{budget.balanceUsdc === null ? "—" : `${budget.balanceUsdc} USDC`}</p>
          {budget.balanceUsdc === null && <p className="text-xs text-ink-3">Gateway did not answer just now.</p>}
          <p className="text-xs text-ink-3">
            Spent today: {budget.spentToday} of {budget.dailyCapUsdc} USDC
          </p>
        </div>
        <ManageDisclosure label={canFund ? "Manage" : "Details"}>
          <div className="space-y-3 px-4 pb-4 sm:px-5">
            <p className="text-sm leading-6 text-ink-2">
              Before the agent pays an address for the first time, it buys that address&apos;s payment history across Vestiarion for 0.001 USDC, and weighs it
              in the decision. It pays from this budget only, at most {budget.dailyCapUsdc} USDC a day.
            </p>
            {budget.recent.length > 0 && (
              <ul className="divide-y divide-line rounded-xl border border-line text-sm">
                {budget.recent.map((purchase) => (
                  <li key={purchase.id} className="space-y-0.5 px-3 py-2">
                    <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-ink [overflow-wrap:anywhere]">{purchase.counterpartyName}</span>
                      <span className="text-xs text-ink-3">
                        {STATUS[purchase.status]} · {utcDay(purchase.createdAt)}
                      </span>
                    </p>
                    <p className="text-xs text-ink-3 [overflow-wrap:anywhere]">
                      {purchase.status === "paid"
                        ? `Paid by ${purchase.workspacesPaid ?? 0} ${purchase.workspacesPaid === 1 ? "workspace" : "workspaces"} before, ${purchase.paymentsConfirmed ?? 0} confirmed ${purchase.paymentsConfirmed === 1 ? "payment" : "payments"} · ${purchase.priceUsdc} USDC`
                        : purchase.reason}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {canFund && (
            <form {...formProps} className="space-y-3 border-t border-line px-4 py-4 sm:px-5">
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="requestId" value={requestId} />
              <Field id="service-budget-amount" label="Amount to add from the operating wallet (USDC, at most 1)">
                <Input name="amount" required inputMode="decimal" placeholder="0.05" />
              </Field>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
                <SubmitButton icon={<ArrowDownToLine />} pendingLabel="Adding…" className="shrink-0">
                  Add to the budget
                </SubmitButton>
              </div>
            </form>
          )}
        </ManageDisclosure>
      </section>
    </Card>
  );
}
