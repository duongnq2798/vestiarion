"use client";

import { ArrowDownToLine } from "lucide-react";
import { useState } from "react";
import { fundGatewayAction, type FundGatewayResult } from "@/app/actions/treasury";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { Hash } from "@/components/vx/Primitives";

const INITIAL: FundGatewayResult = { ok: false, message: "" };

/**
 * The workspace's Gateway balance on the Treasury page (Gateway payouts G1,
 * G5): what Circle Gateway holds for it, the signer that spends it, and for
 * an owner or admin the form that moves USDC into it from the operating
 * wallet. The form carries an id made when it was shown, so a double click
 * deposits once; a new id is made after each deposit.
 */
export function GatewayPanel({
  orgSlug,
  signerAddress,
  balanceUsdc,
  canFund,
}: {
  orgSlug: string;
  signerAddress: string | null;
  balanceUsdc: number | null;
  canFund: boolean;
}) {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const { state, formProps } = useActionForm(fundGatewayAction, INITIAL, {
    resetOnSuccess: true,
    toastOnSuccess: true,
    onSuccess: () => setRequestId(crypto.randomUUID()),
  });

  return (
    <Card asChild className="overflow-hidden">
      <section>
        <div className="space-y-3 px-4 py-4 sm:px-5">
          <SectionHeader title="Gateway balance" meta="Circle Gateway" />
          <p className="font-mono text-[0.9375rem] tabular-nums text-ink">
            {signerAddress === null ? "Not funded yet." : balanceUsdc === null ? "—" : `${balanceUsdc} USDC`}
          </p>
          {signerAddress !== null && balanceUsdc === null && <p className="text-xs text-ink-3">Gateway did not answer just now.</p>}
          <p className="text-sm leading-6 text-ink-2">
            A USDC balance Circle Gateway holds for this workspace, spent on another chain at once. A payout to a payee on Base, Arbitrum or Ethereum Sepolia comes from it when it covers the payout and Gateway&apos;s fee is no higher than CCTP&apos;s; otherwise it goes through CCTP.
          </p>
          {signerAddress !== null && (
            <p className="flex items-center gap-2 text-xs text-ink-3">
              Signer <Hash value={signerAddress} />
            </p>
          )}
        </div>
        {canFund && (
          <form {...formProps} className="space-y-3 border-t border-line px-4 py-4 sm:px-5">
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <input type="hidden" name="requestId" value={requestId} />
            <Field id="gateway-amount" label="Amount to move from the operating wallet (USDC)">
              <Input name="amount" required inputMode="decimal" placeholder="5" />
            </Field>
            <p className="text-xs text-ink-3">USDC moved into Gateway stays there until it is paid out; it cannot be moved back from here.</p>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
              <SubmitButton icon={<ArrowDownToLine />} pendingLabel="Depositing…" className="shrink-0">
                Fund Gateway
              </SubmitButton>
            </div>
          </form>
        )}
      </section>
    </Card>
  );
}
