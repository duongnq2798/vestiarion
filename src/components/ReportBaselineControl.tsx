"use client";

import { Clock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { answerReportBaselineAction, type ReportShareActionResult } from "@/app/actions/report-share";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: ReportShareActionResult = { ok: false, message: "" };

/**
 * An owner's answer to the report's value question (docs/superpowers/specs/2026-10-10-shared-report-design.md S9): how
 * many minutes one bill took before Vestiarion, and how many people touched it. A changed answer is a new one; the
 * earlier stays in the history and the audit log. The server checks both numbers again.
 */
export default function ReportBaselineControl({ orgSlug, current }: { orgSlug: string; current: { minutesPerBill: number; peoplePerBill: number } | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useActionForm(answerReportBaselineAction, INITIAL, {
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });
  const saved = form.state.ok ? form.state.message : null;
  const error = !form.state.ok && form.state.message ? form.state.message : null;

  return (
    <div className="space-y-1.5">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant={current ? "ghost" : "secondary"} icon={<Clock />} className="justify-self-start">
            {current ? "Change your answer" : "Answer the question"}
          </Button>
        </DialogTrigger>
        <DialogContent
          title="How bills were handled before Vestiarion"
          description="The report estimates from this answer the time the agent saved, or in shadow mode would have saved, and says it is an estimate. A new answer replaces it on the report; the earlier one stays in the audit log."
        >
          <form {...form.formProps} className="grid gap-5">
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="baseline-minutes" label="Before Vestiarion, how many minutes did one bill take you?" description="A whole number, from 1 to 6,000.">
                <Input name="minutesPerBill" required inputMode="numeric" pattern="[0-9,]*" maxLength={6} defaultValue={current ? String(current.minutesPerBill) : ""} />
              </Field>
              <Field id="baseline-people" label="How many people touched it?" description="A whole number, from 1 to 100.">
                <Input name="peoplePerBill" required inputMode="numeric" pattern="[0-9]*" maxLength={3} defaultValue={current ? String(current.peoplePerBill) : ""} />
              </Field>
            </div>
            <FormMessage tone="error">{open ? error : null}</FormMessage>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <SubmitButton pendingLabel="Saving…">Save your answer</SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {!open && saved && <FormMessage>{saved}</FormMessage>}
    </div>
  );
}
