"use client";

import { Check, GitBranch } from "lucide-react";
import Link from "next/link";
import { keepCrmChangeAction, type HubSpotActionResult } from "@/app/actions/hubspot";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: HubSpotActionResult = { ok: false, message: "" };

/**
 * A deal's "Changed in HubSpot" (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H12): what the CRM
 * changed since the deal was planned from it, in words. Nothing changed in Vestiarion: Change deal opens filled in from
 * it, for a person to save as a new version; Keep the deal as it is marks the changes as seen. A won deal marked lost is
 * flagged, never cancelled here.
 */
export function CrmDealChanges({
  orgSlug,
  dealId,
  label,
  words,
  seen,
  canWrite,
  active,
  from = "hubspot",
}: {
  orgSlug: string;
  dealId: string;
  label: string;
  /** The CRM, for the address Change deal opens with (`?from=<provider>`, Pipedrive connector P10). */
  from?: "hubspot" | "pipedrive" | "zohocrm";
  words: string[];
  /** The key of the changes shown: Keep the deal as it is keeps these alone. */
  seen: string;
  canWrite: boolean;
  active: boolean;
}) {
  const { state, formProps } = useActionForm(keepCrmChangeAction, INITIAL, { toastOnSuccess: true });
  return (
    <Callout tone="held" title={`Changed in ${label}`}>
      <ul className="list-disc space-y-1 pl-5">
        {words.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-2">Nothing in Vestiarion changed. Save a new version of the deal, or keep it as it is.</p>
      {canWrite && active ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button asChild size="sm">
            <Link href={`/o/${orgSlug}/invoices/deals/${dealId}?from=${from}#change`}>
              <GitBranch aria-hidden />
              Change deal
            </Link>
          </Button>
          <form {...formProps} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <input type="hidden" name="dealId" value={dealId} />
            <input type="hidden" name="seen" value={seen} />
            <SubmitButton size="sm" variant="secondary" pendingLabel="Saving…" icon={<Check aria-hidden />}>
              Keep the deal as it is
            </SubmitButton>
            <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
          </form>
        </div>
      ) : !canWrite ? (
        <p className="mt-2 text-ink-3">An owner or admin changes the deal or keeps it.</p>
      ) : null}
    </Callout>
  );
}
