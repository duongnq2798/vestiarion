"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { connectionFor, disconnectConnection, NotSetUpError } from "@/lib/connectors/connections";
import { inOrg } from "@/lib/dal/scope";
import { chooseDriveFolder, type ChooseFolderRefusal } from "@/lib/googledrive/folder";
import { folderUrl } from "@/lib/googledrive/link";
import { googleDriveProvider } from "@/lib/googledrive/provider";
import type { DriveReadCounts } from "@/lib/googledrive/read";
import { googleDriveSettingsFromEnv } from "@/lib/googledrive/settings";
import { forgetFolder } from "@/lib/googledrive/store";
import { googleDriveContext, mayRevokeAtGoogle, syncGoogleDriveConnection, type DriveSync } from "@/lib/googledrive/workspace";

/**
 * Google Drive from the console (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD2, GD4, GD7, GD16):
 * choosing the folder and disconnecting are an owner's or admin's (`integrations.manage`); Check Google Drive now is for
 * whoever adds the invoices it finds (`records.write`, as `invoice.add`), in Settings and in the review list. Each reads
 * the person's role again and works in the workspace's scope; nothing returned carries a token or a full email, and the
 * only link is the folder's, built from its checked id.
 */

export interface GoogleDriveActionResult {
  ok: boolean;
  message: string;
}

/** Choose: the folder now read, when it was chosen. */
export interface GoogleDriveFolderResult extends GoogleDriveActionResult {
  folder?: { name: string; url: string; baseline: number };
}

/** Check Google Drive now: what the read found, when it ran. */
export interface GoogleDriveCheckResult extends GoogleDriveActionResult {
  counts?: DriveReadCounts;
}

const TRY_AGAIN = "That did not work. Try again in a moment.";
const NOT_SET_UP = "Google Drive is not set up on this deployment yet.";
const NOT_CONNECTED = "Google Drive is not connected to this workspace.";
const RECONNECT = "Google Drive needs you to reconnect. An owner or admin can reconnect it in Settings.";

const text = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
};

const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;

/** What each folder that could not be chosen answers (GD4, GD5). */
function chooseWords(reason: ChooseFolderRefusal, account: string | undefined): string {
  switch (reason) {
    case "not_a_link":
      return "Paste the folder's link from Google Drive (drive.google.com/drive/folders/...), or its ID.";
    case "off":
    case "not_set_up":
      return NOT_SET_UP;
    case "not_connected":
      return NOT_CONNECTED;
    case "reconnect":
      return RECONNECT;
    case "not_found":
      return `Google Drive has no folder at that link that ${account ?? "the connected Google account"} can open. Check the link, and that the folder is shared with that account.`;
    case "not_a_folder":
      return "That link is to a file, not a folder. Paste the link of the folder the bills are saved in.";
    case "trashed":
      return "That folder is in the trash in Google Drive. Restore it, or choose another folder.";
    case "too_many":
      return "That folder holds more than 1,000 files. Choose a new, empty folder, or one with at most 1,000 files.";
    case "forbidden":
      return "Google refused to let Vestiarion read that folder. A Google Workspace administrator may have turned off apps like Vestiarion for this account.";
    case "rate_limited":
      return "Google asked Vestiarion to slow down. Try again in a minute.";
    case "unavailable":
      return "Google did not answer. Try again in a moment.";
    case "failed":
      return TRY_AGAIN;
  }
}

/**
 * What a folder chosen answers (GD4, GD5): an empty one names no files left as they are, and the folder already read,
 * chosen again, keeps the files it left then.
 */
function chosenWords(name: string, baseline: number, again: boolean): string {
  const verb = baseline === 1 ? "is" : "are";
  const kept = baseline === 1 ? "it is" : "they are";
  if (again) {
    const then = baseline === 0 ? "" : `; the ${files(baseline)} in it then ${verb} still left as ${kept}`;
    return `Vestiarion reads ${name} again. Files added to it since it was first chosen come in for review on Bills & receivables${then}.`;
  }
  const already = baseline === 0 ? "" : `; the ${files(baseline)} already in it ${verb} left as ${kept}`;
  return `Vestiarion now reads ${name}. Files added to it from now on come in for review on Bills & receivables${already}.`;
}

/**
 * Choose (GD4, GD5): the folder a pasted link or ID names (`folder`), read once through the connection, in place of any
 * chosen before, with the files already in it left as they are.
 */
export async function chooseGoogleDriveFolderAction(_previous: GoogleDriveFolderResult, formData: FormData): Promise<GoogleDriveFolderResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const outcome = await chooseDriveFolder({ given: text(formData, "folder"), by: auth.user.id });
      if (!outcome.ok) {
        if (outcome.reason === "reconnect") revalidateOrgPages();
        return { ok: false, message: chooseWords(outcome.reason, outcome.account) };
      }
      revalidateOrgPages();
      const { folder } = outcome;
      const baseline = folder.baseline.length;
      return {
        ok: true,
        message: chosenWords(folder.folderName, baseline, outcome.again),
        folder: { name: folder.folderName, url: folderUrl(folder.folderId), baseline },
      };
    } catch (error) {
      console.error("chooseGoogleDriveFolderAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** What a read that ran answers (GD6, GD7). */
function checkedWords(sync: DriveSync & { counts: DriveReadCounts }): string {
  const { counts } = sync;
  const where = sync.folderName ?? "the folder";
  const left = counts.left > 0 ? ` ${files(counts.left)} more ${counts.left === 1 ? "is" : "are"} read next time.` : "";
  if (counts.found === 0) return counts.left > 0 ? `Checked ${where}.${left}` : `Checked ${where}. No new file.`;
  return `Found ${files(counts.found)} in ${where}. ${counts.found === 1 ? "It waits" : "They wait"} in the review list on Bills & receivables.${left}`;
}

/**
 * Check Google Drive now (GD7): one read of the folder, as the sweeper's, within its 40-second stop; whatever is left is
 * read next time. Answers what it found.
 */
export async function checkGoogleDriveNowAction(_previous: GoogleDriveCheckResult, formData: FormData): Promise<GoogleDriveCheckResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const found = await googleDriveContext();
      if ("missing" in found) {
        return { ok: false, message: found.missing === "reconnect" ? RECONNECT : found.missing === "not_connected" ? NOT_CONNECTED : NOT_SET_UP };
      }
      const sync = await syncGoogleDriveConnection(found.connection.id, found.provider);
      revalidateOrgPages();
      if (sync.outcome === "synced" && sync.folder === "none") return { ok: false, message: "No folder is chosen yet. An owner or admin chooses it on the Google Drive card in Settings." };
      if (sync.outcome === "synced" && sync.folder === "gone") return { ok: false, message: sync.words ?? TRY_AGAIN };
      if (sync.outcome === "synced" && sync.folder === "changed") {
        return { ok: false, message: "The folder was changed while it was read. The folder now chosen is read within 15 minutes, or check again now." };
      }
      if (sync.outcome === "synced" && sync.counts) return { ok: true, message: checkedWords({ ...sync, counts: sync.counts }), counts: sync.counts };
      if (sync.outcome === "busy") return { ok: false, message: "A read is running already. Look again in a minute." };
      if (sync.outcome === "reconnect") return { ok: false, message: RECONNECT };
      return { ok: false, message: sync.words ?? TRY_AGAIN, ...(sync.counts ? { counts: sync.counts } : {}) };
    } catch (error) {
      console.error("checkGoogleDriveNowAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/**
 * Disconnect Google Drive (GD2): the grant is revoked at Google unless the same Google account is still connected
 * elsewhere in Vestiarion (`mayRevokeAtGoogle`); either way the tokens are deleted, the connection marked revoked,
 * `accounting_disconnected` signed, and the folder forgotten. The files already read stay in the review list.
 */
export async function disconnectGoogleDriveAction(_previous: GoogleDriveActionResult, formData: FormData): Promise<GoogleDriveActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const connection = await connectionFor("googledrive");
      if (!connection || connection.status === "revoked") return { ok: false, message: NOT_CONNECTED };
      const revoke = await mayRevokeAtGoogle(connection);
      const settings = googleDriveSettingsFromEnv();
      const provider = settings && revoke ? googleDriveProvider(settings) : null;
      const { revokedAtProvider } = await disconnectConnection({ connection, by: auth.user.id, revoke: provider ? provider.revoke : async () => false });
      try {
        await forgetFolder();
      } catch (error) {
        console.error("google drive: the folder was not forgotten", error instanceof Error ? error.message : "unknown error");
      }
      revalidateOrgPages();
      if (!revoke) {
        return {
          ok: true,
          message:
            "Google Drive is disconnected from this workspace. The same Google account is still connected elsewhere in Vestiarion, so its access stays until you remove it in that Google Account's settings. Files already read stay in the review list.",
        };
      }
      if (!revokedAtProvider) {
        return {
          ok: true,
          message: "Google Drive is disconnected and its tokens are deleted. Google did not confirm the revoke, so remove Vestiarion in that Google Account's settings to be sure.",
        };
      }
      return { ok: true, message: "Google Drive is disconnected. Files already read stay in the review list on Bills & receivables." };
    } catch (error) {
      if (error instanceof NotSetUpError) return { ok: false, message: NOT_SET_UP };
      console.error("disconnectGoogleDriveAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}
