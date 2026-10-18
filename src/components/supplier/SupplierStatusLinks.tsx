"use client";

import { Link2, Link2Off } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { shareSupplierStatusAction, stopSupplierStatusAction, type SupplierStatusActionResult } from "@/app/actions/supplier-status";
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
import type { SupplierLinkView } from "@/lib/supplier-status/model";

/**
 * A supplier's payment status link, made and stopped from the Bills tab
 * (docs/superpowers/specs/2026-10-18-supplier-status-design.md V1, V6). An owner or admin picks a vendor or contractor
 * and how long the link works, and gets the link once, to copy; every member sees which suppliers have a live link and
 * until when, and an owner or admin stops one. A new link for a supplier stops the one it had. Before migration 0131
 * runs, it says supplier payment status is not set up.
 */

const INITIAL: SupplierStatusActionResult = { ok: false, message: "" };
const DAYS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

export function SupplierStatusLinks({
  orgSlug,
  suppliers,
  links,
  canWrite,
  available,
}: {
  orgSlug: string;
  suppliers: Array<{ id: string; name: string }>;
  links: SupplierLinkView[];
  canWrite: boolean;
  available: boolean;
}) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const share = useActionForm(shareSupplierStatusAction, INITIAL, {
    onResult: (result) => {
      setUrl(result.ok && result.url ? result.url : null);
      if (result.ok) router.refresh();
    },
  });
  const formId = useId();

  return (
    <section id="supplier-status" aria-labelledby="supplier-status-title" className="scroll-mt-6 space-y-3">
      <SectionHeader id="supplier-status-title" title="Supplier payment status" meta={available ? `${links.filter((link) => !link.expired).length} live` : undefined} />
      <p className="text-sm text-ink-2">
        Send a supplier a link to its own bills: where each one stands (received, being reviewed, set for a day, on its way) and what was paid, with each
        payment&rsquo;s transaction. No account needed. It never says why a bill is held, and shows nothing of your other suppliers or your cash.
      </p>
      {!available ? (
        <p className="text-xs text-ink-3">Supplier payment status is not set up on this deployment yet.</p>
      ) : (
        <>
          {canWrite ? (
            suppliers.length === 0 ? (
              <p className="text-xs text-ink-3">Add a counterparty with the role vendor or contractor to share its payment status.</p>
            ) : (
              <form {...share.formProps} className="grid gap-3 rounded-2xl border border-line bg-surface p-4 shadow-surface sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
                <input type="hidden" name="orgSlug" value={orgSlug} />
                <Field id={`${formId}-supplier`} label="Supplier">
                  <Select name="counterpartyId" required>
                    <SelectTrigger id={`${formId}-supplier`}>
                      <SelectValue placeholder="Select a supplier" />
                    </SelectTrigger>
                    <SelectContent>
                      {suppliers.map((supplier) => (
                        <SelectItem key={supplier.id} value={supplier.id}>
                          {supplier.name}
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
            <p className="text-xs text-ink-3">An owner or admin can share a supplier&rsquo;s payment status.</p>
          )}
          {url && (
            <div className="w-full min-w-0 space-y-1.5 rounded-lg border border-proof-line bg-proof-soft/60 p-2.5">
              <div className="flex w-full min-w-0 items-center gap-2">
                <Input readOnly value={url} aria-label="Payment status link" className="min-w-0 flex-1 font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
                <CopyButton value={url} size="sm" variant="secondary" label="Copy the payment status link" />
              </div>
              <p className="text-xs leading-5 text-ink-2">{share.state.message}</p>
            </div>
          )}
          {links.length > 0 && (
            <Card className="overflow-hidden">
              <ul aria-label="Payment status links" className="divide-y divide-line">
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

function LinkRow({ orgSlug, link, canStop }: { orgSlug: string; link: SupplierLinkView; canStop: boolean }) {
  const router = useRouter();
  const stop = useActionForm(stopSupplierStatusAction, INITIAL, { toastOnSuccess: true, onSuccess: () => router.refresh() });
  const describedBy = useId();
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div id={describedBy} className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
          {link.supplierName}
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
