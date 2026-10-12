"use client";

import { CalendarClock, FileOutput, XCircle } from "lucide-react";
import { useId } from "react";
import { releaseDealLineAction, changeDealAction, setDealAutoReleaseAction, type DealActionResult } from "@/app/actions/deals";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: DealActionResult = { ok: false, message: "" };

/** Release now: the line becomes a receivable, through the path every receivable takes (deal schedule D10). */
export function ReleaseLineButton({ orgSlug, dealId, lineId, label, again = false }: { orgSlug: string; dealId: string; lineId: string; label: string; again?: boolean }) {
  const { state, formProps } = useActionForm(releaseDealLineAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-col items-end gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="dealId" value={dealId} />
      <input type="hidden" name="lineId" value={lineId} />
      <SubmitButton size="sm" variant="secondary" icon={<FileOutput />} pendingLabel="Releasing…" aria-label={`${again ? "Release again" : "Release now"}: ${label}`}>
        {again ? "Release again" : "Release now"}
      </SubmitButton>
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}

/** Whether the agent releases each line on its invoice day (D10): set by an owner or admin, and signed. */
export function AutoReleaseSwitch({ orgSlug, dealId, on }: { orgSlug: string; dealId: string; on: boolean }) {
  const { state, formProps } = useActionForm(setDealAutoReleaseAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-col items-start gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="dealId" value={dealId} />
      <input type="hidden" name="on" value={on ? "false" : "true"} />
      <SubmitButton size="sm" variant="secondary" icon={<CalendarClock />} pendingLabel="Saving…">
        {on ? "Stop releasing on invoice days" : "Release each line on its invoice day"}
      </SubmitButton>
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}

/** Cancel deal: stops every line not invoiced yet; the receivables made stay (D9). Asked first. */
export function CancelDealButton({
  orgSlug,
  dealId,
  baseVersion,
  idempotencyKey,
  stops,
}: {
  orgSlug: string;
  dealId: string;
  baseVersion: number;
  idempotencyKey: string;
  /** What it stops, in words: "2 lines not invoiced yet, 7,000.00 USDC". */
  stops: string;
}) {
  const formId = useId();
  const { state, formProps } = useActionForm(changeDealAction, INITIAL, { toastOnSuccess: true });
  return (
    <form id={formId} {...formProps} className="flex flex-col items-start gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="dealId" value={dealId} />
      <input type="hidden" name="baseVersion" value={baseVersion} />
      <input type="hidden" name="kind" value="cancelled" />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <ConfirmDialog
        trigger={
          <Button type="button" size="sm" variant="secondary" icon={<XCircle />}>
            Cancel deal
          </Button>
        }
        title="Cancel this deal?"
        description={`It stops ${stops}. The receivables already made stay as they are, and the cancel is signed as a new version.`}
        confirmLabel="Cancel deal"
        cancelLabel="Keep it"
        formId={formId}
      />
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}
