import type { Connection } from "../connectors/connections";
import { ago, syncErrorWords } from "../connectors/status";
import { folderUrl } from "./link";
import type { DriveFolderRow } from "./store";

/**
 * What the Settings card shows of Google Drive (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD13,
 * GD15, GD16), built on the server from the connection, the folder and the review list, so the browser gets words and a
 * link built from a checked id, never a token or a full email. Pure and browser-safe: the components import this file.
 */

/**
 * The review list's Check Google Drive now (GD7, GD16): the folder it reads, and what the card says when the folder is
 * gone (GD13), null otherwise.
 */
export interface GoogleDriveCheckView {
  folderName: string;
  problem?: string | null;
}

/**
 * The card's figures (GD15): files found in the last 30 days, waiting for review now, and files a person added as bills
 * in the last 30 days, whenever they were found.
 */
export interface GoogleDriveFigures {
  read30d: number;
  waiting: number;
  added30d: number;
}

export interface GoogleDriveFolderView {
  id: string;
  name: string;
  /** The folder in Google Drive. */
  url: string;
  /** "Nov 1": when it was chosen. */
  chosenOn: string;
  /** The files already in it when it was chosen, left as they were (GD5). */
  baseline: number;
  /** "Last read 3 minutes ago." or "Not read yet. Vestiarion reads it within 15 minutes." */
  lastRead: string;
  /** What the last read that did not finish says (GD13); null when the last read finished. */
  problem: string | null;
  /**
   * The folder is gone (deleted, trashed or no longer shared): the card says so in red, beside choosing another folder.
   * It is read again by itself once the account can open it (GD13).
   */
  askAgain: boolean;
}

export type GoogleDrivePanelView =
  | { state: "not_set_up" }
  | { state: "not_connected" }
  | { state: "connected"; account: string; connectedAt: string; folder: GoogleDriveFolderView | null; figures: GoogleDriveFigures }
  | { state: "needs_reconnect"; account: string; words: string }
  | { state: "revoked"; account: string };

/** The account when Google gave no email (as Google Sheets', GS6). */
export const NO_ACCOUNT_NAME = "A Google account";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 1", in UTC, built by hand so a server render and the browser read the same words. */
function cardDay(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

export function googleDriveFolderView(folder: DriveFolderRow, nowMs: number): GoogleDriveFolderView {
  return {
    id: folder.folderId,
    name: folder.folderName,
    url: folderUrl(folder.folderId),
    chosenOn: cardDay(folder.chosenAt),
    baseline: folder.baseline.length,
    lastRead: folder.lastReadAt ? `Last read ${ago(folder.lastReadAt, nowMs)}.` : "Not read yet. Vestiarion reads it within 15 minutes.",
    problem: folder.lastError,
    askAgain: folder.lastErrorKind === "folder_gone",
  };
}

/** The card's state from the workspace's connection and folder: a null connection is one never connected. */
export function googleDrivePanelView(input: { connection: Connection | null; folder: DriveFolderRow | null; figures: GoogleDriveFigures; nowMs: number }): GoogleDrivePanelView {
  const { connection } = input;
  if (!connection) return { state: "not_connected" };
  const account = connection.externalOrgName ?? NO_ACCOUNT_NAME;
  if (connection.status === "revoked") return { state: "revoked", account };
  if (connection.status === "needs_reconnect") return { state: "needs_reconnect", account, words: connection.lastError ?? syncErrorWords("reconnect", "Google Drive", null) };
  // A folder chosen through another connection (an account since replaced) is not this one's.
  const folder = input.folder && input.folder.connectionId === connection.id ? googleDriveFolderView(input.folder, input.nowMs) : null;
  return { state: "connected", account, connectedAt: cardDay(connection.connectedAt), folder, figures: input.figures };
}
