import { closePackTable } from "../close-pack/export";
import type { ClosePackMonth } from "../close-pack/month";
import { readClosePack } from "../close-pack/read";
import { CLOSE_PACK_EXPORT_LIMIT, recentClosePackExportsBy, recordClosePackExport, recordClosePackExportFailed } from "../close-pack/record";
import type { ClosePack } from "../close-pack/types";
import { connectionFor, NotSetUpError, type Connection } from "../connectors/connections";
import type { ConnectingProvider } from "../connectors/provider";
import { connectionTokenStore } from "../connectors/token-store";
import { freshAccessToken, type TokenStore } from "../connectors/tokens";
import { publicOrigin } from "../public-origin";
import { GoogleError, type GoogleFailure, type GoogleHttp } from "./http";
import { googleSheetsReady } from "./ready";
import { createMonthFile, findMonthFile, formatTabs, readPayments, renameFile, sheetTabs, trashFile, writeValues } from "./sheets";
import { markSheetsReconnect } from "./store";
import { NO_ACCOUNT_NAME } from "./views";
import { exporterWords, monthTag, paymentsSha256, sheetValues, spreadsheetTitle, spreadsheetUrl, summaryValues } from "./table";

/**
 * One export of a month's close pack to Google Sheets, in the workspace's scope
 * (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS7-GS13), in order: the deployment's client,
 * migration 0145 and the connection; the brake; the pack; a fresh token; the month's file, found by its tag or made;
 * its tabs; the values; the read back; and the ledger entry. It writes a copy and decides nothing: nothing read from
 * Google is kept or used but to compare (GS17).
 */

export type SheetExportOutcome =
  | { ok: true; spreadsheetId: string; url: string; payments: number; created: boolean; account: string }
  | {
      ok: false;
      reason: "off" | "not_set_up" | "not_connected" | "reconnect" | "limited" | "read_failed" | "rate_limited" | "unavailable" | "forbidden" | "drive_full" | "mismatch" | "failed";
    };

export interface SheetExportDeps {
  /** Google Sheets on this deployment; null when its client is not set (GS2), and the export is off. */
  provider: ConnectingProvider | null;
  http?: GoogleHttp;
  tokens?: TokenStore;
  readPack?: (month: ClosePackMonth) => Promise<ClosePack>;
  recentExports?: (userId: string) => Promise<number>;
  record?: { exported: typeof recordClosePackExport; failed: typeof recordClosePackExportFailed };
  origin?: string;
}

/** An export starts no new call after this long (GS12): the close pack page's actions have 120 seconds. */
export const EXPORT_DEADLINE_MS = 90_000;

type FailedReason = Parameters<typeof recordClosePackExportFailed>[0]["reason"];

/** The reason a failure after the values write was sent is recorded with; null for one that sent nothing of the pack. */
const RECORDED: Partial<Record<GoogleFailure, FailedReason>> = {
  rate_limited: "rate_limited",
  unavailable: "unavailable",
  forbidden: "forbidden",
  drive_full: "drive_full",
  bad_response: "bad_response",
};

/** What a failure answers the person. A grant Google no longer takes is `reconnect`; a file gone mid-export, `failed`. */
const ANSWER: Record<GoogleFailure, Extract<SheetExportOutcome, { ok: false }>["reason"]> = {
  rate_limited: "rate_limited",
  unauthorized: "reconnect",
  reconnect: "reconnect",
  forbidden: "forbidden",
  drive_full: "drive_full",
  gone: "failed",
  unavailable: "unavailable",
  bad_response: "failed",
};

export async function exportClosePackToSheet(
  input: { orgId: string; user: { id: string; email: string | null }; workspace: { slug: string; name: string }; month: ClosePackMonth },
  deps: SheetExportDeps
): Promise<SheetExportOutcome> {
  const { provider } = deps;
  const now = deps.http?.now ?? Date.now;
  const started = now();

  // 1. The client, migration 0145, and the connection (GS2).
  if (!provider) return { ok: false, reason: "off" };
  let connection: Connection | null;
  try {
    await googleSheetsReady();
    connection = await connectionFor("googlesheets");
  } catch (error) {
    if (error instanceof NotSetUpError) return { ok: false, reason: "not_set_up" };
    throw error;
  }
  if (!connection || connection.status === "revoked") return { ok: false, reason: "not_connected" };
  if (connection.status === "needs_reconnect") return { ok: false, reason: "reconnect" };
  const live = connection;

  // 2. The brake, one for downloads and exports, before the pack is read or Google is called (GS11).
  const recent = await (deps.recentExports ?? ((userId: string) => recentClosePackExportsBy(userId, new Date(now()))))(input.user.id);
  if (recent >= CLOSE_PACK_EXPORT_LIMIT.count) return { ok: false, reason: "limited" };

  // 3. The pack, with members' emails, as the CSV has them.
  let pack: ClosePack;
  try {
    pack = await (deps.readPack ?? ((month: ClosePackMonth) => readClosePack({ month, workspace: input.workspace, people: "email" })))(input.month);
  } catch {
    console.error("google sheets: the close pack could not be read");
    return { ok: false, reason: "read_failed" };
  }

  // What is written, built before any call: the Payments tab, its hash, and the Summary that names the hash.
  const origin = deps.origin ?? publicOrigin();
  const payments = sheetValues(closePackTable(pack, { origin }));
  const sha256 = paymentsSha256(payments);
  const summary = summaryValues(pack, { origin, sha256, exportedBy: exporterWords(input.user) });
  const record = deps.record ?? { exported: recordClosePackExport, failed: recordClosePackExportFailed };
  const reconnect = async (): Promise<SheetExportOutcome> => {
    await markSheetsReconnect(live, new Date(now()).toISOString());
    return { ok: false, reason: "reconnect" };
  };

  // 4. A fresh token (GS13).
  const store = deps.tokens ?? connectionTokenStore(input.orgId, live.id);
  const first = await freshAccessToken({ store, refresh: provider.refresh, now });
  if (!first.ok) return first.reason === "reconnect" || first.reason === "missing" ? reconnect() : { ok: false, reason: "unavailable" };
  let token = first.accessToken;

  // No call starts after the deadline (GS12): the fetch itself refuses, and the call answers unavailable.
  const fetchImpl = deps.http?.fetchImpl;
  const http: GoogleHttp = {
    ...deps.http,
    now,
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (now() - started > EXPORT_DEADLINE_MS) throw new Error("the export ran out of time");
      return (fetchImpl ?? fetch)(url, init);
    }) as typeof fetch,
  };

  /** One call with the token; a 401 refreshes it once, with the refused token, and sends the call again (GS12). */
  const call = async <T>(send: (accessToken: string) => Promise<T>): Promise<T> => {
    try {
      return await send(token);
    } catch (error) {
      if (!(error instanceof GoogleError) || error.failure !== "unauthorized") throw error;
    }
    const again = await freshAccessToken({ store, refresh: provider.refresh, now, refused: token });
    if (!again.ok) throw new GoogleError(again.reason === "reconnect" || again.reason === "missing" ? "reconnect" : "unavailable", "Google Sheets: the token was not refreshed");
    token = again.accessToken;
    try {
      return await send(token);
    } catch (error) {
      if (error instanceof GoogleError && error.failure === "unauthorized") throw new GoogleError("reconnect", "Google Sheets: a refreshed token was refused");
      throw error;
    }
  };

  const tag = monthTag(input.orgId, pack.month);
  const name = spreadsheetTitle(pack);
  let spreadsheetId: string | null = null;
  let stage: "before" | "write" | "read_back" = "before";
  try {
    // 5. The month's file (GS7).
    const file = await monthFile({ call, tag, name, http });
    spreadsheetId = file.id;

    // 6. Its tabs, Vestiarion's two formatted afresh (GS8, GS9).
    const tabs = await call((accessToken) => sheetTabs(accessToken, file.id, http));
    await call((accessToken) => formatTabs(accessToken, file.id, { tabs, fresh: file.fresh, rows: payments.length - 1, summaryRows: summary.length }, http));

    // 7. The values: from here rows may reach Google, and a failure is recorded (GS11).
    stage = "write";
    await call((accessToken) => writeValues(accessToken, file.id, { payments, summary }, http));

    // 8. The read back, padded and hashed (GS10).
    stage = "read_back";
    const read = await call((accessToken) => readPayments(accessToken, file.id, http));
    if (read.length !== payments.length || paymentsSha256(read) !== sha256) {
      await record.failed({ orgId: input.orgId, userId: input.user.id, pack, connectionId: live.id, spreadsheetId: file.id, stage, reason: "mismatch" });
      return { ok: false, reason: "mismatch" };
    }

    // 9. Done.
    await record.exported({ orgId: input.orgId, userId: input.user.id, pack, format: "google_sheets", sha256, sheet: { connectionId: live.id, spreadsheetId: file.id, created: file.created } });
    return { ok: true, spreadsheetId: file.id, url: spreadsheetUrl(file.id), payments: payments.length - 1, created: file.created, account: live.externalOrgName ?? NO_ACCOUNT_NAME };
  } catch (error) {
    if (!(error instanceof GoogleError)) {
      console.error("google sheets: the export failed", error instanceof Error ? error.name : "unknown error");
      if (stage !== "before") await record.failed({ orgId: input.orgId, userId: input.user.id, pack, connectionId: live.id, spreadsheetId, stage, reason: "bad_response" });
      return { ok: false, reason: "failed" };
    }
    const recorded = RECORDED[error.failure];
    if (stage !== "before" && recorded) await record.failed({ orgId: input.orgId, userId: input.user.id, pack, connectionId: live.id, spreadsheetId, stage, reason: recorded });
    if (error.failure === "reconnect" || error.failure === "unauthorized") return reconnect();
    return { ok: false, reason: ANSWER[error.failure] };
  }
}

type Call = <T>(send: (accessToken: string) => Promise<T>) => Promise<T>;

/**
 * The month's spreadsheet (GS7): the oldest file under its tag that still answers, renamed; else a new one. After a
 * create the tag is listed again: when two exports raced and both made one, each keeps the oldest and trashes its own.
 * A file that is gone (deleted, or out of this grant's reach) is passed over, never trashed. `fresh`: made in this run,
 * by this export or the one it raced, so its first tab is still Google's own.
 */
async function monthFile(input: { call: Call; tag: string; name: string; http: GoogleHttp }): Promise<{ id: string; created: boolean; fresh: boolean }> {
  const { call, tag, name, http } = input;
  const gone = new Set<string>();
  for (const file of await call((token) => findMonthFile(token, tag, http))) {
    if ((await call((token) => renameFile(token, file.id, name, http))) === "ok") return { id: file.id, created: false, fresh: false };
    gone.add(file.id);
  }
  const made = await call((token) => createMonthFile(token, { name, tag }, http));
  const oldest = (await call((token) => findMonthFile(token, tag, http))).find((file) => !gone.has(file.id))?.id ?? made;
  if (oldest === made) return { id: made, created: true, fresh: true };
  try {
    await call((token) => trashFile(token, made, http));
  } catch (error) {
    // The duplicate stays in the Drive under the same tag: the next export finds the oldest first again.
    console.error("google sheets: a duplicate spreadsheet was not trashed", error instanceof GoogleError ? error.failure : "unknown error");
  }
  return { id: oldest, created: false, fresh: true };
}

