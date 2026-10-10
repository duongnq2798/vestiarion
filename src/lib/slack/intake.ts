import type { Actor } from "../commands/actor";
import { addInvoice } from "../commands/invoices";
import { gate } from "../commands/policy";
import { platformDb, unwrap } from "../dal";
import { chatDraftOf, invoiceOfDraft, type StoredChatDraft } from "../invoice-document/chat-draft";
import { readInvoiceDraft, type InvoiceDraftRead } from "../invoice-document/draft";
import { DocumentReadError, MAX_DOCUMENT_BYTES, type DocumentInput } from "../invoice-document/read";
import { takeDocumentReadToken } from "../rate-limit";
import { masterKeysFromEnv, type MasterKey } from "../secrets";
import { orgHref } from "../auth/org-paths";
import { downloadSlackFile, type SlackMessage } from "./api";
import { DRAFT_USED, draftAnswer, draftOutcome, missingAnswer, mrkdwn, textAnswer } from "./blocks";
import { botTokenOf, type SlackInstall } from "./installs";
import type { SlackLink } from "./links";

/**
 * An invoice someone chose in Slack with "Add invoice" on a message (Slack design S15): read the way
 * **From a document** reads one, held as a draft for an hour, and added as a payable only when the same member presses
 * Add on the answer only they see. Only an owner or admin, whose role is read again at the press. The file is fetched
 * from Slack's own file host with the install's token, which needs `files:read`: an install made before it asks for
 * Slack to be connected again. The message's own text is read when it holds no file. The rule for what a read may
 * become is the one every chat shares (src/lib/invoice-document/chat-draft.ts). Each function runs inside the link's
 * workspace's scope.
 */

/** How long a draft waits for its Add. */
export const DRAFT_TTL_MS = 3_600_000;

/** What the chosen message holds, as Slack describes it. */
export interface ChosenMessage {
  files: Array<{ name: string; mimetype: string; size: number; url: string }>;
  text: string;
}

export interface SlackIntakeDeps {
  origin: string;
  workspace: { slug: string; name: string };
  fetchImpl?: typeof fetch;
  keys?: MasterKey[];
  now?: () => Date;
}

const RECONNECT =
  "Vestiarion cannot open files in this Slack yet. An owner or admin chooses *Reconnect Slack* in Settings once, to let it read the invoices you choose.";
// Slack mrkdwn: `&amp;` shows as &.
const NOT_OPENED = "The file could not be opened from Slack. Add it in Vestiarion instead: From a document, on Bills &amp; receivables.";
// Slack lets the app read a file only in a conversation it is in, so a refusal after the permission is granted means that.
const NOT_IN_CHANNEL =
  "Vestiarion cannot open this file: Slack lets it read files only in channels it is in. Type `/invite @Vestiarion` in this channel and choose *Add invoice* again, or add the invoice in Vestiarion: From a document, on Bills &amp; receivables.";
const UNREACHABLE = "Slack could not be reached. Try again in a moment.";
const SLOW_DOWN = "That is five invoices read this minute. Try again in a few seconds.";
const UNREADABLE = "The invoice could not be read. Try again in a moment.";

/** A file the reader can read: a PDF, an email, or text, by its name or its type. */
function readable(file: ChosenMessage["files"][number]): boolean {
  return /\.(pdf|eml|txt)$/i.test(file.name) || ["application/pdf", "message/rfc822", "text/plain"].includes(file.mimetype);
}

/** Why the member may not add invoices from Slack, in their workspace's words. */
function roleRefusal(actor: Actor, workspaceName: string): string {
  return `Only an owner or admin can add invoices. Your role in *${mrkdwn(workspaceName)}* is ${actor.role}.`;
}

type Chosen = { ok: true; input: DocumentInput } | { ok: false; answer: SlackMessage };
const nothing = (text: string): Chosen => ({ ok: false, answer: textAnswer(text) });

/** What to read: the first invoice file, fetched from Slack; else the message's text; else why there is nothing. */
async function chosenInput(install: SlackInstall, chosen: ChosenMessage, deps: SlackIntakeDeps): Promise<Chosen> {
  const file = chosen.files.find(readable);
  if (!file) {
    if (chosen.files.length === 0 && chosen.text.trim()) return { ok: true, input: { text: chosen.text } };
    return nothing(new DocumentReadError("unsupported").message);
  }
  if (file.size > MAX_DOCUMENT_BYTES) return nothing(new DocumentReadError("too_large").message);
  // An install made before its permissions were kept has none recorded: it may well read files, so it tries.
  if (install.scopes.length > 0 && !install.scopes.includes("files:read")) return nothing(RECONNECT);
  const fetched = await downloadSlackFile(file.url, botTokenOf(install, deps.keys ?? masterKeysFromEnv()), MAX_DOCUMENT_BYTES, deps.fetchImpl);
  if (!fetched.ok) {
    if (fetched.reason === "no_access") return nothing(install.scopes.length === 0 ? RECONNECT : NOT_IN_CHANNEL);
    if (fetched.reason === "too_large") return nothing(new DocumentReadError("too_large").message);
    return nothing(fetched.reason === "unreachable" ? UNREACHABLE : NOT_OPENED);
  }
  return { ok: true, input: { bytes: fetched.bytes, name: file.name, type: file.mimetype || fetched.contentType } };
}

/** Reads the chosen invoice into a draft and offers to add it, or says why it cannot be added from Slack. */
export async function readChosenInvoice(
  install: SlackInstall,
  link: SlackLink,
  actor: Actor,
  chosen: ChosenMessage,
  deps: SlackIntakeDeps
): Promise<SlackMessage> {
  if (gate(actor, "invoice.add")) return textAnswer(roleRefusal(actor, deps.workspace.name));
  const chosenRead = await chosenInput(install, chosen, deps);
  if (!chosenRead.ok) return chosenRead.answer;
  if (!takeDocumentReadToken(link.orgId)) return textAnswer(SLOW_DOWN);

  const now = deps.now?.() ?? new Date();
  let read: InvoiceDraftRead;
  try {
    read = await readInvoiceDraft(chosenRead.input, now.toISOString().slice(0, 10));
  } catch (error) {
    if (error instanceof DocumentReadError) return textAnswer(mrkdwn(error.message));
    console.error("slack: invoice read failed", link.orgId, error instanceof Error ? error.message : "unknown error");
    return textAnswer(UNREADABLE);
  }

  const { reasons, stored } = chatDraftOf(read);
  if (!stored) return missingAnswer(read, reasons, `${deps.origin}${orgHref(deps.workspace.slug, "/invoices")}`);
  const draft = unwrap(
    await platformDb()
      .from("slack_drafts")
      .insert({ link_id: link.id, ...stored, expires_at: new Date(now.getTime() + DRAFT_TTL_MS).toISOString() })
      .select("id")
      .single<{ id: string }>()
  );
  return draftAnswer(read, draft.id);
}

/** Uses a draft up: once, before its hour is over, and only through the link it was read for. */
async function claimDraft(link: SlackLink, draftId: string, now: Date): Promise<StoredChatDraft | null> {
  const rows = unwrap(
    await platformDb()
      .from("slack_drafts")
      .update({ used_at: now.toISOString() })
      .eq("id", draftId)
      .eq("link_id", link.id)
      .is("used_at", null)
      .gt("expires_at", now.toISOString())
      .select("draft, document")
  ) as StoredChatDraft[];
  return rows[0] ?? null;
}

/**
 * Adds the draft as a payable, as the member, through the command every surface shares (integrations design §9), which
 * records Slack and the link in the entry and starts the agent's cycle.
 */
export async function addChosenDraft(
  install: SlackInstall,
  link: SlackLink,
  actor: Actor,
  press: { draftId: string; goodsReceived: boolean },
  deps: Pick<SlackIntakeDeps, "workspace" | "now">
): Promise<SlackMessage> {
  // Asked before the draft is claimed, so a refused press leaves it for someone who may add it.
  if (gate(actor, "invoice.add")) return draftOutcome(roleRefusal(actor, deps.workspace.name));
  const stored = await claimDraft(link, press.draftId, deps.now?.() ?? new Date());
  if (!stored) return draftOutcome(DRAFT_USED);

  const invoice = invoiceOfDraft(stored, press.goodsReceived);
  const added = invoice ? await addInvoice(actor, { invoice, document: { ...stored.document, changed: [] } }) : null;
  if (!invoice || !added?.ok) {
    const reason = added && !added.ok && added.code !== "counterparty_not_found" ? mrkdwn(added.message) : null;
    return draftOutcome(reason ?? "The invoice could not be added: its counterparty is no longer in this workspace. Add it in Vestiarion.");
  }
  const where = install.channelName ? mrkdwn(install.channelName) : "the channel Vestiarion posts to";
  return draftOutcome(
    `Added a payable for ${mrkdwn(added.counterpartyName)}: ${mrkdwn(`${invoice.amount} ${invoice.currency}`)}, due ${mrkdwn(invoice.dueDate)}, ` +
      `${press.goodsReceived ? "goods received" : "goods not received yet"}. The agent usually decides within a minute, and its decision will be posted in ${where}.`
  );
}

/** Drops the draft unused. */
export async function cancelChosenDraft(link: SlackLink, draftId: string, deps: Pick<SlackIntakeDeps, "now">): Promise<SlackMessage> {
  const stored = await claimDraft(link, draftId, deps.now?.() ?? new Date());
  return draftOutcome(stored ? "Not added." : DRAFT_USED);
}
