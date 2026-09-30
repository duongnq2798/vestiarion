"use client";

import { RotateCw } from "lucide-react";
import { rotateLedgerKeyAction, type LedgerKeyActionResult } from "@/app/actions/ledger-key";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { useActionForm } from "@/components/ui/useActionForm";
import { LEDGER_KEY_MESSAGES, utcMinute } from "@/lib/copy";
import type { ledgerKeyStatus } from "@/lib/platform/ledger-key";

/**
 * The "Ledger signing key" section of Settings
 * (docs/superpowers/specs/2026-09-30-ledger-key-rotation-design.md §1).
 *
 * Everyone sees the current key and what has been retired; an owner
 * (`canAdminister`) can rotate it, behind a confirmation that says what
 * changes, unless the current key cannot be read. `status` carries ids and
 * timestamps only — never key material.
 */
export interface LedgerKeyPanelProps {
  orgSlug: string;
  status: Awaited<ReturnType<typeof ledgerKeyStatus>>;
  canAdminister: boolean;
}

const INITIAL: LedgerKeyActionResult = { ok: false, message: "" };
const FORM_ID = "rotate-ledger-key";

const CONFIRM_DESCRIPTION =
  "New entries are signed by a new key. Entries already written keep verifying with the old public key, which stays listed here. The old private key is discarded and cannot sign again.";

function RetiredKeys({ retired }: { retired: LedgerKeyPanelProps["status"]["retired"] }) {
  if (retired.length === 0) {
    return <p className="text-sm text-ink-2">No key has been retired yet.</p>;
  }
  return (
    <ul className="space-y-1">
      {retired.map((key) => (
        <li key={key.id} className="font-mono text-xs text-ink-2">
          {key.id} · retired {key.retiredAt ? utcMinute(key.retiredAt) : "before this workspace kept its own keys"}
        </li>
      ))}
    </ul>
  );
}

function RotateForm({ orgSlug }: { orgSlug: string }) {
  const { state, pending, formProps } = useActionForm(rotateLedgerKeyAction, INITIAL, { toastOnSuccess: true });
  return (
    <form id={FORM_ID} {...formProps} className="space-y-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <ConfirmDialog
        formId={FORM_ID}
        tone="danger"
        trigger={
          <Button variant="danger" icon={<RotateCw />} loading={pending}>
            Rotate signing key
          </Button>
        }
        title="Rotate the ledger signing key?"
        description={CONFIRM_DESCRIPTION}
        confirmLabel="Rotate key"
      />
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

export default function LedgerKeyPanel({ orgSlug, status, canAdminister }: LedgerKeyPanelProps) {
  return (
    <section aria-labelledby="ledger-key-title">
      <SectionHeader id="ledger-key-title" title="Ledger signing key" />
      <Card className="space-y-4 p-5">
        <div className="space-y-1">
          <p className="text-sm font-medium text-ink">Current key</p>
          <p className="font-mono text-xs text-ink-2">{status.current ?? "—"}</p>
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-ink">Retired keys</p>
          <RetiredKeys retired={status.retired} />
        </div>
        <div className="border-t border-line pt-4">
          {status.current === null ? (
            // A key that cannot be opened cannot be retired, for anyone: say so, rather than offer a form that refuses.
            <p className="text-sm text-ink-2">{LEDGER_KEY_MESSAGES.key_unreadable}</p>
          ) : canAdminister ? (
            <RotateForm orgSlug={orgSlug} />
          ) : (
            <p className="text-sm text-ink-2">An owner of this workspace can rotate the key.</p>
          )}
        </div>
      </Card>
    </section>
  );
}
