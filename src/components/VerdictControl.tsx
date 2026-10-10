"use client";

import { Check, CircleCheck, ThumbsDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { giveVerdictAction } from "@/app/actions/verdicts";
import { paymentSendingToast, paymentToastId, settlePaymentToast } from "@/components/payment-toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Textarea } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import type { VerdictView } from "@/lib/verdict-view";

/**
 * A person's verdict on the agent's decision, on its card (docs/superpowers/specs/2026-10-07-shadow-mode-design.md
 * S3–S5): Agree, or Disagree with a reason. On a payment held for the verdict, agreeing pays it, after a confirmation,
 * and disagreeing returns it to the agent or rejects it. A verdict given is shown in its place; someone who may not
 * decide payments reads that one is awaited.
 */

type After = "pay" | "return" | "reject";

/** What Agree and pay does, said before it does it: in a sandbox with no Circle account, the payment is simulated. */
const AGREE_AND_PAY = "You agree with the agent, and it is paid in USDC on Arc testnet now.";
const AGREE_AND_PAY_SIMULATED = "You agree with the agent, and it is paid now, simulated in this sandbox.";
type Note = { tone: "neutral" | "error"; text: string } | null;

const SETTLE_OPTIONS = [
  { value: "return", label: "Decide it again later", description: "The agent decides it again in its next cycle." },
  { value: "reject", label: "Do not pay it", description: "It is rejected, with your reason in the ledger." },
] as const;

/**
 * `payBlocked`: why the viewer may not pay it now (they entered it, gave its payee's address, or it needs another
 * approval): they agree without paying, and another person pays it in Approvals (shadow mode review I2).
 */
export default function VerdictControl({ orgSlug, view, payBlocked = null }: { orgSlug: string; view: VerdictView; payBlocked?: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const [disagreeing, setDisagreeing] = useState(false);
  const [reason, setReason] = useState("");
  const [settle, setSettle] = useState<"return" | "reject">("return");

  if (view.given) {
    const said = view.given.verdict === "agree" ? (view.given.reason ? `You agreed: ${view.given.reason}` : "You agreed.") : `You disagreed: ${view.given.reason ?? ""}`;
    return <p className="text-sm text-ink-2">{said}</p>;
  }
  if (!view.open) return <p className="text-sm text-ink-2">Waits for a person&apos;s verdict.</p>;

  const give = (verdict: "agree" | "disagree", then?: After, typed?: string, onDone?: () => void) =>
    startTransition(async () => {
      setNote(null);
      // The address the card showed goes with a payment, which is refused if it changed since (shadow mode review C1).
      const shown = then === "pay" ? { shownAddress: view.payment?.address ?? undefined } : {};
      // A payment agreed to is told as it goes: approved and being sent, then confirmed or still processing. Its
      // confirmation outlives the card it paid, which leaves the page (payment confirmation).
      const paying = then === "pay" ? paymentToastId(`verdict-${view.entrySeq}`) : null;
      if (paying && view.payment) paymentSendingToast(paying, { amount: view.payment.amountUsdc, currency: "USDC", payee: view.payment.payee, decidedBy: "verdict" });
      const result = await giveVerdictAction(orgSlug, { entrySeq: view.entrySeq, verdict, ...(typed ? { reason: typed } : {}), ...(then ? { then } : {}), ...shown }).catch(
        (error: unknown) => {
          if (paying) settlePaymentToast(paying, null);
          throw error;
        }
      );
      setNote({ tone: result.ok ? "neutral" : "error", text: result.message });
      if (paying) settlePaymentToast(paying, result);
      if (result.ok) onDone?.();
      router.refresh();
    });

  const submitDisagreement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    give("disagree", view.heldForVerdict ? settle : undefined, reason.trim(), () => setDisagreeing(false));
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-ink">Do you agree with the agent?</p>
      {view.heldForVerdict && view.payment && <p className="text-sm text-ink-2">{paysLine(view.payment)}</p>}
      <div className="flex flex-wrap gap-2">
        {view.heldForVerdict && !payBlocked ? (
          <ConfirmDialog
            tone="primary"
            trigger={
              <Button size="sm" icon={<CircleCheck />} loading={pending}>
                Agree and pay
              </Button>
            }
            title="Agree and pay?"
            description={`${view.simulated ? AGREE_AND_PAY_SIMULATED : AGREE_AND_PAY}${view.payment ? ` ${paysLine(view.payment)}` : ""}`}
            confirmLabel="Agree and pay"
            onConfirm={() => give("agree", "pay")}
          />
        ) : (
          <Button size="sm" icon={<Check />} loading={pending} onClick={() => give("agree")}>
            Agree
          </Button>
        )}
        <Dialog open={disagreeing} onOpenChange={setDisagreeing}>
          <DialogTrigger asChild>
            <Button size="sm" variant="secondary" icon={<ThumbsDown />} disabled={pending}>
              Disagree
            </Button>
          </DialogTrigger>
          <DialogContent title="Disagree with the agent?" description="Your reason is kept with the verdict in the ledger.">
            <form onSubmit={submitDisagreement} className="grid gap-5">
              <Field id={`verdict-reason-${view.entrySeq}`} label="Why do you disagree?" description="At most 280 characters.">
                <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={280} rows={3} required />
              </Field>
              {view.heldForVerdict && (
                <RadioGroup legend="Then" options={SETTLE_OPTIONS} value={settle} onValueChange={(value) => setSettle(value === "reject" ? "reject" : "return")} />
              )}
              <FormMessage tone={note?.tone ?? "neutral"}>{disagreeing ? note?.text : null}</FormMessage>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary">Cancel</Button>
                </DialogClose>
                <Button type="submit" loading={pending} disabled={reason.trim() === ""}>
                  Disagree
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      {view.heldForVerdict && payBlocked && (
        <p className="text-sm text-ink-2">{`${payBlocked}: Agree records your verdict, and another person pays it in Approvals.`}</p>
      )}
      <FormMessage tone={note?.tone ?? "neutral"}>{note?.text}</FormMessage>
    </div>
  );
}

/** What agreeing pays, in a line: the amount, the payee, and the address the card shows. */
function paysLine(payment: NonNullable<VerdictView["payment"]>): string {
  return `Pays ${payment.amountUsdc} USDC to ${payment.payee}${payment.address ? `, at ${payment.address}` : ""}.`;
}
