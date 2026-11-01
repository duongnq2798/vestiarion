import type { Connection } from "../connectors/connections";
import { syncErrorWords } from "../connectors/status";
import { db, unwrap } from "../dal";
import { firstCharacters, storableText } from "../invoice-drafts/model";

/**
 * The workspace's Google Drive folder (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD3, GD4, GD5,
 * GD13), read and written in the workspace's own scope: `google_drive_folders` is tenant data, one row per workspace.
 * And a connection Google no longer takes, as Google Sheets' store marks one.
 */

export type FolderErrorKind = "folder_gone" | "rate_limited" | "unavailable" | "failed";

export interface DriveFolderRow {
  id: string;
  orgId: string;
  connectionId: string;
  folderId: string;
  folderName: string;
  sharedDriveId: string | null;
  /** The files already in the folder when it was chosen: never read (GD5). */
  baseline: string[];
  chosenBy: string | null;
  chosenAt: string;
  lastReadAt: string | null;
  lastError: string | null;
  lastErrorKind: FolderErrorKind | null;
  lastErrorAt: string | null;
}

interface Row {
  id: string;
  org_id: string;
  connection_id: string;
  folder_id: string;
  folder_name: string;
  shared_drive_id: string | null;
  baseline: string[] | null;
  chosen_by: string | null;
  chosen_at: string;
  last_read_at: string | null;
  last_error: string | null;
  last_error_kind: FolderErrorKind | null;
  last_error_at: string | null;
}

const COLUMNS = "id, org_id, connection_id, folder_id, folder_name, shared_drive_id, baseline, chosen_by, chosen_at, last_read_at, last_error, last_error_kind, last_error_at";

function toFolder(row: Row): DriveFolderRow {
  return {
    id: row.id,
    orgId: row.org_id,
    connectionId: row.connection_id,
    folderId: row.folder_id,
    folderName: row.folder_name,
    sharedDriveId: row.shared_drive_id,
    baseline: row.baseline ?? [],
    chosenBy: row.chosen_by,
    chosenAt: row.chosen_at,
    lastReadAt: row.last_read_at,
    lastError: row.last_error,
    lastErrorKind: row.last_error_kind,
    lastErrorAt: row.last_error_at,
  };
}

/** The workspace's folder, or null when none was chosen (or it was forgotten on disconnect). */
export async function folderOf(): Promise<DriveFolderRow | null> {
  const rows = unwrap(await db().from("google_drive_folders").select(COLUMNS).limit(1)) as unknown as Row[];
  return rows[0] ? toFolder(rows[0]) : null;
}

/**
 * A name from Drive as a row keeps it: at most `max` characters, counted as Postgres counts them, never cut in the middle
 * of an emoji. Half of a surrogate pair is refused by Postgres, and anyone who can add a file to the folder chooses its
 * name (GD9): a name the database refuses must never stop the folder from being read.
 */
export const storableName = (name: string, max: number) => firstCharacters(storableText(name).trim(), max);

/** A folder name as the row keeps it: at most 255 characters, never empty. */
export const folderNameOf = (name: string) => storableName(name, 255) || "Untitled folder";

/**
 * The folder a person chose (GD4, GD5), in place of any before it, with its new baseline: one upsert on the workspace,
 * so two people choosing at once leave one folder, the later one. Its last read and error start again. The same folder
 * chosen again (`again`, the row it already has) keeps its baseline, who chose it and when, and its last read: only a
 * folder that changes gets a new baseline, so a file added while the folder could not be read is still read (GD5, GD13).
 */
export async function saveFolder(input: {
  connectionId: string;
  folder: { id: string; name: string; driveId: string | null };
  baseline: string[];
  by: string;
  nowIso: string;
  again?: DriveFolderRow | null;
}): Promise<DriveFolderRow> {
  const { again } = input;
  const rows = unwrap(
    await db()
      .from("google_drive_folders")
      .upsert(
        {
          connection_id: input.connectionId,
          folder_id: input.folder.id,
          folder_name: folderNameOf(input.folder.name),
          shared_drive_id: input.folder.driveId,
          baseline: again ? again.baseline : input.baseline,
          chosen_by: again ? again.chosenBy : input.by,
          chosen_at: again ? again.chosenAt : input.nowIso,
          last_read_at: again ? again.lastReadAt : null,
          last_error: null,
          last_error_kind: null,
          last_error_at: null,
        },
        { onConflict: "org_id" }
      )
      .select(COLUMNS)
  ) as unknown as Row[];
  return toFolder(rows[0]);
}

/** The folder a read started with: a later choice (or a disconnect) is another, which that read never writes to. */
export type ChosenFolder = Pick<DriveFolderRow, "id" | "folderId" | "chosenAt">;

/**
 * Whether the folder a read started with is still the one chosen (GD4): not replaced by another choice, and not forgotten
 * on disconnect. A read that finds it is not stops claiming files.
 */
export async function stillChosen(folder: ChosenFolder): Promise<boolean> {
  const rows = unwrap(
    await db().from("google_drive_folders").select("id").eq("id", folder.id).eq("folder_id", folder.folderId).eq("chosen_at", folder.chosenAt).limit(1)
  ) as Array<{ id: string }>;
  return rows.length > 0;
}

/**
 * A read that finished (GD6): when, the folder's name as Drive says it now, and no error. Only on the choice the read
 * started with: a folder chosen since keeps its own name and state.
 */
export async function noteFolderRead(folder: ChosenFolder, input: { atIso: string; name: string }): Promise<void> {
  unwrap(
    await db()
      .from("google_drive_folders")
      .update({ last_read_at: input.atIso, folder_name: folderNameOf(input.name), last_error: null, last_error_kind: null, last_error_at: null })
      .eq("id", folder.id)
      .eq("folder_id", folder.folderId)
      .eq("chosen_at", folder.chosenAt)
      .select("id")
  );
}

/**
 * A read that did not finish, in the words a person reads (GD13); the last good read stays as it was. Only on the choice
 * the read started with, as `noteFolderRead`.
 */
export async function noteFolderError(folder: ChosenFolder, input: { kind: FolderErrorKind; words: string; atIso: string }): Promise<void> {
  unwrap(
    await db()
      .from("google_drive_folders")
      .update({ last_error: firstCharacters(input.words, 300), last_error_kind: input.kind, last_error_at: input.atIso })
      .eq("id", folder.id)
      .eq("folder_id", folder.folderId)
      .eq("chosen_at", folder.chosenAt)
      .select("id")
  );
}

/** Forgets the folder (GD2): on disconnect. The files already read stay in the review list. */
export async function forgetFolder(): Promise<void> {
  unwrap(await db().from("google_drive_folders").delete().select("id"));
}

/**
 * A Google Drive connection Google no longer accepts (GD13), as `markSheetsReconnect`: its access was removed in the
 * Google Account, or the grant lacks the Drive permission. It then needs a person, and says so; `connectionStatus` and
 * the accountant console's problems list show it as for any connector. Only a connected one moves.
 */
export async function markDriveReconnect(connection: Pick<Connection, "id">, nowIso: string): Promise<void> {
  const updated = await db()
    .from("accounting_connections")
    .update({ status: "needs_reconnect", last_error: syncErrorWords("reconnect", "Google Drive", null), last_error_at: nowIso })
    .eq("id", connection.id)
    .eq("status", "connected")
    .select("id");
  if (updated.error) throw new Error(updated.error.message);
}
