"use client";

import { ArrowUpRight, FileSpreadsheet, Link2 } from "lucide-react";
import Link from "next/link";
import { exportClosePackToSheetsAction, type SheetsExportResult } from "@/app/actions/googlesheets";
import { Button } from "@/components/ui/Button";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { orgHref } from "@/lib/auth/org-paths";
import type { ClosePackSheetsView } from "@/lib/googlesheets/views";

const INITIAL: SheetsExportResult = { ok: false, message: "" };
const LINK = "inline-flex items-center gap-0.5 font-medium text-agent underline-offset-4 hover:underline";

/** A spreadsheet's link, built on the server from its checked id (GS12): in a new tab, sending no referrer. */
function OpenSpreadsheet({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK}>
      Open the spreadsheet
      <span className="sr-only"> (opens in a new tab)</span>
      <ArrowUpRight aria-hidden className="size-3.5" />
    </a>
  );
}

function SettingsLink({ orgSlug, label }: { orgSlug: string; label: string }) {
  return (
    <Button asChild size="sm" variant="secondary">
      <Link href={orgHref(orgSlug, "/settings#googlesheets")}>
        <Link2 aria-hidden />
        {label}
      </Link>
    </Button>
  );
}

const paymentsWords = (n: number) => `${n} ${n === 1 ? "payment" : "payments"}`;

/**
 * Export to Google Sheets on the close pack page (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md
 * GS5, GS9, "The close pack page"): connect or reconnect in Settings, or the button for an owner, admin or accountant,
 * with the Drive it writes to; and for every member the month's last export with its link. The action's answer lives in
 * this component, which stays mounted whatever the revalidated page's view is, so the answer is not dropped with it.
 * Nothing of it is printed.
 */
export function SheetsExport({ orgSlug, month, view }: { orgSlug: string; month: string; view: ClosePackSheetsView }) {
  const { state, formProps } = useActionForm(exportClosePackToSheetsAction, INITIAL);
  if (view.state === "hidden") return null;
  const answer = state.message ? (
    state.ok ? (
      <div className="space-y-1 text-sm">
        <FormMessage tone="success">{state.message}</FormMessage>
        {state.sheet && (
          <p className="flex flex-wrap items-center gap-x-2 text-ink-2">
            <span>In the Google Drive of {state.sheet.account}.</span>
            <OpenSpreadsheet href={state.sheet.url} />
          </p>
        )}
      </div>
    ) : (
      <FormMessage tone="error">{state.message}</FormMessage>
    )
  ) : null;

  return (
    <div className="space-y-2 print:hidden">
      {view.state === "connect" ? (
        view.canConnect ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-ink-2">Connect Google Sheets in Settings to export this month to a spreadsheet.</p>
            <SettingsLink orgSlug={orgSlug} label="Connect Google Sheets" />
          </div>
        ) : (
          <p className="text-sm text-ink-2">An owner or admin can connect Google Sheets in Settings, so this month can be exported to a spreadsheet.</p>
        )
      ) : view.state === "reconnect" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-ink-2">Google Sheets needs reconnecting before this month can be exported. An owner or admin can reconnect it in Settings.</p>
          {view.canConnect && <SettingsLink orgSlug={orgSlug} label="Reconnect Google Sheets" />}
        </div>
      ) : (
        <>
          {view.canExport && (
            <form {...formProps} className="space-y-2">
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="month" value={month} />
              <SubmitButton size="sm" variant="secondary" pendingLabel="Exporting…" icon={<FileSpreadsheet aria-hidden />}>
                Export to Google Sheets
              </SubmitButton>
              <p className="text-xs text-ink-3">
                Writes this month to a spreadsheet in the Google Drive of {view.account}. Exporting the same month again updates that spreadsheet.
              </p>
            </form>
          )}
          {view.last && (
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-2">
              <span>
                Last exported to Google Sheets on {view.last.at}: {paymentsWords(view.last.payments)}.
              </span>
              <OpenSpreadsheet href={view.last.url} />
            </p>
          )}
        </>
      )}
      {answer}
    </div>
  );
}
