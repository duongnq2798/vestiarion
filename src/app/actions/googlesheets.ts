"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { closePackMonth } from "@/lib/close-pack/month";
import { connectedElsewhere, connectionFor, disconnectConnection } from "@/lib/connectors/connections";
import { inOrg } from "@/lib/dal/scope";
import { exportClosePackToSheet, type SheetExportOutcome } from "@/lib/googlesheets/export";
import { googleSheetsProvider } from "@/lib/googlesheets/provider";
import { googleSheetsSettingsFromEnv } from "@/lib/googlesheets/settings";
import { takeClosePackDownloadToken } from "@/lib/rate-limit";

/**
 * Google Sheets from the console (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS5, GS11, GS14,
 * "Screens and copy"): exporting a month's close pack is an owner's, admin's or accountant's (`accounting.book`), the
 * bookkeeping act the accountant already holds for Xero; disconnecting is an owner's or admin's (`integrations.manage`).
 * Each reads the person's role again and works in the workspace's scope; nothing returned carries a token, and the only
 * link is the spreadsheet's, built from its checked id.
 */

export interface GoogleSheetsActionResult {
  ok: boolean;
  message: string;
}

export interface SheetsExportResult {
  ok: boolean;
  message: string;
  /** A done export's spreadsheet, linked from its checked id, and the masked Google account whose Drive holds it. */
  sheet?: { url: string; account: string };
}

const TRY_AGAIN = "That did not work. Try again in a moment.";
const NOT_SET_UP = "Google Sheets is not set up on this deployment yet.";
const NOT_CONNECTED = "Google Sheets is not connected to this workspace.";

/** What each export that did not finish answers (GS11, GS12, GS13). */
const EXPORT_WORDS: Record<Extract<SheetExportOutcome, { ok: false }>["reason"], string> = {
  limited: "Too many close pack exports in the last 10 minutes. Try again later.",
  rate_limited: "Google asked Vestiarion to slow down. Try again in a minute.",
  unavailable: "Google did not answer. Try again in a moment.",
  reconnect: "Google Sheets needs you to reconnect. An owner or admin can reconnect it in Settings.",
  drive_full: "That Google Drive is full, so the spreadsheet could not be written. Free some space in it, then export again.",
  forbidden: "Google refused to write the spreadsheet in that account. A Google Workspace administrator may have turned Drive off for it.",
  mismatch: "The spreadsheet did not read back as written, so the export is not recorded as done. Export again.",
  read_failed: "The close pack could not be read. Try again in a moment.",
  not_connected: NOT_CONNECTED,
  not_set_up: NOT_SET_UP,
  off: NOT_SET_UP,
  failed: TRY_AGAIN,
};

const text = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
};

function exportedWords(payments: number): string {
  if (payments === 0) return "Exported this month to Google Sheets: no payment settled in it yet.";
  return `Exported ${payments} ${payments === 1 ? "payment" : "payments"} to Google Sheets.`;
}

/**
 * Export to Google Sheets (GS5, GS7-GS13): the month the page shows, written to the month's spreadsheet in the connected
 * Google Drive. A burst is held by the close pack downloads' own token, per person per workspace, before the export
 * counts the ledger's brake, so exports sent together from several tabs do not all count the same earlier entries.
 */
export async function exportClosePackToSheetsAction(_previous: SheetsExportResult, formData: FormData): Promise<SheetsExportResult> {
  const auth = await authorize(formData.get("orgSlug"), "accounting.book");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const asked = text(formData, "month");
    // An empty month reads as last month on the page; here the form always names the one it shows.
    const month = asked ? closePackMonth(asked, new Date()) : null;
    if (!month) return { ok: false, message: "Choose a month that has started, from 2020 on." };
    if (!takeClosePackDownloadToken(`${auth.user.id}:${auth.membership.orgId}`)) {
      return { ok: false, message: "Too many close pack exports in a row. Try again in a minute." };
    }
    try {
      const settings = googleSheetsSettingsFromEnv();
      const outcome = await exportClosePackToSheet(
        {
          orgId: auth.membership.orgId,
          user: { id: auth.user.id, email: auth.user.email ?? null },
          workspace: { slug: auth.membership.slug, name: auth.membership.name },
          month,
        },
        { provider: settings ? googleSheetsProvider(settings) : null }
      );
      // Done: no revalidation. It would read the whole pack again inside this action's time, after an export that may
      // have used most of it; the answer holds the count, the account and the link (GS5, GS12).
      if (outcome.ok) return { ok: true, message: exportedWords(outcome.payments), sheet: { url: outcome.url, account: outcome.account } };
      // The card and the close pack page say the connection needs reconnecting.
      if (outcome.reason === "reconnect") revalidateOrgPages();
      return { ok: false, message: EXPORT_WORDS[outcome.reason] };
    } catch (error) {
      console.error("exportClosePackToSheetsAction failed", error instanceof Error ? error.name : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/**
 * Disconnect Google Sheets (GS14). Google's revoke ends the Google account's whole grant to Vestiarion, so it would cut
 * off every other workspace connected with the same account: it is sent only when no other workspace is. Either way the
 * tokens are deleted, the connection marked revoked and `accounting_disconnected` signed; the spreadsheets stay.
 */
export async function disconnectGoogleSheetsAction(_previous: GoogleSheetsActionResult, formData: FormData): Promise<GoogleSheetsActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const connection = await connectionFor("googlesheets");
      if (!connection || connection.status === "revoked") return { ok: false, message: NOT_CONNECTED };
      const shared = await connectedElsewhere("googlesheets", connection.externalOrgId, connection.orgId);
      const settings = googleSheetsSettingsFromEnv();
      const provider = settings && !shared ? googleSheetsProvider(settings) : null;
      const { revokedAtProvider } = await disconnectConnection({ connection, by: auth.user.id, revoke: provider ? provider.revoke : async () => false });
      revalidateOrgPages();
      if (shared) {
        return {
          ok: true,
          message:
            "Google Sheets is disconnected from this workspace. Another workspace is connected with the same Google account, so Vestiarion's access there stays until you remove it in that Google Account's settings. Spreadsheets already exported stay in that Google Drive.",
        };
      }
      if (!revokedAtProvider) {
        return {
          ok: true,
          message:
            "Google Sheets is disconnected and its tokens are deleted. Google did not confirm the revoke, so remove Vestiarion in that Google Account's settings to be sure.",
        };
      }
      return { ok: true, message: "Google Sheets is disconnected. Spreadsheets already exported stay in that Google Drive." };
    } catch (error) {
      console.error("disconnectGoogleSheetsAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}
