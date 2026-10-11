"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approvePlanAction } from "@/app/actions/payment-plan";
import { refreshOnChainBalanceAction } from "@/app/actions/treasury";
import { Button } from "@/components/ui/Button";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";

/**
 * The payment plan's controls (docs/superpowers/specs/2026-10-11-payment-plan-design.md P9, P10, P12): Approve on one
 * line, Approve all shown, and Refresh balance when the chain's figure is too old to approve on. The server checks
 * everything again; these only send what the person was shown.
 */

const INITIAL: ActionResult = { ok: false, message: "" };
const approve = withSuccessToast(approvePlanAction);

/** What every approval sends: the workspace, and the plan the person was shown. */
function PlanFields({ orgSlug, planFingerprint, lines }: { orgSlug: string; planFingerprint: string; lines: ReadonlyArray<{ id: string; fingerprint: string }> }) {
  return (
    <>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="planFingerprint" value={planFingerprint} />
      {lines.map((line) => (
        <input key={line.id} type="hidden" name="line" value={`${line.id}:${line.fingerprint}`} />
      ))}
    </>
  );
}

/** Approve on one line: moves that scheduled bill to the plan's day. */
export function ApprovePlanLine({
  orgSlug,
  planFingerprint,
  line,
  label,
  disabled = false,
  describedBy,
}: {
  orgSlug: string;
  planFingerprint: string;
  line: { id: string; fingerprint: string };
  /** The button's accessible name: what it approves. */
  label: string;
  disabled?: boolean;
  /** The id of what says why it is off. */
  describedBy?: string;
}) {
  const form = useActionForm(approve, INITIAL);
  const failed = form.state.message !== "" && !form.state.ok;
  return (
    <form {...form.formProps} className="flex flex-col items-end gap-1">
      <PlanFields orgSlug={orgSlug} planFingerprint={planFingerprint} lines={[line]} />
      <SubmitButton size="sm" variant="secondary" disabled={disabled} aria-label={label} aria-describedby={describedBy} pendingLabel="Approving…">
        Approve
      </SubmitButton>
      {failed && <FormMessage tone="error" className="max-w-xs text-right text-xs">{form.state.message}</FormMessage>}
    </form>
  );
}

/** Approve all shown: every line the person sees as approvable, each checked again on its own by the server. */
export function ApproveAllShown({
  orgSlug,
  planFingerprint,
  lines,
  disabled = false,
  describedBy,
}: {
  orgSlug: string;
  planFingerprint: string;
  lines: ReadonlyArray<{ id: string; fingerprint: string }>;
  disabled?: boolean;
  describedBy?: string;
}) {
  const form = useActionForm(approve, INITIAL);
  return (
    <form {...form.formProps} className="flex flex-col gap-1.5">
      <PlanFields orgSlug={orgSlug} planFingerprint={planFingerprint} lines={lines} />
      <div>
        <SubmitButton size="sm" disabled={disabled || lines.length === 0} aria-describedby={describedBy} pendingLabel="Approving…">
          Approve all shown
        </SubmitButton>
      </div>
      <FormMessage tone={form.state.ok ? "success" : "error"}>{form.state.message}</FormMessage>
    </form>
  );
}

/** Reads the operating wallet's balance from the chain again, then shows the plan built on it. */
export function RefreshPlanBalance({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const refresh = () =>
    startTransition(async () => {
      const result = await refreshOnChainBalanceAction(orgSlug);
      setMessage(result.ok ? "" : (result.message ?? "The balance could not be read. Try again in a moment."));
      router.refresh();
    });
  return (
    <div className="flex flex-col items-start gap-1">
      <Button size="sm" variant="secondary" icon={<RefreshCw aria-hidden />} loading={pending} onClick={refresh}>
        Refresh balance
      </Button>
      <FormMessage tone="error" className="text-xs">
        {message}
      </FormMessage>
    </div>
  );
}
