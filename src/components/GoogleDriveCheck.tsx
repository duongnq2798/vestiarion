"use client";

import { RefreshCw } from "lucide-react";
import { checkGoogleDriveNowAction, type GoogleDriveCheckResult } from "@/app/actions/googledrive";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: GoogleDriveCheckResult = { ok: false, message: "" };

/**
 * Check Google Drive now (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD7, GD16): one read of the
 * workspace's folder, as the 15-minute sweeper's, on the Google Drive card in Settings and in the review list on Bills &
 * receivables, for whoever adds the invoices it finds. Its answer stays beside the button: what it found, or why it did
 * not read. Both places draw it whether or not anything was found, so the answer survives the page's revalidation.
 */
export function GoogleDriveCheck({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(checkGoogleDriveNowAction, INITIAL);
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Checking…" icon={<RefreshCw aria-hidden />}>
        Check Google Drive now
      </SubmitButton>
      {/* The answer names the folder, which may have no place to break. */}
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"} className="min-w-0 [overflow-wrap:anywhere]">
        {state.message || null}
      </FormMessage>
    </form>
  );
}
