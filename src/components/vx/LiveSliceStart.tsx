"use client";

import { ArrowRight, Rocket } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { startLiveSliceAction, type LiveSliceActionResult } from "@/app/actions/live-slice";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { LadderRow } from "@/lib/autonomy-ladder";
import type { SliceAddress, SliceSkipReason, SliceVendor } from "@/lib/live-slice";

/**
 * Start the live slice, under the report's Before a live slice (docs/superpowers/specs/2026-10-18-live-slice-design.md
 * L1-L3): an owner ticks the vendors to pay for real and opens a workspace on Arc mainnet with them. Each says how its
 * address goes over: its own, confirmed again there; any other, and it adds its own there. A vendor with no payment limit
 * cannot go. Once opened, the one who opened it sees what went over and the way to its Settings, until it is live. Nothing
 * here moves money.
 *
 * Each of the workspace's accountants is offered too, ticked: "Bring your accountant along"
 * (docs/superpowers/specs/2026-10-23-accountant-client-links-design.md AC4). The owner unticks any to leave behind.
 *
 * Beside each vendor, how often the owner agreed with the agent's decisions on its bills, from their verdicts, with
 * the count, so they tick the vendors with evidence (docs/superpowers/specs/2026-10-26-autonomy-ladder-design.md
 * AL8).
 */

const INITIAL: LiveSliceActionResult = { ok: false, message: "" };

const ADDRESS: Record<SliceAddress, { label: string; tone: "proof" | "neutral" }> = {
  own: { label: "Its own address, confirmed again there", tone: "proof" },
  mirror: { label: "Mirror address: it adds its own there", tone: "neutral" },
  other_chain: { label: "Paid on another chain: it adds its Arc address there", tone: "neutral" },
  unconfirmed: { label: "Address not confirmed here: it adds its own there", tone: "neutral" },
  none: { label: "No address yet: it adds its own there", tone: "neutral" },
};

const SKIPPED: Record<SliceSkipReason, string> = {
  no_limit: "no payment limit",
  not_valid: "its details need fixing on Counterparties",
  not_added: "it could not be added: add it there",
};

/** The slice opened from here, as its opener sees it until it is live. */
export interface OpenedSlice {
  name: string;
  slug: string;
  vendors: number;
  skipped: Array<{ name: string; reason: SliceSkipReason }>;
}

/** One of the workspace's accountants, offered to bring along (AC4). */
export interface SliceAccountant {
  userId: string;
  email: string;
}

/**
 * A vendor's agreement in words, with its count; no percentage under five verdicts (autonomy ladder AL4, AL8). The
 * agreed count goes with the rate, as in the report's table, since a whole percent can round one Disagree in 200 up to
 * 100%.
 */
function agreementWords(row: LadderRow | undefined): string {
  if (!row) return "No verdicts yet";
  if (row.rate === null) return `${row.given} ${row.given === 1 ? "verdict" : "verdicts"}: too few to tell yet`;
  return `${row.rate}% agreed, ${row.agreed} of ${row.given} verdicts`;
}

export function LiveSliceStart({
  orgSlug,
  vendors,
  canStart,
  opened = null,
  accountants = [],
  agreement,
}: {
  orgSlug: string;
  vendors: SliceVendor[];
  canStart: boolean;
  opened?: OpenedSlice | null;
  accountants?: SliceAccountant[];
  /** The report's agreement by vendor, keyed by counterparty id (AL8); a vendor with none says so. */
  agreement?: LadderRow[];
}) {
  const agreementOf = new Map((agreement ?? []).map((row) => [row.key, row]));
  const [result, setResult] = useState<LiveSliceActionResult | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusOpened = useRef(false);
  const start = useActionForm(startLiveSliceAction, INITIAL, {
    onResult: (state) => {
      setResult(state);
      if (state.ok) focusOpened.current = true;
    },
  });
  const done = opened !== null || result?.ok === true;
  // The form goes once the slice is open: keyboard focus moves to what replaced it rather than to the page.
  useEffect(() => {
    if (done && focusOpened.current) {
      focusOpened.current = false;
      heading.current?.focus();
    }
  }, [done]);

  if (done) {
    const settings = opened ? `/o/${opened.slug}/settings` : (result?.url ?? null);
    return (
      <section aria-labelledby="live-slice-opened" className="space-y-3">
        <h3 id="live-slice-opened" ref={heading} tabIndex={-1} className="text-base font-semibold text-ink outline-none">
          {opened ? `Opened ${opened.name} on Arc mainnet` : "Opened on Arc mainnet"}
        </h3>
        <Card className="space-y-2 p-4">
          {opened ? (
            <p className="text-sm text-ink">
              {opened.vendors} {opened.vendors === 1 ? "vendor" : "vendors"} went over. It is not live yet: take it live from its Settings with your own or a
              passkey wallet, its spending limit and USDC, then add the bills to pay for real there. On its Counterparties, Ask every payee for an address
              sends each vendor with no address its own link.
            </p>
          ) : (
            <p className="text-sm text-ink">{result?.message}</p>
          )}
          {opened && opened.skipped.length > 0 && (
            <p className="text-xs text-ink-3">Stayed here: {opened.skipped.map((vendor) => `${vendor.name} (${SKIPPED[vendor.reason]})`).join(", ")}.</p>
          )}
          {settings && (
            <Button asChild size="sm">
              <Link href={settings}>
                Open its Settings to go live
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          )}
        </Card>
      </section>
    );
  }

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
      {!canStart ? (
        <p className="text-xs text-ink-3">An owner can start the live slice.</p>
      ) : vendors.length === 0 ? (
        <p className="text-xs text-ink-3">Add a vendor on Counterparties first.</p>
      ) : (
        <form {...start.formProps} className="space-y-3">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          {agreement && (
            <p className="text-xs text-ink-3">{"Beside each vendor: how often you agreed with the agent's decisions on its bills, from your verdicts in shadow mode."}</p>
          )}
          <Card className="overflow-hidden">
            <ul aria-label="Vendors to pay for real" className="divide-y divide-line">
              {vendors.map((vendor) => (
                <li key={vendor.id} className="px-4 py-3">
                  <Checkbox
                    id={`slice-vendor-${vendor.id}`}
                    name="vendorId"
                    value={vendor.id}
                    disabled={vendor.paymentLimit === null}
                    label={<span className="font-medium">{vendor.name}</span>}
                    description={
                      <span className="flex flex-wrap items-center gap-2">
                        {vendor.paymentLimit === null ? (
                          "No payment limit: set one on Counterparties to carry it"
                        ) : (
                          <>
                            <span className="tabular-nums">Limit {vendor.paymentLimit} USDC</span>
                            <Badge tone={ADDRESS[vendor.address].tone} size="sm">
                              {ADDRESS[vendor.address].label}
                            </Badge>
                          </>
                        )}
                        {agreement && <span className="tabular-nums">{agreementWords(agreementOf.get(vendor.id))}</span>}
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          </Card>
          {accountants.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium text-ink">Your accountant</legend>
              {accountants.map((accountant) => (
                <Checkbox
                  key={accountant.userId}
                  id={`slice-accountant-${accountant.userId}`}
                  name="accountantId"
                  value={accountant.userId}
                  defaultChecked
                  label={`Bring your accountant ${accountant.email} along`}
                  description="They join the new workspace as its accountant. You can remove them from its Members at any time."
                />
              ))}
            </fieldset>
          )}
          <SubmitButton icon={<Rocket />} pendingLabel="Opening the live slice…">
            Open the live slice on Arc mainnet
          </SubmitButton>
          <FormMessage tone="error" className="min-h-0">
            {!start.state.ok && start.state.message ? start.state.message : null}
          </FormMessage>
          {!start.state.ok && start.state.url && (
            <Link href={start.state.url} className="text-sm font-medium text-agent underline-offset-2 hover:underline">
              Open the workspace that was opened
            </Link>
          )}
        </form>
      )}
    </section>
  );
}
