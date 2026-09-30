"use client";

import { FlaskConical, Trash2 } from "lucide-react";
import { loadSampleDataAction, removeSampleDataAction, type SampleDataActionResult } from "@/app/actions/sample-data";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormMessage } from "@/components/ui/FormMessage";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: SampleDataActionResult = { ok: false, message: "" };

/**
 * The console's sample data (sample-data design §1): an offer while a
 * simulated sandbox is empty, and a callout with removal while the sample is
 * loaded. The console decides which shows (`offerSampleData`); the server
 * actions refuse on their own whatever the page showed.
 */
export function SampleDataOffer({ orgSlug }: { orgSlug: string }) {
  const { state, pending, formProps } = useActionForm(loadSampleDataAction, INITIAL, { toastOnSuccess: true });

  return (
    <Card asChild className="mb-8 p-4 sm:p-5">
      <section aria-labelledby="sample-data-title">
        <form {...formProps} className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <div className="min-w-0 space-y-1">
            <h2 id="sample-data-title" className="text-sm font-semibold text-ink">
              Try it with sample data
            </h2>
            <p className="text-sm text-ink-2">
              Six example counterparties with invoices and milestones, chosen so that one cycle shows every outcome: a payment, a hold, a flag, a question and a milestone release. Payments are simulated, and you can remove the sample at any time.
            </p>
          </div>
          <Button type="submit" variant="secondary" icon={<FlaskConical />} loading={pending} className="shrink-0">
            Load sample data
          </Button>
        </form>
        {!state.ok && state.message && (
          <FormMessage tone="error" className="mt-3">
            {state.message}
          </FormMessage>
        )}
      </section>
    </Card>
  );
}

export function SampleDataLoaded({ orgSlug, canRemove }: { orgSlug: string; canRemove: boolean }) {
  return (
    <Callout tone="agent" title="Sample data is loaded" className="mb-8">
      <p>
        The counterparties marked Sample, and everything recorded against them, are examples. Remove them before you connect Circle.
      </p>
      {canRemove && <RemoveSampleDataForm orgSlug={orgSlug} />}
    </Callout>
  );
}

function RemoveSampleDataForm({ orgSlug }: { orgSlug: string }) {
  const formId = "remove-sample-data";
  const { state, pending, formProps } = useActionForm(removeSampleDataAction, INITIAL, { toastOnSuccess: true });

  return (
    <form id={formId} {...formProps} className="mt-3 flex flex-col items-start gap-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <ConfirmDialog
        formId={formId}
        trigger={
          <Button variant="secondary" size="sm" icon={<Trash2 />} loading={pending}>
            Remove sample data
          </Button>
        }
        title="Remove the sample data?"
        description="The sample counterparties go, with every invoice, milestone and payment recorded against them, including any you added to them. The ledger keeps its entries."
        confirmLabel="Remove sample data"
      />
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}
