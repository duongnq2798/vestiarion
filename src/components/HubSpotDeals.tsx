"use client";

import { ArrowRight, Handshake, Mail } from "lucide-react";
import Link from "next/link";
import { fillCrmEmailAction, type HubSpotActionResult } from "@/app/actions/hubspot";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { CrmEmailView, CrmRowView } from "@/lib/connectors/crm-review";

const INITIAL: HubSpotActionResult = { ok: false, message: "" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 1, 2026", a close day. */
function day(value: string): string {
  return `${MONTHS[Number(value.slice(5, 7)) - 1]} ${Number(value.slice(8, 10))}, ${value.slice(0, 4)}`;
}

function facts(row: CrmRowView, won: boolean): string {
  return [row.amount ?? "No amount", row.closeOn ? `${won ? "closed" : "closes"} ${day(row.closeOn)}` : null, row.stage].filter(Boolean).join(" · ");
}

function FillEmail({ orgSlug, email }: { orgSlug: string; email: CrmEmailView }) {
  const { state, formProps } = useActionForm(fillCrmEmailAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="counterpartyId" value={email.counterpartyId} />
      <input type="hidden" name="email" value={email.email} />
      <span className="text-sm text-ink-2">
        {email.name}: <span className="font-mono text-xs text-ink">{email.email}</span>
      </span>
      <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…" icon={<Mail aria-hidden />}>
        Use this email
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

/**
 * Bills & receivables' deals from HubSpot (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H11, H12, H13,
 * H20): each won deal with its company, amount and close day, and Plan collections, which opens the New deal form filled
 * in from it; a deal planned already, with its Vestiarion deal and anything HubSpot changed since; the deals not won yet,
 * read-only; and billing emails HubSpot has, for a person to confirm. Nothing is planned, changed or filled until a
 * person does it.
 */
export function HubSpotDeals({
  orgSlug,
  organisation,
  won,
  open,
  emails,
  canWrite,
}: {
  orgSlug: string;
  organisation: string | null;
  won: CrmRowView[];
  open: CrmRowView[];
  emails: CrmEmailView[];
  canWrite: boolean;
}) {
  const changed = won.filter((row) => row.changes.length > 0).length;
  return (
    <section aria-labelledby="from-hubspot-title" id="from-hubspot" className="mb-6 scroll-mt-6">
      <SectionHeader
        id="from-hubspot-title"
        title={won.length === 1 ? "From HubSpot: 1 won deal" : `From HubSpot: ${won.length} won deals`}
        meta={organisation ? `${organisation} · nothing is planned until you plan it` : "Nothing is planned until you plan it"}
      />
      <Card className="space-y-4 p-5">
        {changed > 0 && (
          <p className="text-sm font-medium text-held">
            {changed === 1 ? "1 planned deal changed in HubSpot since." : `${changed} planned deals changed in HubSpot since.`} Nothing in Vestiarion changed: open it to
            change the deal or keep it as it is.
          </p>
        )}
        {won.length === 0 ? (
          <p className="text-sm text-ink-3">No won deals from HubSpot yet. A deal moved to a won stage there comes in at the next sync.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {won.map((row) => (
              <li key={row.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm">
                    <span className="font-semibold text-ink">{row.name}</span>
                    {row.company ? <span className="text-ink-3"> · {row.company}</span> : null}
                  </p>
                  <p className="text-xs text-ink-3">{facts(row, true)}</p>
                  {row.changes.length > 0 && (
                    <div className="space-y-1 pt-1">
                      <Badge size="sm" tone="held" dot>
                        Changed in HubSpot
                      </Badge>
                      <ul className="list-disc space-y-0.5 pl-5 text-xs text-held">
                        {row.changes.map((words) => (
                          <li key={words}>{words}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {row.linkedDeal ? (
                    <>
                      <Badge size="sm" tone={row.linkedDeal.status === "cancelled" ? "neutral" : "proof"}>
                        {row.linkedDeal.status === "cancelled" ? "Planned, cancelled" : "Planned"}
                      </Badge>
                      <Button asChild size="sm" variant="secondary">
                        <Link href={`/o/${orgSlug}/invoices/deals/${row.linkedDeal.id}${row.changes.length > 0 ? "?from=hubspot#change" : ""}`}>
                          Open the deal
                          <ArrowRight aria-hidden />
                        </Link>
                      </Button>
                    </>
                  ) : row.plan.ok ? (
                    canWrite ? (
                      <Button asChild size="sm">
                        <Link href={`/o/${orgSlug}/invoices?hubspot=${row.id}#plan-from-hubspot`}>
                          <Handshake aria-hidden />
                          Plan collections
                        </Link>
                      </Button>
                    ) : (
                      <span className="text-xs text-ink-3">An owner or admin plans it.</span>
                    )
                  ) : (
                    <span className="text-xs text-ink-3">{row.plan.reason}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {open.length > 0 && (
          <Disclosure summary={open.length === 1 ? "Not won yet: 1 deal in HubSpot" : `Not won yet: ${open.length} deals in HubSpot`}>
            <ul className="divide-y divide-line">
              {open.map((row) => (
                <li key={row.id} className="py-2 text-sm">
                  <span className="text-ink">{row.name}</span>
                  {row.company ? <span className="text-ink-3"> · {row.company}</span> : null}
                  <span className="block text-xs text-ink-3">{facts(row, false)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-3">Shown for what is coming. A deal is planned once it is won in HubSpot.</p>
          </Disclosure>
        )}
        {emails.length > 0 && (
          <div className="space-y-2 border-t border-line pt-4">
            <p className="text-sm font-medium text-ink">Billing emails from HubSpot</p>
            <p className="text-xs text-ink-3">These customers have no billing email yet. HubSpot has one for their main contact; use it only if it is where invoices go.</p>
            {canWrite ? (
              emails.map((email) => <FillEmail key={email.counterpartyId} orgSlug={orgSlug} email={email} />)
            ) : (
              <ul className="text-sm text-ink-2">
                {emails.map((email) => (
                  <li key={email.counterpartyId}>
                    {email.name}: {email.email}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}
