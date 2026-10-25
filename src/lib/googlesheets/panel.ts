import type { OrgRole } from "../auth/roles";
import type { ClosePackMonth } from "../close-pack/month";
import { CLOSE_PACK_EXPORTED } from "../close-pack/record";
import { utcWords } from "../close-pack/words";
import { connectionFor, NotSetUpError } from "../connectors/connections";
import { db } from "../dal";
import { googleSheetsReady } from "./ready";
import { googleSheetsSettingsFromEnv } from "./settings";
import { SPREADSHEET_ID, spreadsheetUrl } from "./table";
import { closePackSheetsViewOf, googleSheetsPanelView, type ClosePackSheetsView, type GoogleSheetsPanelView } from "./views";

/**
 * Google Sheets' card of Settings, in the workspace's scope (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md
 * GS2): null where the deployment has no Google client, so the card is not there; "not set up" before migration 0145.
 */
export async function googleSheetsPanelFor(): Promise<GoogleSheetsPanelView | null> {
  if (!googleSheetsSettingsFromEnv()) return null;
  try {
    await googleSheetsReady();
    return googleSheetsPanelView(await connectionFor("googlesheets"));
  } catch (error) {
    if (error instanceof NotSetUpError) return { state: "not_set_up" };
    throw error;
  }
}

/**
 * The month's last export to Google Sheets (GS5, GS9's "Last exported" line): the newest `close_pack_exported` of format
 * google_sheets for the month, its spreadsheet linked from its checked id. Null when there is none, or it does not read.
 */
async function lastExport(month: ClosePackMonth): Promise<{ at: string; payments: number; url: string } | null> {
  const read = await db()
    .from("ledger_entries")
    .select("ts, detail")
    .eq("action", CLOSE_PACK_EXPORTED)
    .eq("detail->>format", "google_sheets")
    .eq("detail->>month", month.key)
    .order("seq", { ascending: false })
    .limit(1);
  if (read.error) throw new Error(read.error.message);
  const entry = ((read.data ?? []) as Array<{ ts: string; detail: Record<string, unknown> | null }>)[0];
  const id = entry?.detail?.spreadsheetId;
  const payments = entry?.detail?.payments;
  if (!entry || typeof id !== "string" || !SPREADSHEET_ID.test(id) || typeof payments !== "number" || !Number.isSafeInteger(payments) || payments < 0) return null;
  return { at: utcWords(entry.ts), payments, url: spreadsheetUrl(id) };
}

/**
 * The close pack page's Google Sheets control for this month and the person's role (GS5), best effort: a read that
 * fails is hidden, and logged by its name only, so the page still shows the month.
 */
export async function closePackSheetsView(input: { month: ClosePackMonth; role: OrgRole }): Promise<ClosePackSheetsView> {
  try {
    const panel = await googleSheetsPanelFor();
    const last = panel?.state === "connected" ? await lastExport(input.month) : null;
    return closePackSheetsViewOf({ panel, role: input.role, last });
  } catch (error) {
    console.error("google sheets: the close pack page's view was not read", error instanceof Error ? error.name : "unknown error");
    return { state: "hidden" };
  }
}
