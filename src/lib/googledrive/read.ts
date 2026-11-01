import { siteOrigin } from "../auth/env";
import { orgHref } from "../auth/org-paths";
import { billsHref } from "../bills-view";
import { db, unwrap } from "../dal";
import { shownOf } from "../email-inbox/shown";
import { GoogleError, type GoogleHttp } from "../googlesheets/http";
import { chatDraftOf } from "../invoice-document/chat-draft";
import { readInvoiceDraft, type InvoiceDraftRead } from "../invoice-document/draft";
import { DocumentReadError, MAX_DOCUMENT_BYTES, type DocumentReadErrorCode } from "../invoice-document/read";
import { firstCharacters, storableText } from "../invoice-drafts/model";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { maskEmail } from "../payment-notices";
import { takeDocumentReadToken } from "../rate-limit";
import { postToWebhook } from "../slack/api";
import { mrkdwn } from "../slack/blocks";
import { workspaceOf } from "../slack/commands";
import { installFor, webhookUrlOf } from "../slack/installs";
import { downloadFile, FOLDER_MIME, listFolder, readFolder, type DriveFile } from "./drive";
import { DriveAccessError, needsReconnect, type DriveSession } from "./session";
import { noteFolderError, noteFolderRead, stillChosen, storableName, type DriveFolderRow, type FolderErrorKind } from "./store";

/**
 * Reading a workspace's Google Drive folder (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD6, GD9,
 * GD11-GD14), in the workspace's scope, with the connection's own token. The folder is read first, then listed (its own
 * files, at most 2,000); a file is new when its id is in neither the baseline nor the review list. Each new file gets its
 * row by an insert that ignores a duplicate, so two reads at once never read a file twice; then a PDF, `.eml` or `.txt`
 * of at most 4 MB is downloaded and read the way From a document reads one, held to the draft rule every chat shares,
 * and anything else is said unreadable with what to do. Five documents are read a minute per workspace: a file over
 * that gets no row and is read next time, as is whatever is left after 40 seconds. A read claims a file only while the
 * folder it started with is still the one chosen, and writes its last read or error on that choice alone (GD4). A row
 * the database does not take is skipped, never stopping the read. Nothing is added by itself: a person adds every draft
 * (GD9). The workspace's Slack channel is told, best effort.
 */

/** A read starts no new file after this long (GD6); what is left is read next time. */
export const READ_BUDGET_MS = 40_000;
/** The most files one read lists (GD6). */
export const MAX_LISTED = 2_000;
/** Ids asked about at once when finding the files already in the review list: an `in` filter goes in the URL. */
const KNOWN_CHUNK = 100;
/** A row still `received` this long after it was made was never finished: its read stopped mid-way. */
const STUCK_MS = 10 * 60_000;

const READABLE_TYPES = ["application/pdf", "message/rfc822", "text/plain"];
const GOOGLE_FILE = "application/vnd.google-apps.";
const SHORTCUT = "application/vnd.google-apps.shortcut";

type Status = "ready" | "needs_details" | "unreadable";

/** What a person reads of a file that was not read into a draft (GD6): why, and what to do. */
export const DRIVE_REASONS = {
  image: (name: string) => `It is a picture (${storableName(name, 80) || "an image"}), which Vestiarion cannot read yet. Save it as a PDF with text, or type it in with Finish and add.`,
  googleFile: "It is a Google Docs file, which has no PDF to read. Download it as PDF into the folder, or type it in with Finish and add.",
  shortcut: "It is a shortcut to a file kept elsewhere. Put the file itself in the folder, or type it in with Finish and add.",
  tooLarge: "It is larger than 4 MB. Save a smaller PDF into the folder, or type it in with Finish and add.",
  otherType: "Vestiarion reads PDF, .eml and .txt files, and this is another type. Save the invoice as a PDF with text into the folder, or type it in with Finish and add.",
  scan: "Its PDF has no text to read; it may be a scan. Save it as a PDF with text, or type it in with Finish and add.",
  unsupported: "It could not be read as an invoice. Save it again as a PDF with text, or type it in with Finish and add.",
  empty: "There is no text in it to read. Save the invoice as a PDF with text, or type it in with Finish and add.",
  gone: "It was removed from the folder, or is no longer shared with the connected Google account, before it could be read.",
  notDownloadable: "Google Drive did not let Vestiarion download it. Save a copy as a PDF into the folder, or type it in with Finish and add.",
  notFetched: "It could not be downloaded from Google Drive. Save a copy into the folder, or type it in with Finish and add.",
  unreadable: "It could not be read. Save a copy into the folder, or type it in with Finish and add.",
} as const;

/** Why a document could not be read, in the words that fit a file in a folder (GD6). */
const READ_REFUSALS: Record<DocumentReadErrorCode, string> = {
  scan: DRIVE_REASONS.scan,
  unsupported: DRIVE_REASONS.unsupported,
  empty: DRIVE_REASONS.empty,
  too_large: DRIVE_REASONS.tooLarge,
};

/** What the folder's card says of a read that did not finish (GD13). */
export const FOLDER_WORDS: Record<FolderErrorKind, string> & { forbidden: string } = {
  // The folder is read again by itself once the account can open it, and the files added meanwhile with it: choosing the
  // same folder again keeps its baseline, but only another folder needs a choice (GD5).
  folder_gone:
    "Google Drive no longer has this folder for the connected account: it was deleted, moved to the trash, or is no longer shared with it. Vestiarion reads it again by itself once that account can open it. To read another folder, an owner or admin chooses it in Settings.",
  rate_limited: "Google asked Vestiarion to slow down, so the folder was not read in full. It is read again later.",
  unavailable: "Google Drive did not answer, so the folder was not read in full. It is read again later.",
  failed: "The folder could not be read. Vestiarion tries again later.",
  forbidden: "Google refused to let Vestiarion read this folder. A Google Workspace administrator may have turned off apps like Vestiarion for this account.",
};

const IMAGE_NAME = /\.(jpe?g|png|gif|webp|heic|heif|tiff?|bmp)$/i;

/** What to do with a new file (GD6): download and read it, or say why it is not read. Pure. */
export function documentOf(file: Pick<DriveFile, "name" | "mimeType" | "size">): { read: true } | { read: false; reason: string } {
  const type = file.mimeType.toLowerCase();
  if (type === SHORTCUT) return { read: false, reason: DRIVE_REASONS.shortcut };
  // Google Docs, Sheets and Slides have no bytes to download; they are not exported (GD6).
  if (type.startsWith(GOOGLE_FILE)) return { read: false, reason: DRIVE_REASONS.googleFile };
  if (/\.(pdf|eml|txt)$/i.test(file.name) || READABLE_TYPES.includes(type)) {
    if (file.size !== null && file.size > MAX_DOCUMENT_BYTES) return { read: false, reason: DRIVE_REASONS.tooLarge };
    return { read: true };
  }
  if (type.startsWith("image/") || IMAGE_NAME.test(file.name)) return { read: false, reason: DRIVE_REASONS.image(file.name) };
  return { read: false, reason: DRIVE_REASONS.otherType };
}

/** A file's name as the row keeps it (0148: 1 to 255 characters), never half of an emoji (`storableName`). */
const fileNameOf = (file: Pick<DriveFile, "name">) => storableName(file.name, 255) || "Untitled file";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

/**
 * Who last changed the file, their email masked as a sender's is (GD8, GD14); null when Drive did not show it. The mask
 * keeps two of its first characters, which may be half of one: what is left of it is dropped.
 */
export function modifierOf(file: Pick<DriveFile, "lastModifyingUser">): string | null {
  const email = file.lastModifyingUser?.emailAddress?.trim() ?? "";
  return EMAIL.test(email) ? storableText(maskEmail(email.toLowerCase())) : null;
}

export interface DriveReadCounts {
  /** The folder's files listed, the baseline's included. */
  listed: number;
  /** New files given a row in this read. */
  found: number;
  ready: number;
  needsDetails: number;
  unreadable: number;
  /** New files left for the next read: over the read limit, or after the time ran out. */
  left: number;
}

/** `folder_changed`: another folder was chosen, or the folder forgotten on disconnect, while the read ran (GD4). */
export type DriveReadFailure = "folder_gone" | "folder_changed" | "reconnect" | "busy" | "rate_limited" | "unavailable" | "failed";

export type DriveReadOutcome =
  | { ok: true; counts: DriveReadCounts }
  /** `words`: what the folder's card now says of it, when the stop is the folder's (GD13). */
  | { ok: false; reason: DriveReadFailure; retryAfterMs: number | null; counts: DriveReadCounts; words?: string };

export interface DriveReadDeps {
  session: DriveSession;
  http: GoogleHttp;
  now?: () => number;
  budgetMs?: number;
  /** The deployment's origin, for the link in Slack. */
  origin?: string;
  /** The fetch Slack's webhook is called with. */
  fetchImpl?: typeof fetch;
}

/** A failure that stops the read, from Google or the token: what it is, and how long Google asked to wait. */
function stopOf(error: unknown): { reason: DriveReadFailure; retryAfterMs: number | null; words?: string } {
  if (needsReconnect(error)) return { reason: "reconnect", retryAfterMs: null };
  if (error instanceof DriveAccessError) {
    if (error.outcome.reason === "busy") return { reason: "busy", retryAfterMs: null };
    return { reason: "unavailable", retryAfterMs: error.outcome.reason === "unavailable" ? error.outcome.retryAfterMs : null };
  }
  if (error instanceof GoogleError) {
    if (error.failure === "rate_limited") return { reason: "rate_limited", retryAfterMs: error.retryAfterMs };
    if (error.failure === "unavailable") return { reason: "unavailable", retryAfterMs: null };
    // A folder deleted, or out of this grant's reach (GD13): 404, or a grant that no longer reaches it.
    if (error.failure === "gone" || (error.failure === "forbidden" && error.reason === "appNotAuthorizedToFile")) return { reason: "folder_gone", retryAfterMs: null };
    if (error.failure === "forbidden") return { reason: "failed", retryAfterMs: null, words: FOLDER_WORDS.forbidden };
    return { reason: "failed", retryAfterMs: null };
  }
  console.error("google drive: a read failed", error instanceof Error ? error.name : "unknown error");
  return { reason: "failed", retryAfterMs: null };
}

/** Rows left `received` by a read that stopped mid-way are said unreadable, so none waits without a reason. */
async function settleStuckRows(nowMs: number): Promise<void> {
  const settled = await db()
    .from("inbox_emails")
    .update({ status: "unreadable", reasons: [DRIVE_REASONS.unreadable] })
    .eq("source", "google_drive")
    .eq("status", "received")
    .lt("received_at", new Date(nowMs - STUCK_MS).toISOString())
    .select("id");
  if (settled.error) console.error("google drive: rows left received were not settled", settled.error.message);
}

/** The ids among `ids` already in the review list, whatever their status: a file is read once (GD6). */
async function knownFileIds(ids: readonly string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (let at = 0; at < ids.length; at += KNOWN_CHUNK) {
    const rows = unwrap(await db().from("inbox_emails").select("drive_file_id").in("drive_file_id", ids.slice(at, at + KNOWN_CHUNK))) as Array<{ drive_file_id: string | null }>;
    for (const row of rows) if (row.drive_file_id) known.add(row.drive_file_id);
  }
  return known;
}

/**
 * The new file's row (GD6), made once: `taken` when another read made it first. A row the database does not take is
 * logged by the file's id and the database's code and skipped (`refused`): one file must never stop the folder's other
 * files from being read, and it is tried again next time.
 */
async function claimRow(orgId: string, file: DriveFile, values: { status: "received" | "unreadable"; reasons: string[] }): Promise<{ id: string } | "taken" | "refused"> {
  try {
    const claimed = await db()
      .from("inbox_emails")
      .upsert(
        { source: "google_drive", drive_file_id: file.id, file_name: fileNameOf(file), from_address: modifierOf(file), status: values.status, reasons: values.reasons },
        { onConflict: "org_id,drive_file_id", ignoreDuplicates: true }
      )
      .select("id");
    if (claimed.error) {
      console.error("google drive: a file's row was not made", orgId, file.id, claimed.error.code ?? "", claimed.error.message);
      return "refused";
    }
    const id = (claimed.data as Array<{ id: string }> | null)?.[0]?.id;
    return id ? { id } : "taken";
  } catch (error) {
    console.error("google drive: a file's row was not made", orgId, file.id, error instanceof Error ? error.name : "unknown error");
    return "refused";
  }
}

/** A row taken back before its file was read, when the read stopped on Google or the token: the file is read next time. */
async function releaseRow(rowId: string): Promise<void> {
  const released = await db().from("inbox_emails").delete().eq("id", rowId).eq("status", "received").select("id");
  if (released.error) console.error("google drive: a row was not released", released.error.message);
}

/** The channel's message about a file found in the folder (GD12). */
function slackMessage(status: Status, fileName: string, read: InvoiceDraftRead | null, reasons: string[], url: string) {
  const file = mrkdwn(firstCharacters(fileName, 120));
  // Slack mrkdwn: `&amp;` shows as &.
  const line =
    status === "ready" && read
      ? `New invoice from Google Drive: *${file}*: ${mrkdwn(`${read.draft.amount ?? "?"} ${read.draft.currency ?? "USDC"}`)}, due ${mrkdwn(read.draft.dueDate ?? "?")}. A person adds it in Bills &amp; receivables; nothing is paid until then.`
      : status === "needs_details"
        ? `New invoice from Google Drive: *${file}*, but it cannot be added as it was read: ${mrkdwn(reasons[0] ?? "a field is missing")}. Finish it in Bills &amp; receivables.`
        : `A file was added to the Google Drive folder, *${file}*, but it could not be read: ${mrkdwn(reasons[0] ?? DRIVE_REASONS.unreadable)}`;
  return {
    text: line,
    blocks: [
      // Verbatim, as every Slack message's text is: a link in a file's name is never made one
      // (docs/superpowers/specs/2026-10-27-slack-review-links-design.md SR4).
      { type: "section", text: { type: "mrkdwn", text: line, verbatim: true } },
      { type: "actions", elements: [{ type: "button", action_id: "vx_open", text: { type: "plain_text", text: "Review in Bills & receivables", emoji: false }, url }] },
    ],
  };
}

/** The entry and the channel's message for a file's row, once it is settled (GD11, GD12). */
async function announce(input: { orgId: string; rowId: string; file: DriveFile; status: Status; reasons: string[]; read: InvoiceDraftRead | null }, deps: DriveReadDeps): Promise<void> {
  const { orgId, rowId, file, status, reasons, read } = input;
  await appendLedgerEntryBestEffort(orgId, {
    actor: "system",
    domain: "ap",
    action: "invoice_drive_file_received",
    summary:
      status === "ready"
        ? "A file in the Google Drive folder was read into a draft for a person to add"
        : status === "needs_details"
          ? "A file in the Google Drive folder was read; it cannot be added as it was read"
          : "A file was added to the Google Drive folder; it could not be read",
    detail: {
      inboxEmailId: rowId,
      driveFileId: file.id,
      fileName: firstCharacters(fileNameOf(file), 120),
      lastModifiedBy: modifierOf(file),
      read: status,
      document: read ? { kind: read.document.kind, sha256: read.document.sha256 } : null,
    },
  });
  // Best effort: the file is decided in Bills & receivables whether or not the channel hears of it.
  try {
    const install = await installFor(orgId);
    if (install) {
      const workspace = await workspaceOf(orgId);
      const url = `${deps.origin ?? siteOrigin()}${orgHref(workspace.slug, billsHref({ tab: "bills", review: "email" }))}`;
      await postToWebhook(webhookUrlOf(install), slackMessage(status, fileNameOf(file), read, reasons, url), deps.fetchImpl);
    }
  } catch (error) {
    console.error("google drive: Slack not told", orgId, error instanceof Error ? error.message : "unknown error");
  }
}

type FileOutcome = { settled: Status } | { stop: ReturnType<typeof stopOf> };

/** Downloads and reads one new file whose row was just made; settles the row, or releases it on a stop. */
async function readFile(orgId: string, rowId: string, file: DriveFile, deps: DriveReadDeps, nowMs: number): Promise<FileOutcome> {
  let status: Status = "unreadable";
  let reasons: string[] = [];
  let read: InvoiceDraftRead | null = null;
  let draft: unknown = null;
  let shown: unknown = null;

  let downloaded: Awaited<ReturnType<typeof downloadFile>> | null = null;
  try {
    downloaded = await deps.session.call((token) => downloadFile(token, file.id, MAX_DOCUMENT_BYTES, deps.http));
  } catch (error) {
    // The token, a rate limit or no answer stops the read, and the file is read next time (GD13).
    if (error instanceof DriveAccessError || needsReconnect(error) || (error instanceof GoogleError && (error.failure === "rate_limited" || error.failure === "unavailable"))) {
      await releaseRow(rowId);
      return { stop: stopOf(error) };
    }
    // The file alone could not be had: said on its row, and the read goes on.
    const failure = error instanceof GoogleError ? error : null;
    if (!failure) console.error("google drive: a file was not downloaded", orgId, error instanceof Error ? error.name : "unknown error");
    reasons = [
      failure?.failure === "gone"
        ? DRIVE_REASONS.gone
        : failure?.failure === "forbidden"
          ? failure.reason === "appNotAuthorizedToFile"
            ? DRIVE_REASONS.gone
            : DRIVE_REASONS.notDownloadable
          : DRIVE_REASONS.notFetched,
    ];
  }

  if (downloaded && !downloaded.ok) reasons = [DRIVE_REASONS.tooLarge];
  if (downloaded?.ok) {
    try {
      read = await readInvoiceDraft({ bytes: downloaded.bytes, name: fileNameOf(file), type: file.mimeType || downloaded.contentType }, new Date(nowMs).toISOString().slice(0, 10));
      const verdict = chatDraftOf(read);
      status = verdict.stored ? "ready" : "needs_details";
      reasons = verdict.reasons;
      draft = verdict.stored;
      // A file has no sender to know (GD8).
      shown = shownOf(read, false);
    } catch (error) {
      read = null;
      reasons = [error instanceof DocumentReadError ? READ_REFUSALS[error.code] : DRIVE_REASONS.unreadable];
      if (!(error instanceof DocumentReadError)) console.error("google drive: an invoice read failed", orgId, error instanceof Error ? error.message : "unknown error");
    }
  }

  unwrap(await db().from("inbox_emails").update({ status, reasons, read: shown, draft }).eq("id", rowId).eq("status", "received").select("id"));
  await announce({ orgId, rowId, file, status, reasons, read }, deps);
  return { settled: status };
}

/**
 * One read of the workspace's folder (GD6), with the session given. Answers what it found, or why it stopped: a folder
 * gone, Google's rate limit or no answer each leave their words on the folder (GD13); a grant Google no longer takes
 * answers `reconnect` for the caller to mark. Files left are read next time.
 */
export async function readDriveFolder(input: { orgId: string; folder: DriveFolderRow }, deps: DriveReadDeps): Promise<DriveReadOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const iso = () => new Date(now()).toISOString();
  const counts: DriveReadCounts = { listed: 0, found: 0, ready: 0, needsDetails: 0, unreadable: 0, left: 0 };
  const { folder } = input;

  const stop = async (failure: ReturnType<typeof stopOf>): Promise<DriveReadOutcome> => {
    if (failure.reason === "folder_gone" || failure.reason === "rate_limited" || failure.reason === "unavailable" || failure.reason === "failed") {
      const words = failure.words ?? FOLDER_WORDS[failure.reason];
      await noteFolderError(folder, { kind: failure.reason, words, atIso: iso() });
      return { ok: false, reason: failure.reason, retryAfterMs: failure.retryAfterMs, counts, words };
    }
    return { ok: false, reason: failure.reason, retryAfterMs: failure.retryAfterMs, counts };
  };

  await settleStuckRows(started);

  // The folder first (GD13): deleted, trashed or no longer shared, it says so and nothing else is read.
  let name: string;
  let files: DriveFile[];
  try {
    const found = await deps.session.call((token) => readFolder(token, folder.folderId, deps.http));
    if (found.mimeType !== FOLDER_MIME || found.trashed) return stop({ reason: "folder_gone", retryAfterMs: null });
    name = found.name;
    const listed = await deps.session.call((token) => listFolder(token, folder.folderId, { max: MAX_LISTED }, deps.http));
    if (listed.more) console.warn("google drive: a folder holds more files than one read lists", input.orgId);
    files = listed.files;
  } catch (error) {
    return stop(stopOf(error));
  }
  counts.listed = files.length;

  // New: in neither the baseline (GD5) nor the review list (GD6). The oldest first, so the review list fills in order.
  const baseline = new Set(folder.baseline);
  const candidates = files.filter((file) => !baseline.has(file.id));
  const known = await knownFileIds(candidates.map((file) => file.id));
  const fresh = candidates.filter((file) => !known.has(file.id)).sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? "") || a.id.localeCompare(b.id));

  for (const [index, file] of fresh.entries()) {
    if (now() - started > (deps.budgetMs ?? READ_BUDGET_MS)) {
      counts.left += fresh.length - index;
      break;
    }
    // Another folder chosen while this read ran, or the folder forgotten on disconnect: this read claims nothing more,
    // and writes nothing on the folder now chosen (GD4).
    if (!(await stillChosen(folder))) {
      counts.left += fresh.length - index;
      return { ok: false, reason: "folder_changed", retryAfterMs: null, counts };
    }
    const plan = documentOf(file);
    if (!plan.read) {
      const claimed = await claimRow(input.orgId, file, { status: "unreadable", reasons: [plan.reason] });
      if (claimed === "refused") counts.left += 1;
      if (typeof claimed === "string") continue;
      counts.found += 1;
      counts.unreadable += 1;
      await announce({ orgId: input.orgId, rowId: claimed.id, file, status: "unreadable", reasons: [plan.reason], read: null }, deps);
      continue;
    }
    // Five reads a minute per workspace (GD6): a file over that gets no row yet, and is read next time.
    if (!takeDocumentReadToken(input.orgId)) {
      counts.left += 1;
      continue;
    }
    const claimed = await claimRow(input.orgId, file, { status: "received", reasons: [] });
    if (claimed === "refused") counts.left += 1;
    if (typeof claimed === "string") continue;
    const rowId = claimed.id;
    let outcome: FileOutcome;
    try {
      outcome = await readFile(input.orgId, rowId, file, deps, now());
    } catch (error) {
      // Nothing is lost silently: the row says it could not be read.
      console.error("google drive: a file was not read", input.orgId, error instanceof Error ? error.message : "unknown error");
      await db().from("inbox_emails").update({ status: "unreadable", reasons: [DRIVE_REASONS.unreadable] }).eq("id", rowId).eq("status", "received");
      outcome = { settled: "unreadable" };
    }
    if ("stop" in outcome) {
      counts.left += fresh.length - index;
      return stop(outcome.stop);
    }
    counts.found += 1;
    if (outcome.settled === "ready") counts.ready += 1;
    else if (outcome.settled === "needs_details") counts.needsDetails += 1;
    else counts.unreadable += 1;
  }

  await noteFolderRead(folder, { atIso: iso(), name });
  return { ok: true, counts };
}
