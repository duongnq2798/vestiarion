import { DRIVE_API, GoogleError, apiInit, googleCall, jsonOf, type GoogleHttp } from "../googlesheets/http";
import { FOLDER_ID } from "./link";

/**
 * The three Drive reads Google Drive intake makes (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD4,
 * GD6, GD13), each through Google Sheets' `googleCall`: Google's own hosts only, at most one retry, a short rate limit
 * waited out once, and a refusal named by Google's reason code, never its message. Every path is built from an id this
 * file checked; nothing Google answers is used before it is checked too. A 401 is thrown for the caller to refresh its
 * token once (`session.ts`). Shared drives are read as My Drive is (`supportsAllDrives`).
 */

/** A folder's `mimeType` (GD4). */
export const FOLDER_MIME = "application/vnd.google-apps.folder";
/** A file's id, as Drive answers it and inbox_emails keeps it (0148). */
export const FILE_ID = /^[A-Za-z0-9_-]{1,200}$/;
/** A shared drive's id. */
const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** What a folder read says (GD4): its id, name and type, whether it is in the trash, and its shared drive. */
export interface DriveFolder {
  id: string;
  name: string;
  mimeType: string;
  trashed: boolean;
  /** The shared drive it is in; null in My Drive. */
  driveId: string | null;
}

/** One file of the folder as a listing names it (GD6). */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Bytes, where Drive has them: a Google Docs file has none. */
  size: number | null;
  md5Checksum: string | null;
  createdTime: string | null;
  modifiedTime: string | null;
  /** Who last changed it, as Drive says; the email only when Drive shows it to this account. */
  lastModifyingUser: { displayName: string | null; emailAddress: string | null } | null;
}

/**
 * `files.get` on the folder (GD4): `gone` when Drive has none this account can open (404, or a grant that no longer
 * reaches it), else what it says. The caller checks it is a folder and not in the trash.
 */
export async function readFolder(token: string, folderId: string, deps: GoogleHttp = {}): Promise<DriveFolder> {
  if (!FOLDER_ID.test(folderId)) throw new GoogleError("bad_response", "Google files.get: not a folder id");
  const url = new URL(`${DRIVE_API}/files/${folderId}`);
  url.searchParams.set("fields", "id, name, mimeType, trashed, driveId");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await googleCall({ url: url.toString(), init: apiInit(token, "GET"), label: "files.get", repeatable: true, onFile: true }, deps);
  const body = await jsonOf(response, "files.get");
  if (!isObject(body) || body.id !== folderId) throw new GoogleError("bad_response", "Google files.get: not the folder asked for");
  const driveId = text(body.driveId);
  return {
    id: folderId,
    name: text(body.name).trim(),
    mimeType: text(body.mimeType),
    trashed: body.trashed === true,
    driveId: DRIVE_ID.test(driveId) ? driveId : null,
  };
}

/** A size Drive writes as a string of digits (an int64), or null. */
function sizeOf(value: unknown): number | null {
  const digits = typeof value === "number" ? String(value) : text(value);
  if (!/^\d{1,15}$/.test(digits)) return null;
  return Number(digits);
}

function fileOf(value: unknown): DriveFile | null {
  if (!isObject(value)) return null;
  const id = text(value.id);
  // A file whose id does not read is never kept, nor a path built from it.
  if (!FILE_ID.test(id)) return null;
  const user = isObject(value.lastModifyingUser) ? value.lastModifyingUser : null;
  return {
    id,
    name: text(value.name),
    mimeType: text(value.mimeType),
    size: sizeOf(value.size),
    md5Checksum: /^[0-9a-f]{32}$/.test(text(value.md5Checksum)) ? text(value.md5Checksum) : null,
    createdTime: text(value.createdTime) || null,
    modifiedTime: text(value.modifiedTime) || null,
    lastModifyingUser: user ? { displayName: text(user.displayName) || null, emailAddress: text(user.emailAddress) || null } : null,
  };
}

/** The most files one listing call asks for, Drive's own most (GD6). */
export const PAGE_SIZE = 1000;
/** A listing stops after this many pages, whatever Drive says: Drive may answer pages shorter than asked. */
const MAX_PAGES = 20;

/**
 * The folder's own files, newest first (GD5, GD6): not its subfolders, nothing in the trash, from a shared drive too.
 * Pages are read until more than `max` files are seen or Drive has no more; `more` says the folder holds more than
 * `max` (or more pages than are read), and `files` holds at most `max`. The folder's id is checked before it is put in
 * the query, so nothing a person typed reaches it.
 */
export async function listFolder(token: string, folderId: string, input: { max: number }, deps: GoogleHttp = {}): Promise<{ files: DriveFile[]; more: boolean }> {
  if (!FOLDER_ID.test(folderId)) throw new GoogleError("bad_response", "Google files.list: not a folder id");
  const files: DriveFile[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set("q", `'${folderId}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`);
    url.searchParams.set("fields", "nextPageToken, files(id, name, mimeType, size, md5Checksum, createdTime, modifiedTime, lastModifyingUser(displayName, emailAddress))");
    url.searchParams.set("orderBy", "createdTime desc");
    url.searchParams.set("pageSize", String(Math.min(PAGE_SIZE, input.max + 1 - files.length)));
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await googleCall({ url: url.toString(), init: apiInit(token, "GET"), label: "files.list", repeatable: true, onFile: true }, deps);
    const body = await jsonOf(response, "files.list");
    if (!isObject(body) || !Array.isArray(body.files)) throw new GoogleError("bad_response", "Google files.list: no files");
    for (const item of body.files) {
      const file = fileOf(item);
      if (file) files.push(file);
    }
    if (files.length > input.max) return { files: files.slice(0, input.max), more: true };
    const next = text(body.nextPageToken);
    if (!next) return { files, more: false };
    pageToken = next;
  }
  return { files, more: true };
}

export type DownloadOutcome = { ok: true; bytes: Uint8Array; contentType: string } | { ok: false; reason: "too_large" };

/**
 * A file's bytes (GD6), `alt=media`: at most `maxBytes`, held to it while the body streams in, so a file larger than it
 * says is never read whole. A refusal throws its `GoogleError` (`gone` for a 404).
 */
export async function downloadFile(token: string, fileId: string, maxBytes: number, deps: GoogleHttp = {}): Promise<DownloadOutcome> {
  if (!FILE_ID.test(fileId)) throw new GoogleError("bad_response", "Google files.download: not a file id");
  const url = new URL(`${DRIVE_API}/files/${fileId}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await googleCall(
    { url: url.toString(), init: { method: "GET", headers: { authorization: `Bearer ${token}` } }, label: "files.download", repeatable: true, onFile: true },
    deps
  );
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (Number(response.headers.get("content-length") ?? "0") > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, reason: "too_large" };
  }
  const reader = response.body?.getReader();
  if (!reader) return { ok: true, bytes: new Uint8Array(0), contentType };
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    throw new GoogleError("unavailable", "Google files.download: the body did not arrive");
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { ok: true, bytes, contentType };
}
