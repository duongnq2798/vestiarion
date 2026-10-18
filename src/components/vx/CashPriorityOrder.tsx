"use client";

import { ArrowDown, ArrowUp, ListOrdered, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { setCashPriorityOrderAction, type CashPriorityActionResult } from "@/app/actions/cash-priority";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

/**
 * Which bill first, on the Payment plan tab (docs/superpowers/specs/2026-10-18-cash-priority-order-design.md O1-O3): the
 * order the cash goes to the bills due soon, each bill paid first or waiting, with its reason; who set it; what the
 * written policy would pay first. An owner, admin or approver moves bills up or down and saves; the server checks the
 * bills are still the ones shown, and the agent decides the ones that moved, each with every check. Which bills the cash
 * covers is worked out here only to show the effect: the server and the cycle work it out again.
 */

export interface PriorityOrderBill {
  id: string;
  payee: string;
  amount: number;
  /** "Oct 24, 2026". */
  due: string;
  reason: string;
}

const INITIAL: CashPriorityActionResult = { ok: false, message: "" };
const CENT_MILLIONTH = 0.0000005;
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** The bills the cash covers walking this order: each kept while the kept total fits; one that does not fit waits. */
function coveredBy(order: readonly PriorityOrderBill[], cash: number): Set<string> {
  const kept = new Set<string>();
  let total = 0;
  for (const bill of order) {
    if (total + bill.amount <= cash + CENT_MILLIONTH) {
      kept.add(bill.id);
      total += bill.amount;
    }
  }
  return kept;
}

export function CashPriorityOrder({
  orgSlug,
  fingerprint,
  available,
  bills,
  setLabel,
  policyFirst,
  canSet,
}: {
  orgSlug: string;
  fingerprint: string;
  available: number;
  bills: PriorityOrderBill[];
  /** "Set by the agent on Oct 17, 2026" or "Set by ana@example.com on Oct 18, 2026". */
  setLabel: string;
  policyFirst: string[];
  canSet: boolean;
}) {
  const router = useRouter();
  const [order, setOrder] = useState(bills);
  const save = useActionForm(setCashPriorityOrderAction, INITIAL, { toastOnSuccess: true, onSuccess: () => router.refresh() });
  const covered = useMemo(() => coveredBy(order, available), [order, available]);
  const changed = order.some((bill, index) => bill.id !== bills[index]?.id);
  const move = (index: number, by: -1 | 1) => {
    const next = [...order];
    const [bill] = next.splice(index, 1);
    next.splice(index + by, 0, bill);
    setOrder(next);
  };

  return (
    <section id="which-bill-first" aria-labelledby="which-bill-first-title" className="scroll-mt-6 space-y-3">
      <SectionHeader id="which-bill-first-title" title="Which bill first" meta={setLabel} />
      <p className="text-sm text-ink-2">
        The cash, {AMOUNT.format(available)} USDC after what is already committed, cannot cover every bill due soon. The cash goes to them in this
        order while it lasts; the rest wait for cash, held for a person. {policyFirst.length > 0 ? `The written policy would pay ${policyFirst.join(", ")} first.` : ""}
      </p>
      <Card className="overflow-hidden">
        <ol aria-label="The order the cash goes to the bills" className="divide-y divide-line">
          {order.map((bill, index) => (
            <li key={bill.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                  <span className="tabular-nums text-ink-3">{index + 1}.</span>
                  {bill.payee}
                  <span className="tabular-nums text-ink-2">{AMOUNT.format(bill.amount)} USDC</span>
                  <Badge tone={covered.has(bill.id) ? "proof" : "held"} size="sm">
                    {covered.has(bill.id) ? "Paid first" : "Waits"}
                  </Badge>
                </p>
                <p className="text-xs text-ink-3">Due {bill.due}</p>
                {bill.reason && <p className="text-xs leading-5 text-ink-2">{bill.reason}</p>}
              </div>
              {canSet && (
                <div className="flex shrink-0 gap-1">
                  <Button type="button" size="sm" variant="ghost" icon={<ArrowUp />} disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${bill.payee} ${AMOUNT.format(bill.amount)} USDC up`}>
                    Up
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    icon={<ArrowDown />}
                    disabled={index === order.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={`Move ${bill.payee} ${AMOUNT.format(bill.amount)} USDC down`}
                  >
                    Down
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      </Card>
      {canSet ? (
        <form {...save.formProps} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="fingerprint" value={fingerprint} />
          <input type="hidden" name="order" value={JSON.stringify(order.map((bill) => bill.id))} />
          <SubmitButton icon={<ListOrdered />} pendingLabel="Saving the order…" disabled={!changed}>
            Use this order
          </SubmitButton>
          {changed && (
            <Button type="button" variant="ghost" icon={<RotateCcw />} onClick={() => setOrder(bills)}>
              Put it back
            </Button>
          )}
          <FormMessage tone="error" className="min-h-0 basis-full">
            {!save.state.ok && save.state.message ? save.state.message : null}
          </FormMessage>
          <p className="basis-full text-xs text-ink-3">
            The agent keeps your order while these bills stay the same, and orders them again when one is added, paid or changed. It never pays more
            than the cash holds, and every payment passes every check.
          </p>
        </form>
      ) : (
        <p className="text-xs text-ink-3">An owner, admin or approver can change the order.</p>
      )}
    </section>
  );
}
