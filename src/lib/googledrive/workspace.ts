import { failureDelayMs } from "../connectors/backoff";
import { connectedElsewhere, connectionFor, connectionsByExternal, NotSetUpError, type Connection } from "../connectors/connections";
import { syncErrorWords, type SyncErrorKind } from "../connectors/status";
import { syncStore } from "../connectors/sync-store";
import { connectionTokenStore } from "../connectors/token-store";
import { currentOrgId } from "../context";
import { googleSheetsSettingsFromEnv } from "../googlesheets/settings";
import { recordUsage } from "../usage/record";
import { googleDriveProviderFromEnv, type GoogleDriveProvider } from "./provider";
import { FOLDER_WORDS, readDriveFolder, type DriveReadCounts } from "./read";
import { googleDriveReady } from "./ready";
import { googleDriveSettingsFromEnv } from "./settings";
import { driveSession } from "./session";
import { folderOf, type DriveFolderRow } from "./store";

/**
 * A workspace's Google Drive, as every path uses it (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md
 * GD2, GD7, GD13): its connection, the folder it reads, and the run that reads it, by the 15-minute sweeper and on
 * Check Google Drive now alike, under the connection's sync lease so two never read at once. All of it in the
 * workspace's own scope.
 */

export type DriveMissing = "off" | "not_set_up" | "not_connected" | "reconnect";

export interface DriveContext {
  connection: Connection;
  provider: GoogleDriveProvider;
}

/** The workspace's Google Drive connection, ready to call, or why there is none. */
export async function googleDriveContext(given?: GoogleDriveProvider | null): Promise<DriveContext | { missing: DriveMissing; connection?: Connection | null }> {
  const provider = given === undefined ? googleDriveProviderFromEnv() : given;
  if (!provider) return { missing: "off" };
  let connection: Connection | null;
  try {
    await googleDriveReady();
    connection = await connectionFor("googledrive");
  } catch (error) {
    if (error instanceof NotSetUpError) return { missing: "not_set_up" };
    throw error;
  }
  if (!connection || connection.status === "revoked") return { missing: "not_connected", connection };
  if (connection.status === "needs_reconnect") return { missing: "reconnect", connection };
  return { connection, provider };
}

/** The folder this connection reads: one chosen through another connection (an account since replaced) is none. */
export async function folderFor(connection: Pick<Connection, "id">): Promise<DriveFolderRow | null> {
  const folder = await folderOf();
  return folder && folder.connectionId === connection.id ? folder : null;
}

/**
 * Whether disconnecting may revoke the grant at Google (GD2). Google's revoke ends the Google account's whole grant to
 * the OAuth client, so it would cut off every other workspace connected with the same account, and Google Sheets too
 * when the deployment uses one client for both. It is sent only when neither is so.
 */
export async function mayRevokeAtGoogle(connection: Pick<Connection, "externalOrgId" | "orgId">): Promise<boolean> {
  if (await connectedElsewhere("googledrive", connection.externalOrgId, connection.orgId)) return false;
  const sheets = googleSheetsSettingsFromEnv();
  const drive = googleDriveSettingsFromEnv();
  if (!sheets || !drive || sheets.clientId !== drive.clientId) return true;
  return (await connectionsByExternal("googlesheets", [connection.externalOrgId])).length === 0;
}

/** How long a run holds its connection at most: far past a 40-second read and its last file. */
const SYNC_LEASE_MS = 5 * 60_000;

export type DriveSyncOutcome = "synced" | "busy" | "reconnect" | "failed" | "rate_limited" | "unavailable";

export interface DriveSync {
  outcome: DriveSyncOutcome;
  /**
   * No folder chosen yet; the folder read; the folder gone (deleted, trashed or no longer shared); or another folder
   * chosen, or the folder forgotten, while it was read.
   */
  folder: "none" | "read" | "gone" | "changed";
  folderName?: string;
  counts?: DriveReadCounts;
  /** What the folder's card says of a read that stopped. */
  words?: string;
}

/**
 * One read of a Google Drive connection's folder (GD6, GD7, GD13), from the sweeper or Check Google Drive now, in the
 * workspace's scope: under the connection's sync lease, with its own token. A folder read, or none chosen, ends the run
 * as synced, so the connection is due again at the next sweep, 15 minutes on. A folder gone says so on the folder and
 * nowhere else. A grant Google no longer takes marks the connection to reconnect; a rate limit or no answer waits as the
 * core's syncs do (a minute, doubling, at most an hour, or what Google asked).
 */
export async function syncGoogleDriveConnection(
  connectionId: string,
  provider: GoogleDriveProvider,
  options: { now?: () => number; budgetMs?: number; origin?: string; fetchImpl?: typeof fetch } = {}
): Promise<DriveSync> {
  const now = options.now ?? provider.http.now ?? Date.now;
  const iso = (ms: number) => new Date(ms).toISOString();
  const connection = await syncStore.claim(connectionId, iso(now()), iso(now() + SYNC_LEASE_MS));
  if (!connection) return { outcome: "busy", folder: "none" };
  const fail = async (kind: Exclude<SyncErrorKind, "reconnect">, retryAfterMs: number | null): Promise<DriveSyncOutcome> => {
    const failures = connection.failures + 1;
    const next = iso(now() + (retryAfterMs ?? failureDelayMs(failures)));
    await syncStore.finish(connection.id, { kind: "failed", at: iso(now()), failures, nextSyncAfter: next, error: syncErrorWords(kind, "Google Drive", next, now()) });
    return kind === "rate_limited" ? "rate_limited" : kind === "unavailable" ? "unavailable" : "failed";
  };
  try {
    const folder = await folderFor(connection);
    if (!folder) {
      await syncStore.finish(connection.id, { kind: "synced", at: iso(now()) });
      return { outcome: "synced", folder: "none" };
    }
    const session = driveSession({ provider, tokens: connectionTokenStore(currentOrgId(), connection.id), now });
    const read = await readDriveFolder(
      { orgId: connection.orgId, folder },
      { session, http: provider.http, now, budgetMs: options.budgetMs, origin: options.origin, fetchImpl: options.fetchImpl }
    );
    const named = { folderName: folder.folderName, counts: read.counts };
    if (read.ok) {
      await syncStore.finish(connection.id, { kind: "synced", at: iso(now()) });
      if (read.counts.found > 0) await recordUsage({ kind: "connector_sync", action: "googledrive", provider: "googledrive", ok: true });
      return { outcome: "synced", folder: "read", ...named };
    }
    switch (read.reason) {
      case "folder_gone":
        // The connection works; the folder is read again once the account can open it, or another chosen (GD13).
        await syncStore.finish(connection.id, { kind: "synced", at: iso(now()) });
        return { outcome: "synced", folder: "gone", ...named, words: read.words ?? FOLDER_WORDS.folder_gone };
      case "folder_changed":
        // The folder chosen since is read at the next sweep, 15 minutes on at most (GD4).
        await syncStore.finish(connection.id, { kind: "synced", at: iso(now()) });
        return { outcome: "synced", folder: "changed", ...named };
      case "reconnect":
        await syncStore.finish(connection.id, { kind: "reconnect", at: iso(now()), error: syncErrorWords("reconnect", "Google Drive", null) });
        return { outcome: "reconnect", folder: "read", ...named };
      case "busy":
        await syncStore.finish(connection.id, { kind: "released", at: iso(now()) });
        return { outcome: "busy", folder: "read", ...named };
      case "rate_limited":
      case "unavailable":
        return { outcome: await fail(read.reason, read.retryAfterMs), folder: "read", ...named, words: read.words ?? FOLDER_WORDS[read.reason] };
      case "failed":
        return { outcome: await fail("failed", null), folder: "read", ...named, words: read.words ?? FOLDER_WORDS.failed };
    }
  } catch (error) {
    console.error("google drive: a read of a connection failed", connectionId, error instanceof Error ? error.message : "unknown error");
    return { outcome: await fail("failed", null), folder: "none" };
  }
}
