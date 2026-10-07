"use client";

import { Wallet } from "lucide-react";
import { giveMirrorAddressAction } from "@/app/actions/mirror-address";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";

/**
 * A mirror address for a payee with no Arc address, in shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-
 * design.md S7), on its row in Counterparties: a wallet Vestiarion makes for it on Arc testnet, where the payments a
 * person agrees to are made. Shown only where the page offers it: shadow mode on, a payee with no address, and someone
 * who may add records.
 */

const INITIAL: ActionResult = { ok: false, message: "" };
const give = withSuccessToast(giveMirrorAddressAction);

export default function MirrorAddressControl({ orgSlug, counterparty }: { orgSlug: string; counterparty: { id: string; name: string } }) {
  const { state, formProps, pending } = useActionForm(give, INITIAL);
  return (
    <form {...formProps} className="space-y-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="counterpartyId" value={counterparty.id} />
      <p className="text-xs text-ink-3">
        In shadow mode, a payee with no Arc address can be paid at a mirror address: a wallet Vestiarion makes for it on Arc testnet.
      </p>
      <SubmitButton size="sm" variant="secondary" icon={<Wallet />} pendingLabel="Making it…" disabled={pending} aria-label={`Give ${counterparty.name} a mirror address`}>
        Give it a mirror address
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}
