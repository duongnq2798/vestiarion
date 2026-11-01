import { connectionFor, NotSetUpError } from "../connectors/connections";
import { db } from "../dal";
import { googleDriveReady } from "./ready";
import { googleDriveSettingsFromEnv } from "./settings";
import { folderOf } from "./store";
import { googleDrivePanelView, type GoogleDriveCheckView, type GoogleDriveFigures, type GoogleDrivePanelView } from "./views";

/**
 * Google Drive's card of Settings and the review list's Check Google Drive now, in the workspace's scope
 * (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD3, GD15, GD16): null where the deployment has no
 * Google Drive client, so neither is there; "not set up" before migration 0148.
 */

const DAY_MS = 86_400_000;
const STILL_TO_DECIDE = ["received", "ready", "needs_details", "unreadable"];
const NO_FIGURES: GoogleDriveFigures = { read30d: 0, waiting: 0, added30d: 0 };

type CountQuery = PromiseLike<{ count: number | null; error: { message: string } | null }>;

async function counted(query: CountQuery): Promise<number> {
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return result.count ?? 0;
}

/**
 * The card's figures (GD15), from the review list's Drive rows: found in 30 days, added as bills in 30 days (when a
 * person added it, whenever it was found), and waiting now.
 */
async function figuresOf(nowMs: number): Promise<GoogleDriveFigures> {
  const since = new Date(nowMs - 30 * DAY_MS).toISOString();
  const rows = () => db().from("inbox_emails").select("id", { count: "exact", head: true }).eq("source", "google_drive");
  const [read30d, waiting, added30d] = await Promise.all([
    counted(rows().gte("received_at", since)),
    counted(rows().in("status", STILL_TO_DECIDE)),
    counted(rows().eq("status", "added").gte("decided_at", since)),
  ]);
  return { read30d, waiting, added30d };
}

export async function googleDrivePanelFor(nowMs: number = Date.now()): Promise<GoogleDrivePanelView | null> {
  if (!googleDriveSettingsFromEnv()) return null;
  try {
    await googleDriveReady();
    const connection = await connectionFor("googledrive");
    if (!connection || connection.status !== "connected") return googleDrivePanelView({ connection, folder: null, figures: NO_FIGURES, nowMs });
    const [folder, figures] = await Promise.all([folderOf(), figuresOf(nowMs)]);
    return googleDrivePanelView({ connection, folder, figures, nowMs });
  } catch (error) {
    if (error instanceof NotSetUpError) return { state: "not_set_up" };
    throw error;
  }
}

/**
 * Whether the review list offers Check Google Drive now (GD7, GD16): Google Drive connected with a folder chosen, and,
 * when the folder is gone (deleted, trashed or no longer shared), what the card says of it (GD13), so the list never says
 * it reads a folder Google no longer gives. Best effort: a read that fails offers nothing, and is logged by its name
 * only, so the list still shows.
 */
export async function googleDriveCheckFor(): Promise<GoogleDriveCheckView | null> {
  if (!googleDriveSettingsFromEnv()) return null;
  try {
    await googleDriveReady();
    const connection = await connectionFor("googledrive");
    if (!connection || connection.status !== "connected") return null;
    const folder = await folderOf();
    if (!folder || folder.connectionId !== connection.id) return null;
    return { folderName: folder.folderName, problem: folder.lastErrorKind === "folder_gone" ? folder.lastError : null };
  } catch (error) {
    if (!(error instanceof NotSetUpError)) console.error("google drive: the review list's check was not read", error instanceof Error ? error.name : "unknown error");
    return null;
  }
}
