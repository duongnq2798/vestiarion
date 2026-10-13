"use client";

import { Link2, Link2Off } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { shareCustomerStatementAction, stopCustomerStatementAction, type CustomerPortalActionResult } from "@/app/actions/customer-portal";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

/**
 * A customer's statement link, made and stopped from the Receivables tab (docs/superpowers/specs/2026-10-13-customer-
 * portal-design.md P2, P9). An owner or admin picks a customer and how long the link works, and gets the link once, to
 * copy; every member sees which customers have a live link and until when, and an owner or admin stops one. A new link
 * for a customer stops the one it had. Before migration 0109 runs, it says statements are not set up.
 */

export interface StatementLinkRow {
  id: string;
  customerName: string;
  /** "Works until Nov 12, 2026" or "Expired Oct 1, 2026". */
  until: string;
  expired: boolean;
  /** "Made by ana@example.com on Oct 13, 2026". */
  made: string;
}

const INITIAL: CustomerPortalActionResult = { ok: false, message: "" };
const DAYS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

export function StatementLinks({
  orgSlug,
  customers,
  links,
  canWrite,
  available,
}: {
  orgSlug: string;
  customers: Array<{ id: string; name: string }>;
  links: StatementLinkRow[];
  canWrite: boolean;
  available: boolean;
}) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const share = useActionForm(shareCustomerStatementAction, INITIAL, {
    onResult: (result) => {
      setUrl(result.ok && result.url ? result.url : null);
      if (result.ok) router.refresh();
    },
  });
  const formId = useId();

  return (
    <section id="customer-statements" aria-labelledby="customer-statements-title" className="scroll-mt-6 space-y-3">
      <SectionHeader id="customer-statements-title" title="Customer statements" meta={available ? `${links.filter((link) => !link.expired).length} live` : undefined} />
      <p className="text-sm text-ink-2">
        Send a customer a link to its own statement: its open invoices, what it still owes, and a way to pay each one, say it paid, promise a day or
        dispute one. No account or wallet needed. It shows nothing of your other customers or your books.
      </p>
      {!available ? (
        <p className="text-xs text-ink-3">Customer statements are not set up on this deployment yet.</p>
      ) : (
        <>
          {canWrite ? (
            customers.length === 0 ? (
              <p className="text-xs text-ink-3">Add a counterparty with the role client to share a statement with it.</p>
            ) : (
              <form {...share.formProps} className="grid gap-3 rounded-2xl border border-line bg-surface p-4 shadow-surface sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
                <input type="hidden" name="orgSlug" value={orgSlug} />
                <Field id={`${formId}-customer`} label="Customer">
                  <Select name="counterpartyId" required>
                    <SelectTrigger id={`${formId}-customer`}>
                      <SelectValue placeholder="Select a customer" />
                    </SelectTrigger>
                    <SelectContent>
                      {customers.map((customer) => (
                        <SelectItem key={customer.id} value={customer.id}>
                          {customer.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field id={`${formId}-days`} label="Link works for">
                  <Select name="days" defaultValue="30">
                    <SelectTrigger id={`${formId}-days`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DAYS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <SubmitButton icon={<Link2 />} pendingLabel="Making the link…">
                  Make a link
                </SubmitButton>
                <FormMessage tone="error" className="min-h-0 sm:col-span-3">
                  {!share.state.ok && share.state.message ? share.state.message : null}
                </FormMessage>
              </form>
            )
          ) : (
            <p className="text-xs text-ink-3">An owner or admin can share a statement with a customer.</p>
          )}
          {url && (
            <div className="w-full min-w-0 space-y-1.5 rounded-lg border border-proof-line bg-proof-soft/60 p-2.5">
              <div className="flex w-full min-w-0 items-center gap-2">
                <Input readOnly value={url} aria-label="Statement link" className="min-w-0 flex-1 font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
                <CopyButton value={url} size="sm" variant="secondary" label="Copy the statement link" />
              </div>
              <p className="text-xs leading-5 text-ink-2">{share.state.message}</p>
            </div>
          )}
          {links.length > 0 && (
            <Card className="overflow-hidden">
              <ul aria-label="Statement links" className="divide-y divide-line">
                {links.map((link) => (
                  <LinkRow key={link.id} orgSlug={orgSlug} link={link} canStop={canWrite} />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </section>
  );
}

function LinkRow({ orgSlug, link, canStop }: { orgSlug: string; link: StatementLinkRow; canStop: boolean }) {
  const router = useRouter();
  const stop = useActionForm(stopCustomerStatementAction, INITIAL, { toastOnSuccess: true, onSuccess: () => router.refresh() });
  const describedBy = useId();
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div id={describedBy} className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
          {link.customerName}
          {link.expired && (
            <Badge tone="neutral" size="sm">
              Expired
            </Badge>
          )}
        </p>
        <p className="text-xs text-ink-3">
          {link.until} · {link.made}
        </p>
        {!stop.state.ok && stop.state.message && <FormMessage tone="error">{stop.state.message}</FormMessage>}
      </div>
      {canStop && (
        <form {...stop.formProps} className="shrink-0">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="linkId" value={link.id} />
          <SubmitButton size="sm" variant="ghost" icon={<Link2Off />} pendingLabel="Stopping…" aria-describedby={describedBy}>
            Stop the link
          </SubmitButton>
        </form>
      )}
    </li>
  );
}
