/**
 * The folder a person names (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD4): its link as Google
 * Drive shows it (`https://drive.google.com/drive/folders/<id>`, also with `/u/<n>/` and a query such as `?usp=sharing`)
 * or its id. The link is read only for its id: it is never opened, and nothing else in it is kept. Pure.
 */

/** A folder's id as a link or a person gives it: Drive's letters, digits, `_` and `-`. */
export const FOLDER_ID = /^[A-Za-z0-9_-]{10,200}$/;

const FOLDER_PATH = /^\/drive(?:\/u\/\d{1,2})?\/folders\/([A-Za-z0-9_-]{10,200})\/?$/;

/** The folder's id in a pasted link or id; null for anything else, a file's link included. */
export function folderIdOf(given: string): string | null {
  const value = given.trim();
  if (value === "" || value.length > 2000) return null;
  if (FOLDER_ID.test(value)) return value;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname !== "drive.google.com" || url.username || url.password || url.port) return null;
  return FOLDER_PATH.exec(url.pathname)?.[1] ?? null;
}

/** The folder in Google Drive, from its checked id: the link the card shows. */
export function folderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}
