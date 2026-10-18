"use client";

import { ArrowRight, Rocket } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { startLiveSliceAction, type LiveSliceActionResult } from "@/app/actions/live-slice";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { SliceAddress, SliceVendor } from "@/lib/live-slice";

/**
 * Start the live slice, under the report's Before a live slice (docs/superpowers/specs/2026-10-18-live-slice-design.md
 * L1-L3): an owner ticks the vendors to pay for real and opens a workspace on Arc mainnet with them. Each says how its
 * address goes over: its own, confirmed again there; a mirror or none, and it adds its own there. A vendor with no payment
 * limit cannot go. Nothing here moves money: the new workspace goes live from its own Settings.
 */

const INITIAL: LiveSliceActionResult = { ok: false, message: "" };

const ADDRESS: Record<SliceAddress, { label: string; tone: "proof" | "neutral" }> = {
  own: { label: "Its own address, confirmed again there", tone: "proof" },
  mirror: { label: "Mirror address: it adds its own there", tone: "neutral" },
  none: { label: "No address yet: it adds its own there", tone: "neutral" },
};

export function LiveSliceStart({ orgSlug, vendors, canStart }: { orgSlug: string; vendors: SliceVendor[]; canStart: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const start = useActionForm(startLiveSliceAction, INITIAL, { onResult: (result) => setUrl(result.ok && result.url ? result.url : null) });

  return (
    <section aria-labelledby="live-slice-start" className="space-y-3">
      <h3 id="live-slice-start" className="text-base font-semibold text-ink">
        Start the live slice
      </h3>
      <p className="text-sm text-ink-2">
        Choose the vendors to pay in real USDC. Vestiarion opens a workspace on Arc mainnet for you with them: name, payment limit, notice email and
        purchase orders. It carries no bill and moves no money, and this workspace keeps running alongside it. Pay in USDC only where that is lawful
        for your business, and with a vendor that accepts USDC on Arc.
      </p>
      {url ? (
        <Card className="space-y-2 p-4">
          <p className="text-sm text-ink">{start.state.message}</p>
          <Button asChild size="sm">
            <Link href={url}>
              Open its Settings to go live
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        </Card>
      ) : !canStart ? (
        <p className="text-xs text-ink-3">An owner can start the live slice.</p>
      ) : vendors.length === 0 ? (
        <p className="text-xs text-ink-3">Add a vendor on Counterparties first.</p>
      ) : (
        <form {...start.formProps} className="space-y-3">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <Card className="overflow-hidden">
            <ul aria-label="Vendors to pay for real" className="divide-y divide-line">
              {vendors.map((vendor) => {
                const id = `slice-vendor-${vendor.id}`;
                const blocked = vendor.paymentLimit === null;
                return (
                  <li key={vendor.id} className="flex items-start gap-3 px-4 py-3">
                    <input id={id} type="checkbox" name="vendorId" value={vendor.id} disabled={blocked} className="mt-1 size-4 accent-agent" />
                    <label htmlFor={id} className="min-w-0 flex-1 space-y-1">
                      <span className="block text-sm font-medium text-ink">{vendor.name}</span>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                        {blocked ? (
                          "No payment limit: set one on Counterparties to carry it"
                        ) : (
                          <>
                            <span className="tabular-nums">Limit {vendor.paymentLimit} USDC</span>
                            <Badge tone={ADDRESS[vendor.address].tone} size="sm">
                              {ADDRESS[vendor.address].label}
                            </Badge>
                          </>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </Card>
          <SubmitButton icon={<Rocket />} pendingLabel="Opening the live slice…">
            Open the live slice on Arc mainnet
          </SubmitButton>
          <FormMessage tone="error" className="min-h-0">
            {!start.state.ok && start.state.message ? start.state.message : null}
          </FormMessage>
        </form>
      )}
    </section>
  );
}
