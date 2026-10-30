"use client";

import { ArrowUpRight, Banknote } from "lucide-react";
import { useCallback, useRef, useState, type FormEvent } from "react";
import { approveManyAction, type ApproveManyActionResult } from "@/app/actions/approvals";
import { REASON_HINT } from "@/components/ApprovalCard";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { Money } from "@/components/vx/Primitives";
import { shortAddress } from "@/lib/address-change-check-words";
import type { SelectionLine } from "@/lib/commands/payables";
import { MAX_SELECTION, totalOf, type SelectableBill } from "./selection-context";

const INITIAL: ApproveManyActionResult = { ok: false, message: "" };

/** The confirmation's title: what the one button does to the bills it lists (approve many AM1, AM5). */
export function confirmTitle(count: number, anyPays: boolean, sandbox: boolean): string {
  return anyPays ? `Approve and pay ${count} bills?${sandbox ? " (simulated)" : ""}` : `Approve ${count} bills?`;
}

/** What one confirmation does with each bill, and with the transfers that pay now (AM1, AM6, AM7). */
export const CONFIRM_DESCRIPTION =
  "Each bill is approved as Approve and pay approves it alone: the same checks, and its own entry in the ledger. The ones that pay now are sent together, in one Arc transaction where they can be.";

/** Why the operating wallet must hold the whole total: a selection never brings cash back from the reserve (AM4). */
export const FUNDS_NOTE = "The operating wallet must hold the total: a selection never brings cash back from the reserve.";

/** A bill above the figure for two approvals whose first approval this is: it pays nothing yet (AM5, two approvals T4). */
export const FIRST_OF_TWO = "First of two approvals: nothing is paid yet.";

/** A bill whose early-payment discount still applies: it comes off at the transfer, as alone (AM4). */
export const DISCOUNT_NOTE = "Its early-payment discount comes off at the transfer.";

/** The confirm button: Pay now where every bill pays, Approve where none does, both words where some do. */
export function confirmLabel(bills: ReadonlyArray<Pick<SelectableBill, "pays">>): string {
  if (bills.every((bill) => bill.pays)) return "Pay now";
  return bills.some((bill) => bill.pays) ? "Approve and pay" : "Approve";
}

/** Each bill's outcome in a word, as AM11 lists them: paid, submitted, approved, or not paid with the reason. */
export const OUTCOME: Record<SelectionLine["outcome"], { label: string; tone: BadgeProps["tone"] }> = {
  paid: { label: "Paid", tone: "proof" },
  submitted: { label: "Submitted", tone: "held" },
  approved: { label: "Approved", tone: "agent" },
  held: { label: "Not paid", tone: "refused" },
  refused: { label: "Not paid", tone: "refused" },
};

/**
 * The one confirmation for a selection (docs/superpowers/specs/2026-10-30-approve-many-design.md), then what it did.
 *
 * Before: each bill with its payee, the address its card shows, shortened, and its amount, then the total the operating
 * wallet must hold (AM4), and, when any bill goes against the agent's hold, one optional "Why pay them anyway?" (AM9).
 * Its button pays; a key never does (AM12). While the bills are sent, the dialog stays open with the bills it sent.
 *
 * After: one line per bill, paid with its amount, submitted, approved, or not paid with the reason, and the transaction
 * bills shared, with View transaction (AM11); the selection then clears. A selection refused whole, the wrong size or
 * more than the operating wallet holds, keeps the selection and says why, here (AM3, AM4).
 */
export function ApproveSelectionDialog({
  open,
  onOpenChange,
  orgSlug,
  sandbox,
  bills,
  onDecided,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  sandbox: boolean;
  /** The selection, in the page's order. */
  bills: readonly SelectableBill[];
  /** Runs once the bills were decided, whatever each one's outcome: the selection clears (AM11). */
  onDecided: () => void;
  /** As the dialog closes: where focus goes when what opened it is gone, such as the bar the selection took with it. */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  // The bills as sent: a refresh while they are being decided takes them off the page, never out of this list.
  const [sent, setSent] = useState<readonly SelectableBill[] | null>(null);
  const [result, setResult] = useState<ApproveManyActionResult | null>(null);
  const settled = useCallback(
    (state: ApproveManyActionResult) => {
      if (!state.bills) {
        setSent(null);
        return;
      }
      setResult(state);
      onDecided();
    },
    [onDecided]
  );
  const form = useActionForm(approveManyAction, INITIAL, { onResult: settled });
  const cancel = useRef<HTMLButtonElement>(null);
  const listed = sent ?? bills;
  const anyPays = listed.some((bill) => bill.pays);
  const askWhy = listed.some((bill) => bill.overridesHold);
  const fits = listed.length >= 2 && listed.length <= MAX_SELECTION;

  function submit(event: FormEvent<HTMLFormElement>) {
    setSent(bills);
    form.formProps.onSubmit(event);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Nothing closes it while the bills are being sent: what each one did is read here once they were.
        if (!next && form.pending) return;
        onOpenChange(next);
      }}
    >
      {result ? (
        <DialogContent title={result.message} onInteractOutside={(event) => event.preventDefault()} onCloseAutoFocus={onCloseAutoFocus}>
          <SelectionResult result={result} bills={sent ?? []} />
          <DialogFooter className="mt-5">
            <DialogClose asChild>
              <Button autoFocus>Done</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      ) : (
        <DialogContent
          title={confirmTitle(listed.length, anyPays, sandbox)}
          description={CONFIRM_DESCRIPTION}
          showClose={!form.pending}
          // A click outside never closes a confirmation, and it opens on Cancel: the person chooses, as ConfirmDialog asks.
          onInteractOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={onCloseAutoFocus}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancel.current?.focus();
          }}
        >
          <form {...form.formProps} onSubmit={submit} className="grid gap-4">
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <input type="hidden" name="items" value={JSON.stringify(listed.map((bill) => ({ invoiceId: bill.id, address: bill.address })))} />
            {/* Up to twenty bills scroll in their own box, so the total and the button stay in view on a phone. */}
            <ul aria-label="Bills to approve" tabIndex={0} className="max-h-[min(22rem,45dvh)] divide-y divide-line overflow-y-auto rounded-xl border border-line">
              {listed.map((bill) => (
                <li key={bill.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{bill.payee}</p>
                    <p className="font-mono text-xs text-ink-3" title={bill.address}>
                      {shortAddress(bill.address)}
                    </p>
                    {!bill.pays && <p className="mt-0.5 text-xs text-ink-2">{FIRST_OF_TWO}</p>}
                    {bill.pays && bill.discounted && <p className="mt-0.5 text-xs text-ink-2">{DISCOUNT_NOTE}</p>}
                  </div>
                  <Money value={bill.amount} className="shrink-0 text-sm font-semibold text-ink" />
                </li>
              ))}
            </ul>
            <div className="flex items-baseline justify-between gap-3 px-3 text-sm">
              <span className="font-medium text-ink">Total</span>
              <Money value={totalOf(listed)} className="font-semibold text-ink" />
            </div>
            <p className="text-xs text-ink-2">{FUNDS_NOTE}</p>
            {askWhy && (
              <Field id="approve-many-reason" label="Why pay them anyway?" optional description={REASON_HINT}>
                <Input
                  name="reason"
                  maxLength={280}
                  autoComplete="off"
                  // Enter in a form's text field submits it, which here would pay every bill: only the button pays, as
                  // Approve and pay's own reason field submits nothing (AM12; approve many review ui-2).
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
                  }}
                />
              </Field>
            )}
            <FormMessage tone={form.state.message && !form.state.ok ? "error" : "neutral"}>{form.state.bills ? null : form.state.message}</FormMessage>
            <DialogFooter>
              <DialogClose asChild>
                <Button ref={cancel} variant="secondary" disabled={form.pending}>
                  Cancel
                </Button>
              </DialogClose>
              <SubmitButton icon={<Banknote />} disabled={!fits} pendingLabel={anyPays ? "Paying…" : "Approving…"}>
                {confirmLabel(listed)}
              </SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** What the confirmation did: the transaction bills shared, then one line per bill, in the order they were decided (AM11). */
function SelectionResult({ result, bills }: { result: ApproveManyActionResult; bills: readonly SelectableBill[] }) {
  const lines = result.bills ?? [];
  const shared = result.transaction;
  const waiting = shared ? lines.some((line) => line.outcome === "submitted" && line.txRef === shared.txRef) : false;
  return (
    <div className="grid gap-4">
      {shared && (
        <Callout tone={waiting ? "held" : "proof"} role="status">
          <p>{shared.message}</p>
          {shared.txUrl && (
            <a
              href={shared.txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-0.5 text-xs font-medium text-agent underline-offset-2 hover:underline"
            >
              View transaction
              <ArrowUpRight aria-hidden className="size-3.5" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
        </Callout>
      )}
      <ul className="divide-y divide-line rounded-xl border border-line">
        {lines.map((line) => {
          const outcome = OUTCOME[line.outcome];
          // A bill the server could not read as waiting names no payee: the page's own name for it stands in.
          const payee = line.payee ?? bills.find((bill) => bill.id === line.invoiceId)?.payee ?? "A bill";
          return (
            <li key={line.invoiceId} className="grid gap-1 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="flex min-w-0 items-center gap-2">
                  <Badge tone={outcome.tone} size="sm" dot>
                    {outcome.label}
                  </Badge>
                  <span className="truncate text-sm font-medium text-ink">{payee}</span>
                </span>
                {line.amount !== null && <Money value={line.amount} token={line.currency ?? "USDC"} className="text-sm font-semibold text-ink" />}
              </div>
              <p className="text-xs text-ink-2">{line.message}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
