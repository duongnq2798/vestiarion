"use client";

import { Landmark } from "lucide-react";
import { enableUsycReserveAction, type UsycReserveActionResult } from "@/app/actions/treasury";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { Money } from "@/components/vx/Primitives";
import { utcMinute } from "@/lib/copy";
import type { UsycReserveStatus } from "@/lib/platform/usyc-reserve";

const INITIAL: UsycReserveActionResult = { ok: false, message: "" };

/**
 * The "USYC reserve" section of Settings (docs/superpowers/specs/2026-10-02-usyc-live-design.md §4).
 * Off: what the reserve is, the two addresses Circle allowlists, and, for an owner or admin, Turn on,
 * which checks the allowlist on chain first. On: since when, and what the reserve holds.
 */
export function UsycReservePanel({ orgSlug, status, canManage }: { orgSlug: string; status: UsycReserveStatus; canManage: boolean }) {
  return (
    <Card asChild className="overflow-hidden">
      <section aria-labelledby="usyc-reserve-title">
        <div className="space-y-3 px-4 py-4 sm:px-5">
          <SectionHeader
            id="usyc-reserve-title"
            title="USYC reserve"
            meta="idle cash earning in a tokenized money market fund"
            action={status.liveAt ? <Badge tone="proof" dot>Live</Badge> : <Badge tone="simulated">Simulated</Badge>}
          />
          {status.liveAt ? (
            <>
              <p className="text-sm leading-6 text-ink-2">
                On since {utcMinute(status.liveAt)}. The agent sweeps idle USDC into USYC, Circle&apos;s tokenized money market fund on Arc testnet, and redeems it
                before payments fall due. The reserve wallet holds the USYC.
              </p>
              <p className="text-sm text-ink">
                The reserve is worth <Money value={status.reserveBalance} /> at USYC&apos;s latest price.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm leading-6 text-ink-2">
                The agent already decides when idle cash should earn and when to bring it back before payments fall due; until this is on, the reserve it moves
                cash into is simulated. Turned on, it buys real USYC, Circle&apos;s tokenized money market fund, on Arc testnet.
              </p>
              <p className="text-sm leading-6 text-ink-2">
                USYC is permissioned: Circle allowlists the wallets that may hold it. Ask Circle Support to allowlist these two addresses for USYC on Arc testnet,
                then turn it on here.
              </p>
              <AddressRow label="Operating wallet, which buys USYC" address={status.operatingAddress} />
              <AddressRow label="Reserve wallet, which holds and sells it" address={status.reserveAddress} />
            </>
          )}
        </div>
        {!status.liveAt && canManage && status.mode === "live" && <EnableForm orgSlug={orgSlug} />}
        {!status.liveAt && status.mode !== "live" && (
          <p className="border-t border-line px-4 py-3 text-xs text-ink-3 sm:px-5">Available once the workspace is live on Arc testnet.</p>
        )}
      </section>
    </Card>
  );
}

function AddressRow({ label, address }: { label: string; address: string | null }) {
  return (
    <div className="grid gap-1">
      <p className="text-xs text-ink-3">{label}</p>
      {address ? (
        <p className="flex items-center gap-2">
          <code className="min-w-0 font-mono text-xs text-ink [overflow-wrap:anywhere]">{address}</code>
          <CopyButton value={address} label="Copy address" />
        </p>
      ) : (
        <p className="text-xs text-ink-2">No wallet yet. Create the treasury wallets under Go live first.</p>
      )}
    </div>
  );
}

function EnableForm({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(enableUsycReserveAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="space-y-3 border-t border-line px-4 py-4 sm:px-5">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <p className="text-xs text-ink-3">Turning it on checks the allowlist on Arc testnet first. It cannot be turned off from here.</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
        <SubmitButton icon={<Landmark />} pendingLabel="Checking…">
          Turn on
        </SubmitButton>
      </div>
    </form>
  );
}
