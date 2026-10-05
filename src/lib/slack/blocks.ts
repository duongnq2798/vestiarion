import type { ActivityItem } from "../agent-activity";
import { orgHref } from "../auth/org-paths";
import type { CommandOutcome } from "../commands/outcome";
import { READER_NAMES } from "../invoice-document/chat-draft";
import type { InvoiceDraftRead } from "../invoice-document/draft";
import type { VerificationResult } from "../ledger";
import { txUrl } from "../payee-chains";
import type { Network } from "../network";
import { shortenAddresses } from "../telegram/messages";
import type { TodayFacts, WaitingFact } from "../telegram/today";
import type { SlackMessage } from "./api";

/**
 * What Slack shows (Slack design S6–S8, S10, S14), as Block Kit. Every value passes through `mrkdwn`, which escapes
 * Slack's three characters and shortens a wallet address to its first and last four; every link is absolute. A stopped
 * payable carries its buttons only when deciding from Slack is on (a card is given), Approve only when the payable
 * qualifies, and the two buttons that act are confirmed by Slack first. Pure: the callers read the facts and post.
 */

/** Decisions told one by one in a message; the rest are counted, and left to the console. Keeps a message under 50 blocks. */
export const ITEMS_SHOWN = 10;
/** Slack takes 3,000 characters in a section; the rest is room to spare. */
const TEXT_MAX = 2900;

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const COUNT = new Intl.NumberFormat("en-US");

/** A value as Slack's mrkdwn shows it: `&`, `<` and `>` escaped, and a wallet address shortened (S14). */
export function mrkdwn(value: string): string {
  return shortenAddresses(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

const link = (url: string, label: string) => `<${url}|${mrkdwn(label)}>`;
const orgUrl = (origin: string, slug: string, path: string) => `${origin}${orgHref(slug, path)}`;
const amountText = (amount: number | string, currency: string) => `${AMOUNT.format(Number(amount))} ${currency}`;

/** A UTC day as "Oct 5". */
function shortDay(day: string): string {
  return new Date(`${day.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "2026-10-03 07:55 UTC". */
function utcMinute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const plain = (text: string) => ({ type: "plain_text", text, emoji: false });
const section = (text: string, blockId?: string) => ({ type: "section", ...(blockId ? { block_id: blockId } : {}), text: { type: "mrkdwn", text: clip(text, TEXT_MAX) } });
const context = (text: string, blockId?: string) => ({
  type: "context",
  ...(blockId ? { block_id: blockId } : {}),
  elements: [{ type: "mrkdwn", text: clip(text, TEXT_MAX) }],
});
const urlButton = (actionId: string, label: string, url: string) => ({ type: "button", action_id: actionId, text: plain(label), url });

/** What a stopped payable's buttons carry and say, as the cycle's stage worked them out (S8, S9). */
export interface CardView {
  invoiceId: string;
  /** The signed card (`vx1.…`) each button carries. */
  token: string;
  /** Why Approve and pay is not offered from Slack; null when it is. */
  approveRefusal: string | null;
  /** What Approve and pay will do, for Slack's confirmation: the amount, the payee, the address shortened. */
  confirmText: string;
}

function itemBlocks(item: ActivityItem, workspace: { slug: string }, origin: string, card: CardView | undefined): unknown[] {
  const blocks: unknown[] = [section(mrkdwn(item.text))];
  if (item.detail) blocks.push(context(mrkdwn(item.detail)));
  const open = urlButton("vx_open", item.pathLabel, orgUrl(origin, workspace.slug, item.path));
  if (!card) {
    const buttons = item.txUrl ? [urlButton("vx_tx", "Arc testnet transaction", item.txUrl ?? ""), open] : [open];
    blocks.push({ type: "actions", elements: buttons });
    return blocks;
  }
  const buttons: unknown[] = [];
  if (card.approveRefusal === null) {
    buttons.push({
      type: "button",
      action_id: "vx_approve",
      text: plain("Approve and pay"),
      style: "primary",
      value: card.token,
      confirm: { title: plain("Approve and pay?"), text: { type: "mrkdwn", text: mrkdwn(card.confirmText) }, confirm: plain("Approve and pay"), deny: plain("Cancel") },
    });
  }
  buttons.push({
    type: "button",
    action_id: "vx_reject",
    text: plain("Reject"),
    style: "danger",
    value: card.token,
    confirm: {
      title: plain("Reject this payable?"),
      text: { type: "mrkdwn", text: "It will not be paid, and the agent does not look at it again." },
      confirm: plain("Reject"),
      deny: plain("Cancel"),
    },
  });
  buttons.push({ type: "button", action_id: "vx_return", text: plain("Return to the agent"), value: card.token });
  buttons.push(open);
  blocks.push({ type: "actions", block_id: `payable-${card.invoiceId}`, elements: buttons });
  if (card.approveRefusal !== null) blocks.push(context(`Approve it in Vestiarion: ${mrkdwn(card.approveRefusal)}`, `why-${card.invoiceId}`));
  return blocks;
}

/**
 * The agent's decisions since the channel was last told (S7): one block group each, with its reasons, its transaction
 * and its page; a stopped payable's card when `cards` names it. Decisions past `ITEMS_SHOWN` are counted and left to
 * the console. `cards` is null while deciding from Slack is off.
 */
export function decisionsMessage(
  workspace: { name: string; slug: string },
  items: ActivityItem[],
  origin: string,
  cards: ReadonlyMap<string, CardView> | null
): SlackMessage {
  const count = items.length === 1 ? "1 thing" : `${items.length} things`;
  const blocks: unknown[] = [section(`*${mrkdwn(workspace.name)}* · the agent decided ${count}`)];
  const shown = items.slice(0, ITEMS_SHOWN);
  for (const item of shown) {
    const card = item.tone === "stopped" && item.invoiceId ? cards?.get(item.invoiceId) : undefined;
    blocks.push(...itemBlocks(item, workspace, origin, card));
  }
  if (items.length > shown.length) {
    blocks.push(section(`…and ${items.length - shown.length} more in ${link(orgUrl(origin, workspace.slug, "/console"), "the console")}.`));
  }
  return { text: `${mrkdwn(workspace.name)}: the agent decided ${count}`, blocks };
}

/** A decided card: the payable's buttons, and the reason Approve was missing, become one line saying who did what (S10). */
export function withOutcome(blocks: unknown[], invoiceId: string, line: string): unknown[] {
  return blocks.flatMap((block) => {
    const id = (block as { block_id?: unknown }).block_id;
    if (id === `why-${invoiceId}`) return [];
    if (id === `payable-${invoiceId}`) return [{ type: "context", block_id: id, elements: [{ type: "mrkdwn", text: line }] }];
    return [block];
  });
}

/**
 * A card one person approved, of a payment that needs two (two approvals T8): its buttons stay for the second approval,
 * with who approved just above them. A later approval that still did not pay replaces that line.
 */
export function withApprovalGiven(blocks: unknown[], invoiceId: string, line: string): unknown[] {
  const id = `approved-${invoiceId}`;
  const kept = blocks.filter((block) => (block as { block_id?: unknown }).block_id !== id);
  const note = { type: "context", block_id: id, elements: [{ type: "mrkdwn", text: line }] };
  const at = kept.findIndex((block) => (block as { block_id?: unknown }).block_id === `payable-${invoiceId}`);
  return at === -1 ? [...kept, note] : [...kept.slice(0, at), note, ...kept.slice(at)];
}

const VERB: Record<"approve" | "reject" | "return", string> = { approve: "approved it", reject: "rejected it", return: "returned it" };

/** The line a decided card says: who decided, what came of it, and the transaction when one went out on Arc. */
export function outcomeLine(
  decision: "approve" | "reject" | "return",
  slackUserId: string,
  outcome: CommandOutcome<{ status?: string; txRef?: string | null }>,
  network: Network
): string {
  const who = `<@${slackUserId}>`;
  if (!outcome.ok) return `${who} ${VERB[decision]}. ${mrkdwn(outcome.message)}`;
  if (decision === "reject") return `Rejected by ${who}.`;
  if (decision === "return") return `Returned to the agent by ${who}. It usually decides it again within a minute.`;
  if (outcome.status === "paid") {
    const tx = outcome.txRef && /^0x[0-9a-fA-F]{64}$/.test(outcome.txRef) ? ` ${link(txUrl(network, outcome.txRef), "Arc testnet transaction")}` : "";
    return `Approved and paid by ${who}.${tx}`;
  }
  if (outcome.status === "approved") return `Approved by ${who}. One more approval, by another person, pays it.`;
  return `Approved by ${who}. The payment was sent; Arc testnet is confirming it.`;
}

/** An answer only the person who asked sees, unless it is for the channel. `text` is mrkdwn already. */
export function textAnswer(text: string, inChannel = false): SlackMessage {
  return { response_type: inChannel ? "in_channel" : "ephemeral", text, blocks: [section(text)] };
}

/** `/vestiarion today` (S6): safe to spend today, what waits for a person, and what the agent pays next. */
export function todayAnswer(workspaceName: string, facts: TodayFacts, consoleUrl: string): SlackMessage {
  const lines = [
    `*${mrkdwn(workspaceName)}* · today`,
    `*Safe to spend today: ${amountText(facts.safeToSpend, "USDC")}*`,
    `The operating wallet holds ${amountText(facts.cash, "USDC")}${facts.reserve > 0 ? ` and the USYC reserve ${amountText(facts.reserve, "USDC")}, back in seconds` : ""}; ${amountText(facts.dueIn30d, "USDC")} is due in the next 30 days.`,
  ];
  if (facts.eurcLeftOut > 0) lines.push(`EURC payables due: ${amountText(facts.eurcLeftOut, "EURC")}, paid from EURC.`);
  if (facts.shortOn) lines.push(`Before any receivable arrives, the wallet runs short on ${shortDay(facts.shortOn)}.`);
  lines.push(
    facts.waiting === 0
      ? "Nothing waits for a person."
      : `${facts.waiting} ${facts.waiting === 1 ? "payment waits" : "payments wait"} for a person: type \`/vestiarion waiting\` to see why.`
  );
  if (facts.scheduled.length > 0) {
    lines.push("The agent pays next:");
    for (const payment of facts.scheduled) lines.push(`• ${shortDay(payment.on)}: ${mrkdwn(payment.name)} ${amountText(payment.amount, payment.currency)}`);
  }
  lines.push(`${facts.lastCycleAt ? `Last cycle ${utcMinute(facts.lastCycleAt)}. ` : ""}${link(consoleUrl, "Open the console")}`);
  return textAnswer(lines.join("\n"));
}

const WAITING_STATUS: Record<string, string> = { held: "held", flagged: "flagged", awaiting_info: "waiting for information" };

/** `/vestiarion waiting` (S6): each payment a person must decide, why the agent stopped it, and where to decide it. */
export function waitingAnswer(workspaceName: string, facts: WaitingFact[], origin: string, slug: string): SlackMessage {
  if (facts.length === 0) return textAnswer(`*${mrkdwn(workspaceName)}* · Nothing waits for a person.`);
  const lines = [`*${mrkdwn(workspaceName)}* · ${facts.length === 1 ? "1 payment waits" : `${facts.length} payments wait`} for a person`];
  for (const fact of facts) {
    const where =
      fact.kind === "payable" ? link(orgUrl(origin, slug, `/approvals#payable-${fact.id}`), "Decide in Approvals") : link(orgUrl(origin, slug, "/contractors"), "Contractors");
    const why = fact.reason ? `: ${mrkdwn(clip(fact.reason, 300))}` : "";
    lines.push(`• ${mrkdwn(fact.name)} ${amountText(fact.amount, fact.currency)} · ${WAITING_STATUS[fact.status] ?? mrkdwn(fact.status)}${why} ${where}`);
  }
  return textAnswer(lines.join("\n"));
}

/** `/vestiarion ledger` (S6): the console's Verify hash chain, in a sentence. */
export function ledgerAnswer(workspaceName: string, result: VerificationResult): SlackMessage {
  const head = `*${mrkdwn(workspaceName)}*`;
  if (result.valid === true) {
    return textAnswer(`${head} · the ledger is intact: ${COUNT.format(result.checkedEntries)} entries, each signed and linked to the one before.`);
  }
  if (result.valid === false) {
    return textAnswer(`${head} · the ledger does not verify at entry ${result.brokenAt ?? "?"}: ${mrkdwn(result.reason ?? "unknown reason")}.`);
  }
  return textAnswer(`${head} · the ledger was not checked: ${mrkdwn(result.reason ?? "this deployment has no key to check it with")}.`);
}

/** What `/vestiarion` does: for `help`, an empty command, and anything it does not understand. */
export function helpAnswer(connected: boolean, workspaceName?: string): SlackMessage {
  if (!connected) {
    return textAnswer(
      "Your Slack account is not connected to Vestiarion yet. Type `/vestiarion connect` and open the link it gives you; it works once, for 10 minutes."
    );
  }
  return textAnswer(
    [
      `Connected to *${mrkdwn(workspaceName ?? "your workspace")}*.`,
      "`/vestiarion today`: safe to spend today, what waits for a person, what the agent pays next",
      "`/vestiarion waiting`: the payments waiting for a person, and why",
      "`/vestiarion ledger`: check that the signed ledger is intact",
      "`/vestiarion pause [reason]`: stop the agent; it is resumed in Vestiarion",
      "`/vestiarion disconnect`: disconnect your Slack account",
      "*More actions* › *Add invoice* on a message holding an invoice: add it as a payable, for an owner or admin",
      "When an owner allows it, a payment the agent stopped can be decided from its message in the channel.",
    ].join("\n")
  );
}

/** The one-time link `/vestiarion connect` gives the person who asked, and only them (S4). */
export function connectAnswer(url: string): SlackMessage {
  const text = "Open this link to connect your Slack account to Vestiarion. It works once, for 10 minutes, and only for you.";
  return {
    response_type: "ephemeral",
    text,
    blocks: [section(text), { type: "actions", elements: [urlButton("vx_connect", "Connect", url)] }],
  };
}

/**
 * An invoice read from what someone chose with "Add invoice" (S15), for them alone: every field to check
 * before they add it, and the buttons that add it, with the goods received or not, or drop it. Each carries the draft.
 */
export function draftAnswer(read: InvoiceDraftRead, draftId: string): SlackMessage {
  const { draft } = read;
  const from = read.counterpartyName ?? draft.vendorName ?? "a vendor";
  const lines = [
    `*Read the invoice from ${mrkdwn(from)}.* Check it before adding it as a payable.`,
    `Amount: ${amountText(draft.amount ?? 0, draft.currency ?? "USDC")}`,
    `Due: ${mrkdwn(draft.dueDate ?? "not read")}`,
    `Purchase order: ${mrkdwn(draft.poReference ?? "none")}`,
  ];
  if (draft.earlyPayDiscountPct && draft.discountDeadline) {
    lines.push(`Early payment: ${mrkdwn(`${draft.earlyPayDiscountPct}% if paid by ${draft.discountDeadline}`)}`);
  }
  if (draft.invoiceNumber) lines.push(`Invoice number: ${mrkdwn(draft.invoiceNumber)}`);
  if (draft.memo) lines.push(`Memo: ${mrkdwn(clip(draft.memo, 300))}`);
  for (const warning of read.warnings) lines.push(`:warning: ${mrkdwn(clip(warning, 300))}`);
  if (read.modelNote) lines.push(`_${mrkdwn(clip(`The model's note: ${read.modelNote}`, 300))}_`);
  const button = (actionId: string, label: string, primary = false) => ({
    type: "button",
    action_id: actionId,
    text: plain(label),
    value: draftId,
    ...(primary ? { style: "primary" } : {}),
  });
  return {
    response_type: "ephemeral",
    text: `Read the invoice from ${mrkdwn(from)}. Check it before adding it as a payable.`,
    blocks: [
      section(lines.join("\n")),
      {
        type: "actions",
        block_id: `draft-${draftId}`,
        elements: [button("vx_draft_received", "Add, goods received", true), button("vx_draft_not_received", "Add, not received yet"), button("vx_draft_cancel", "Cancel")],
      },
      context(`Read by ${READER_NAMES[read.reader]}. Only you see this. The agent decides once it is added; nothing is paid from here.`),
    ],
  };
}

/** An invoice read from what someone chose that cannot be added from Slack as it was read, and where to finish it (S15). */
export function missingAnswer(read: InvoiceDraftRead, reasons: string[], invoicesUrl: string): SlackMessage {
  const from = read.counterpartyName ?? read.draft.vendorName;
  return textAnswer(
    [
      `*Read the invoice${from ? ` from ${mrkdwn(from)}` : ""}*, but it cannot be added from here:`,
      ...reasons.map((reason) => `• ${mrkdwn(reason)}`),
      `Add it in Vestiarion, where you can fix each field: ${link(invoicesUrl, "AP / AR")}.`,
    ].join("\n")
  );
}

/** A draft's button after its hour, or after the draft was added or dropped (S15). */
export const DRAFT_USED = "This draft was already used or has expired. Choose *Add invoice* on the message again to read it anew.";

/** What replaces a draft's answer once its button was pressed: the outcome, for the person who pressed it. */
export function draftOutcome(text: string): SlackMessage {
  return { replace_original: true, text, blocks: [section(text)] };
}
