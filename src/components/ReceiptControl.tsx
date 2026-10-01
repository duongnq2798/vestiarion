"use client";

import { Link2, Link2Off, ReceiptText } from "lucide-react";
import { useState } from "react";
import { shareReceiptAction, stopSharingReceiptAction, type ReceiptActionResult } from "@/app/actions/receipts";
import { CopyButton } from "@/components/ui/CopyButton";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: ReceiptActionResult = { ok: false, message: "" };

/**
 * A paid payable's receipt, on its card on Invoices (docs/superpowers/specs/2026-10-01-payment-receipts-design.md
 * P6), for an owner or admin. Not shared: one button that shares it. Shared: a new link, which replaces the old
 * one, or stop sharing. A link is shown once, right after it is made, with Copy.
 */
export function ReceiptControl({ orgSlug, invoiceId, shared }: { orgSlug: string; invoiceId: string; shared: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const share = useActionForm(shareReceiptAction, INITIAL, { onResult: (result) => setUrl(result.ok && result.url ? result.url : null) });
  const stop = useActionForm(stopSharingReceiptAction, INITIAL, { onResult: (result) => result.ok && setUrl(null) });
  const error = (!share.state.ok && share.state.message) || (!stop.state.ok && stop.state.message) || null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {shared && (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-3">
            <ReceiptText className="size-3.5" aria-hidden />
            Receipt shared
          </span>
        )}
        <form {...share.formProps}>
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <SubmitButton variant="secondary" size="sm" icon={<Link2 />} pendingLabel={shared ? "Making a link…" : "Sharing…"}>
            {shared ? "New link" : "Share receipt"}
          </SubmitButton>
        </form>
        {shared && (
          <form {...stop.formProps}>
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <input type="hidden" name="invoiceId" value={invoiceId} />
            <SubmitButton variant="ghost" size="sm" icon={<Link2Off />} pendingLabel="Stopping…">
              Stop sharing
            </SubmitButton>
          </form>
        )}
      </div>
      {url && (
        <div className="space-y-1.5 rounded-lg border border-line bg-surface p-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <input readOnly value={url} aria-label="Receipt link" className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink outline-none" onFocus={(event) => event.currentTarget.select()} />
            <CopyButton value={url} size="sm" variant="secondary" />
          </div>
          <p className="text-xs text-ink-3">
            {share.state.message} Anyone with this link sees the amount, the payee&apos;s address and the transactions, and can check them. It shows no names.
          </p>
        </div>
      )}
      {error && <FormMessage tone="error">{error}</FormMessage>}
    </div>
  );
}
