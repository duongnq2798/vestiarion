"use client";

import { ArrowDown, ArrowUp, ListOrdered, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { setCashPriorityOrderAction, type CashPriorityActionResult } from "@/app/actions/cash-priority";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { toast } from "@/components/ui/Toaster";
import { useActionForm } from "@/components/ui/useActionForm";

/**
 * Which bill first, on the Payment plan tab (docs/superpowers/specs/2026-10-18-cash-priority-order-design.md O1-O3): the
 * order the cash goes to the bills due soon, each bill paid first or waiting, with its reason; who set it; what the
 * written policy would pay first. An owner, admin or approver moves bills up or down and saves; the server checks the
 * bills and their order are still the ones shown, and the agent decides the ones that moved, each with every check.
 * Which bills the cash covers is worked out here only to show the effect: the server and the cycle work it out again.
 * A refusal is toasted as well as shown, since the section goes when the order it showed is out of date.
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

const nameOf = (bill: PriorityOrderBill) => `${bill.payee} ${AMOUNT.format(bill.amount)} USDC, due ${bill.due}`;

export function CashPriorityOrder({
  orgSlug,
  fingerprint,
  basedOn,
  available,
  bills,
  setLabel,
  policyFirst,
  canSet,
}: {
  orgSlug: string;
  fingerprint: string;
  /** When the order shown was signed: the server refuses to save over a newer one. */
  basedOn: string;
  available: number;
  bills: PriorityOrderBill[];
  /** "Set by the agent on Oct 17, 2026" or "Set by ana@example.com on Oct 18, 2026". */
  setLabel: string;
  policyFirst: string[];
  canSet: boolean;
}) {
  const router = useRouter();
  const [order, setOrder] = useState(bills);
  const [announced, setAnnounced] = useState("");
  /** The button to give focus back to after a move, by bill and direction, once the list has moved. */
  const focusAfter = useRef<{ id: string; by: -1 | 1 } | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const save = useActionForm(setCashPriorityOrderAction, INITIAL, {
    toastOnSuccess: true,
    onSuccess: () => router.refresh(),
    onResult: (result) => {
      if (!result.ok && result.message) toast.error(result.message);
    },
  });
  const covered = useMemo(() => coveredBy(order, available), [order, available]);
  const changed = order.some((bill, index) => bill.id !== bills[index]?.id);

  useEffect(() => {
    const want = focusAfter.current;
    if (!want) return;
    focusAfter.current = null;
    const index = order.findIndex((bill) => bill.id === want.id);
    // At the top or the bottom, the button pressed is disabled: the other one takes the focus.
    const by = (want.by === -1 && index === 0) || (want.by === 1 && index === order.length - 1) ? -want.by : want.by;
    buttons.current.get(`${want.id}:${by}`)?.focus();
  }, [order]);

  const move = (index: number, by: -1 | 1) => {
    const next = [...order];
    const [bill] = next.splice(index, 1);
    next.splice(index + by, 0, bill);
    focusAfter.current = { id: bill.id, by };
    setOrder(next);
    const place = index + by + 1;
    setAnnounced(`${nameOf(bill)} moved to ${place} of ${next.length}: ${coveredBy(next, available).has(bill.id) ? "paid first" : "waits"}.`);
  };

  return (
    <section id="which-bill-first" aria-labelledby="which-bill-first-title" className="scroll-mt-6 space-y-3">
      <SectionHeader id="which-bill-first-title" title="Which bill first" meta={setLabel} />
      <p className="text-sm text-ink-2">
        The cash, {AMOUNT.format(available)} USDC after what is already committed, cannot cover every bill due soon. The cash goes to them in this
        order while it lasts; the rest wait for cash, held for a person. {policyFirst.length > 0 ? `The written policy would pay ${policyFirst.join(", ")} first.` : ""}
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {announced}
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
                  <Button
                    ref={(element) => {
                      buttons.current.set(`${bill.id}:-1`, element);
                    }}
                    type="button"
                    size="sm"
                    variant="ghost"
                    icon={<ArrowUp />}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    aria-label={`Move ${nameOf(bill)} up`}
                  >
                    Up
                  </Button>
                  <Button
                    ref={(element) => {
                      buttons.current.set(`${bill.id}:1`, element);
                    }}
                    type="button"
                    size="sm"
                    variant="ghost"
                    icon={<ArrowDown />}
                    disabled={index === order.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={`Move ${nameOf(bill)} down`}
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
          <input type="hidden" name="basedOn" value={basedOn} />
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
            The agent keeps your order while these bills stay the same, and for the bills still due once some are paid. When a bill is added or
            changes, it orders them again, keeping your order for the bills it had. It never pays more than the cash holds, and every payment
            passes every check.
          </p>
        </form>
      ) : (
        <p className="text-xs text-ink-3">An owner, admin or approver can change the order.</p>
      )}
    </section>
  );
}
