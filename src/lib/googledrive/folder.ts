import { GoogleError } from "../googlesheets/http";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { connectionTokenStore } from "../connectors/token-store";
import { currentOrgId } from "../context";
import { FOLDER_MIME, listFolder, readFolder } from "./drive";
import { folderIdOf } from "./link";
import type { GoogleDriveProvider } from "./provider";
import { DriveAccessError, driveSession, needsReconnect } from "./session";
import { markDriveReconnect, saveFolder, type DriveFolderRow } from "./store";
import { folderFor, googleDriveContext } from "./workspace";

/**
 * Choosing the folder (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD4, GD5, GD11), in the
 * workspace's scope, by an owner or admin (`integrations.manage`, checked by the action). The pasted link is read only
 * for the folder's id. The folder is read once through the connection: it must be a folder, not in the trash. The ids
 * of the files already in it are its baseline, never read, so an old bill already paid never comes back as a new one;
 * a folder with more than 1,000 is refused. Choosing another folder replaces the first, with a new baseline; the same
 * folder chosen again keeps the baseline it has. Recorded as `google_drive_folder_chosen`, with the baseline's count,
 * never its ids.
 */

/** The most files a folder may hold when it is chosen (GD5). */
export const MAX_BASELINE = 1_000;

export type ChooseFolderRefusal =
  | "not_a_link"
  | "off"
  | "not_set_up"
  | "not_connected"
  | "reconnect"
  | "not_found"
  | "not_a_folder"
  | "trashed"
  | "too_many"
  | "forbidden"
  | "rate_limited"
  | "unavailable"
  | "failed";

/** `again`: the folder already read was chosen again, its baseline kept (GD5). */
export type ChooseFolderOutcome = { ok: true; folder: DriveFolderRow; again: boolean } | { ok: false; reason: ChooseFolderRefusal; account?: string };

export async function chooseDriveFolder(input: { given: string; by: string; nowMs?: number }, given?: GoogleDriveProvider | null): Promise<ChooseFolderOutcome> {
  const folderId = folderIdOf(input.given);
  if (!folderId) return { ok: false, reason: "not_a_link" };
  const context = await googleDriveContext(given);
  if ("missing" in context) return { ok: false, reason: context.missing };
  const { connection, provider } = context;
  const account = connection.externalOrgName ?? undefined;
  const now = provider.http.now ?? Date.now;
  const session = driveSession({ provider, tokens: connectionTokenStore(currentOrgId(), connection.id), now });
  // The folder already read, chosen again (as the card asks when it was gone): its baseline stays, so a file added while
  // it could not be read is still read, never taken into a new baseline (GD5, GD13).
  const current = await folderFor(connection);
  const again = current && current.folderId === folderId ? current : null;

  let read: { folder: Awaited<ReturnType<typeof readFolder>>; baseline: string[] };
  try {
    const folder = await session.call((token) => readFolder(token, folderId, provider.http));
    if (folder.mimeType !== FOLDER_MIME) return { ok: false, reason: "not_a_folder", account };
    if (folder.trashed) return { ok: false, reason: "trashed", account };
    if (again) {
      read = { folder, baseline: again.baseline };
    } else {
      const listed = await session.call((token) => listFolder(token, folderId, { max: MAX_BASELINE }, provider.http));
      if (listed.more) return { ok: false, reason: "too_many", account };
      read = { folder, baseline: listed.files.map((file) => file.id) };
    }
  } catch (error) {
    if (needsReconnect(error)) {
      await markDriveReconnect(connection, new Date(now()).toISOString());
      return { ok: false, reason: "reconnect", account };
    }
    if (error instanceof DriveAccessError) return { ok: false, reason: "unavailable", account };
    if (error instanceof GoogleError) {
      // Not this account's to open: deleted, never shared with it, or a grant that does not reach it.
      if (error.failure === "gone" || (error.failure === "forbidden" && error.reason === "appNotAuthorizedToFile")) return { ok: false, reason: "not_found", account };
      if (error.failure === "forbidden") return { ok: false, reason: "forbidden", account };
      if (error.failure === "rate_limited") return { ok: false, reason: "rate_limited", account };
      if (error.failure === "unavailable") return { ok: false, reason: "unavailable", account };
      return { ok: false, reason: "failed", account };
    }
    throw error;
  }

  const saved = await saveFolder({ connectionId: connection.id, folder: read.folder, baseline: read.baseline, by: input.by, nowIso: new Date(input.nowMs ?? now()).toISOString(), again });
  const count = saved.baseline.length;
  await appendLedgerEntryBestEffort(connection.orgId, {
    actor: "human",
    domain: "ap",
    action: "google_drive_folder_chosen",
    summary: chosenSummary(saved.folderName, count, again !== null),
    detail: { by: input.by, folderId: saved.folderId, folderName: saved.folderName, baseline: count },
  });
  return { ok: true, folder: saved, again: again !== null };
}

/** The ledger's words for a folder chosen (GD11): an empty one names no files left as they are. */
function chosenSummary(name: string, count: number, again: boolean): string {
  const files = `${count} ${count === 1 ? "file" : "files"}`;
  if (again) {
    const kept = count === 0 ? "" : ` The ${files} in it when it was first chosen ${count === 1 ? "is" : "are"} still left as ${count === 1 ? "it is" : "they are"}.`;
    return `Chose the Google Drive folder ${name} again: the files added to it since it was first chosen come in for review.${kept}`;
  }
  const left = count === 0 ? "" : ` The ${files} already in it ${count === 1 ? "is" : "are"} left as ${count === 1 ? "it is" : "they are"}.`;
  return `Chose the Google Drive folder ${name}: the files added to it from now on come in for review.${left}`;
}
