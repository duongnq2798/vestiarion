"use client";

import { FileSpreadsheet, Link2, Unplug } from "lucide-react";
import Link from "next/link";
import { disconnectGoogleSheetsAction, type GoogleSheetsActionResult } from "@/app/actions/googlesheets";
import { DocsLink } from "@/components/DocsLink";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { orgHref } from "@/lib/auth/org-paths";
import type { GoogleSheetsPanelView } from "@/lib/googlesheets/views";

const INITIAL: GoogleSheetsActionResult = { ok: false, message: "" };

/** What Google Sheets' way back from connecting says, by the code it carries in `?googlesheets=` (close pack Sheets GS3, GS4). */
export const GOOGLE_SHEETS_NOTICES: Record<string, { tone: "success" | "error"; text: string }> = {
  connected: { tone: "success", text: "Google Sheets is connected. Export a month from Monthly close pack in the Audit log." },
  cancelled: { tone: "error", text: "Connecting Google Sheets was cancelled. Nothing changed." },
  forbidden: { tone: "error", text: "Only an owner or admin connects Google Sheets, from their own browser." },
  other_organisation: { tone: "error", text: "This workspace is connected to another Google account. Disconnect it first, then connect the one you want." },
  scopes: { tone: "error", text: "Google did not give access to Drive files, so nothing was connected. Connect again and leave the Google Drive box ticked." },
  not_set_up: { tone: "error", text: "Google Sheets is not set up on this deployment yet." },
  failed: { tone: "error", text: "Google Sheets did not finish connecting. Try again in a moment." },
};

type DisconnectForm = ReturnType<typeof useActionForm<GoogleSheetsActionResult>>;

/**
 * The Disconnect button. Its form's state lives in `GoogleSheetsPanel`: the action revalidates the page, whose card turns
 * Disconnected and drops this button in the same render as the answer, so the answer is shown by the panel, which stays
 * mounted (the revalidate unmount pattern).
 */
function Disconnect({ orgSlug, form }: { orgSlug: string; form: DisconnectForm }) {
  return (
    <form {...form.formProps}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Disconnecting…" icon={<Unplug aria-hidden />}>
        Disconnect Google Sheets
      </SubmitButton>
    </form>
  );
}

function ConnectButton({ orgSlug, label }: { orgSlug: string; label: string }) {
  return (
    <Button asChild size="sm">
      <Link href={`/integrations/googlesheets/connect?org=${orgSlug}`}>
        <Link2 aria-hidden />
        {label}
      </Link>
    </Button>
  );
}

const LINK = "font-medium text-agent underline-offset-4 hover:underline";

/**
 * The Google Sheets section of Settings (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS2, GS4,
 * GS6, GS14, GS18, "Settings > Integrations: the Google Sheets card"): which Google Drive the close packs go to, named
 * by a masked email, and where to export them; Connect, Reconnect and Disconnect Google Sheets for an owner or admin.
 * Every member sees the status. Headed by Google Sheets' name in words beside a neutral icon: no Google mark without
 * Google's permission. What Disconnect answered stays on the card once it reads Disconnected, beside Connect Google
 * Sheets: whether Google confirmed the revoke, or another workspace keeps the same Google account's access.
 */
export default function GoogleSheetsPanel({
  orgSlug,
  view,
  canManage,
  notice,
}: {
  orgSlug: string;
  view: GoogleSheetsPanelView;
  canManage: boolean;
  notice: string | null;
}) {
  const told = notice ? GOOGLE_SHEETS_NOTICES[notice] : undefined;
  const disconnect = useActionForm(disconnectGoogleSheetsAction, INITIAL);
  const answered = disconnect.state;
  return (
    <section aria-labelledby="googlesheets-title" id="googlesheets">
      <SectionHeader
        id="googlesheets-title"
        className="items-center"
        title={
          <span className="inline-flex items-center gap-2">
            <FileSpreadsheet aria-hidden className="size-5 text-ink-2" />
            Google Sheets
          </span>
        }
        action={<DocsLink href="/docs/guides/accountants#export-the-close-pack-to-google-sheets" topic="Google Sheets" />}
      />
      <Card className="space-y-4 p-5">
        {told && (
          <p role="status" className={told.tone === "success" ? "text-sm text-ink" : "text-sm text-refused"}>
            {told.text}
          </p>
        )}
        {view.state === "not_set_up" ? (
          <p className="text-sm text-ink-2">Google Sheets is not set up on this deployment yet.</p>
        ) : view.state === "not_connected" ? (
          <div className="max-w-prose space-y-3">
            <p className="text-sm text-ink-2">
              Export a month&apos;s close pack to a spreadsheet in a Google Drive: one row per payment, each with its signed ledger entry. Vestiarion can
              open only the spreadsheets it makes.
            </p>
            {canManage ? <ConnectButton orgSlug={orgSlug} label="Connect Google Sheets" /> : <p className="text-sm text-ink-3">An owner or admin can connect Google Sheets.</p>}
          </div>
        ) : (
          <>
            {view.state === "connected" ? (
              <div className="max-w-prose space-y-1">
                <p className="font-semibold text-ink">Connected to the Google Drive of {view.account}</p>
                <p className="text-sm text-ink-2">
                  Connected on {view.connectedAt}. An owner, admin or accountant exports a month from <strong className="font-semibold text-ink">Monthly close pack</strong>{" "}
                  in the Audit log.{" "}
                  <Link href={orgHref(orgSlug, "/evidence/close-pack")} className={LINK}>
                    Open the monthly close pack
                  </Link>
                </p>
                <p className="text-sm text-ink-2">Spreadsheets already exported stay in that Google Drive.</p>
              </div>
            ) : view.state === "needs_reconnect" ? (
              <div className="max-w-prose space-y-1">
                <p className="font-semibold text-refused">Google Sheets needs you to reconnect</p>
                <p className="text-sm text-ink-2">{view.words}</p>
              </div>
            ) : (
              <div className="max-w-prose space-y-1">
                <p className="font-semibold text-ink">Disconnected from {view.account}</p>
                <p className="text-sm text-ink-2">Spreadsheets already exported stay in that Google Drive. Nothing more is written to Google Sheets.</p>
              </div>
            )}
            {canManage ? (
              <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
                {view.state === "needs_reconnect" && <ConnectButton orgSlug={orgSlug} label="Reconnect Google Sheets" />}
                {view.state === "revoked" && <ConnectButton orgSlug={orgSlug} label="Connect Google Sheets" />}
                {view.state !== "revoked" && <Disconnect orgSlug={orgSlug} form={disconnect} />}
                <FormMessage tone={answered.message && !answered.ok ? "error" : "neutral"} className="self-center">
                  {answered.message || null}
                </FormMessage>
              </div>
            ) : (
              <p className="text-sm text-ink-3">An owner or admin manages Google Sheets.</p>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
