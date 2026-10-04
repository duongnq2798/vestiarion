"use client";

import { LockKeyhole } from "lucide-react";
import { setUpEscrowAction, type EscrowActionResult } from "@/app/actions/escrow";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { Hash } from "@/components/vx/Primitives";
import { arcAddressUrl } from "@/lib/payee-chains";

const INITIAL: EscrowActionResult = { ok: false, message: "" };

/**
 * The workspace's milestone escrow on Contractors (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md
 * E2, E6): what it is, its contract once deployed, and for an owner or admin the button that sets it up, or
 * finishes a setup that was interrupted.
 */
export function EscrowPanel({
  orgSlug,
  address,
  deploying,
  canSetUp,
  bare = false,
}: {
  orgSlug: string;
  address: string | null;
  deploying: boolean;
  canSetUp: boolean;
  /** Inside a section that already names it (Contractors folds it): no card, no heading. */
  bare?: boolean;
}) {
  const { state, formProps } = useActionForm(setUpEscrowAction, INITIAL, { toastOnSuccess: true });

  const content = (
    <>
      <p className="text-sm leading-6 text-ink-2">
        Lock a milestone&apos;s USDC before the work starts. Once the milestone is verified, the agent releases it to the contractor, under the same
        checks as any payment; from a refund date you set, it can come back to this workspace instead. Before that date it can go nowhere else. Only this
        workspace&apos;s operating wallet can call the contract, which was written for Vestiarion and is not audited.
      </p>
      {address ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          Contract <Hash value={address} href={arcAddressUrl(address)} />
        </p>
      ) : deploying ? (
        <p className="text-sm text-ink-2">A setup was started and has not finished.</p>
      ) : null}
      {canSetUp && !address && (
        <form {...formProps} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
          <SubmitButton icon={<LockKeyhole />} pendingLabel="Setting up…" className="shrink-0">
            {deploying ? "Finish setting up" : "Set up escrow"}
          </SubmitButton>
        </form>
      )}
    </>
  );
  if (bare) return <div className="space-y-3">{content}</div>;
  return (
    <Card className="space-y-3 p-4 sm:p-6">
      <SectionHeader title="Milestone escrow" meta="a contract on Arc testnet" />
      {content}
    </Card>
  );
}
