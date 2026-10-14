"use client";

import { PenLine, Settings } from "lucide-react";
import Link from "next/link";
import { overwriteHubSpotReceiptAction, type HubSpotActionResult } from "@/app/actions/hubspot";
import { overwritePipedriveReceiptAction } from "@/app/actions/pipedrive";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { CrmReceiptView, FieldLine, ReceiptStatus } from "@/lib/connectors/crm-receipts-view";

const INITIAL: HubSpotActionResult = { ok: false, message: "" };

const BADGE: Record<ReceiptStatus, (label: string) => { tone: "proof" | "neutral" | "held" | "refused"; text: string }> = {
  written: () => ({ tone: "proof", text: "Written" }),
  waiting: () => ({ tone: "neutral", text: "Waiting" }),
  failed: () => ({ tone: "held", text: "Not written yet" }),
  conflict: (label) => ({ tone: "held", text: `Changed in ${label}` }),
  not_allowed: () => ({ tone: "neutral", text: "Not allowed yet" }),
  refused: () => ({ tone: "refused", text: "Not written" }),
};

function Fields({ fields }: { fields: FieldLine[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm min-[520px]:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
      {fields.map((field) => (
        <div key={field.label} className="contents">
          <dt className="text-ink-3">{field.label}</dt>
          <dd className="min-w-0 break-words text-ink tabular-nums">
            {field.href ? (
              <a className="font-medium text-agent underline-offset-4 hover:underline" href={field.href} target="_blank" rel="noreferrer">
                {field.value}
              </a>
            ) : (
              field.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const utc = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * A deal's receipts in the CRM it was planned from (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R8): what
 * was written there and when, as the CRM read it back; where the next write stands (waiting, failed with when it is
 * tried again, not allowed yet, not written by the reality rule); and a conflict, field by field, with Write
 * Vestiarion's figures for an owner or admin, acting on exactly the conflict shown. Every member sees it.
 */
export function CrmReceiptCard({ orgSlug, dealId, view, canManage }: { orgSlug: string; dealId: string; view: CrmReceiptView; canManage: boolean }) {
  // Each CRM's own action: it runs that CRM's writes at once (Pipedrive connector P11).
  const { state, formProps } = useActionForm(view.provider === "pipedrive" ? overwritePipedriveReceiptAction : overwriteHubSpotReceiptAction, INITIAL, { toastOnSuccess: true });
  const badge = BADGE[view.status](view.label);
  const settings = `/o/${orgSlug}/settings#${view.label.toLowerCase()}`;
  return (
    <section aria-labelledby="crm-receipt-title">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <h2 id="crm-receipt-title" className="text-base font-semibold text-ink">
              Receipts in {view.label}
            </h2>
            <p className={view.status === "refused" ? "font-medium text-refused" : view.status === "conflict" || view.status === "failed" ? "font-medium text-held" : "font-medium text-ink"}>
              {view.title}
            </p>
          </div>
          <Badge tone={badge.tone} dot>
            {badge.text}
          </Badge>
        </div>
        {view.detail.map((line) => (
          <p key={line} className="max-w-prose text-sm text-ink-2">
            {line}
          </p>
        ))}

        {view.conflicts.length > 0 && (
          <ul className="space-y-3 text-sm sm:hidden">
            {view.conflicts.map((conflict) => (
              <li key={conflict.label} className="space-y-0.5 border-t border-line pt-2">
                <p className="font-medium text-ink">{conflict.label}</p>
                <p className="text-ink-2">Vestiarion last wrote: {conflict.ours}</p>
                <p className="font-medium text-held">
                  {view.label} holds now: {conflict.theirs}
                </p>
                <p className="text-ink-2">Vestiarion would write: {conflict.next}</p>
              </li>
            ))}
          </ul>
        )}
        {view.conflicts.length > 0 && (
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[30rem] text-left text-sm">
              <caption className="sr-only">Fields changed in {view.label}</caption>
              <thead className="text-xs text-ink-3">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Field
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Vestiarion last wrote
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {view.label} holds now
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Vestiarion would write
                  </th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {view.conflicts.map((conflict) => (
                  <tr key={conflict.label} className="border-t border-line">
                    <th scope="row" className="py-1.5 pr-3 font-medium text-ink">
                      {conflict.label}
                    </th>
                    <td className="py-1.5 pr-3 text-ink-2">{conflict.ours}</td>
                    <td className="py-1.5 pr-3 font-medium text-held">{conflict.theirs}</td>
                    <td className="py-1.5 text-ink-2">{conflict.next}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {view.status === "conflict" && view.seen && (
          canManage ? (
            <form {...formProps} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="dealId" value={dealId} />
              <input type="hidden" name="seen" value={view.seen} />
              <SubmitButton size="sm" variant="secondary" pendingLabel="Writing…" icon={<PenLine aria-hidden />}>
                Write Vestiarion&apos;s figures to {view.label}
              </SubmitButton>
              <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
            </form>
          ) : (
            <p className="text-sm text-ink-3">An owner or admin chooses what {view.label} keeps.</p>
          )
        )}
        {view.fix && canManage && (
          <Button asChild size="sm" variant="secondary">
            <Link href={settings}>
              <Settings aria-hidden />
              {view.fix === "allow" ? `Allow writing to ${view.label}` : view.fix === "turn_on" ? `Write receipts to ${view.label}` : `Reconnect ${view.label}`}
            </Link>
          </Button>
        )}

        {view.pending && view.status !== "conflict" && (
          <div className="space-y-2 border-t border-line pt-4">
            <h3 className="text-sm font-semibold text-ink">{view.status === "failed" ? "What Vestiarion tries to write" : "What Vestiarion will write"}</h3>
            <Fields fields={view.pending} />
          </div>
        )}
        {view.lastWritten ? (
          <div className="space-y-2 border-t border-line pt-4">
            <h3 className="text-sm font-semibold text-ink">
              {view.status === "written" ? "In" : "Last written to"} {view.label}, read back at {utc(view.lastWritten.at)}
            </h3>
            <Fields fields={view.lastWritten.fields} />
          </div>
        ) : (
          view.status !== "written" && <p className="border-t border-line pt-4 text-sm text-ink-3">Nothing written to {view.label} yet.</p>
        )}
      </Card>
    </section>
  );
}
