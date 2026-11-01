import type { InboxSource } from "./list";

/**
 * What the review list on Bills & receivables is called, by what brought its rows (email invoices design E7;
 * docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD8): the invoices that came by email, the files found
 * in the workspace's Google Drive folder, or both. Pure and browser-safe: the page and the list both use it.
 */

const sourcesOf = (sources: readonly InboxSource[]) => ({
  email: sources.filter((source) => source === "email").length,
  drive: sources.filter((source) => source === "google_drive").length,
});

/**
 * The list's title: "From email", "From Google Drive", or "From email and Google Drive". A list that offers to check a
 * Google Drive folder (`readsFolder`) is named for it, whatever waits in it now.
 */
export function reviewListTitle(sources: readonly InboxSource[], readsFolder = false): string {
  const { email, drive } = sourcesOf(sources);
  const fromDrive = drive > 0 || readsFolder;
  if (email > 0 && fromDrive) return "From email and Google Drive";
  return fromDrive ? "From Google Drive" : "From email";
}

/** What Waiting for review says of the list: "2 by email", "1 from Google Drive", or "2 by email, 1 from Google Drive". */
export function reviewCountLabel(sources: readonly InboxSource[]): string {
  const { email, drive } = sourcesOf(sources);
  if (email > 0 && drive > 0) return `${email} by email, ${drive} from Google Drive`;
  return drive > 0 ? `${drive} from Google Drive` : `${email} by email`;
}

/** Where the list's rows came from, after their count in its header. */
export function reviewListWhere(sources: readonly InboxSource[]): string {
  const { email, drive } = sourcesOf(sources);
  if (email > 0 && drive > 0) return "sent to this workspace's invoice address or added to its Google Drive folder";
  return drive > 0 ? "added to this workspace's Google Drive folder" : "sent to this workspace's invoice address";
}
