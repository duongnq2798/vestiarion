"use client";

import { Link2 } from "lucide-react";
import { useState } from "react";
import { createPayLinkAction, type PayLinkActionResult } from "@/app/actions/pay-links";
import { CopyButton } from "@/components/ui/CopyButton";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: PayLinkActionResult = { ok: false, message: "" };

/**
 * An open receivable's pay link (docs/superpowers/specs/2026-10-01-receivables-on-arc-design.md §2):
 * made on request and shown this once to copy; making it again replaces it. Once the client pays the
 * exact amount on Arc testnet, the agent matches the transfer and the receivable is received.
 */
export function PayLinkControl({ orgSlug, invoiceId }: { orgSlug: string; invoiceId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const { state, formProps } = useActionForm(createPayLinkAction, INITIAL, { onResult: (result) => setUrl(result.ok && result.url ? result.url : null) });

  return (
    <div className="grid gap-2">
      <form {...formProps} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <SubmitButton variant="secondary" size="sm" icon={<Link2 />} pendingLabel="Making a link…">
          {url ? "Make a new link" : "Get paid on Arc"}
        </SubmitButton>
        {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
      </form>
      {url && (
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <Input readOnly value={url} aria-label="Pay link" className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
            <CopyButton value={url} label="Copy link" variant="secondary">
              Copy link
            </CopyButton>
          </div>
          <p className="text-xs text-ink-3">
            Send it to your client. They pay the exact amount on Arc testnet, and the agent matches it to this invoice. Shown only now; a new link replaces this one.
          </p>
        </div>
      )}
    </div>
  );
}
