import type { ActivityItem } from "../agent-activity";
import { approvalAnchor, orgHref } from "../auth/org-paths";
import type { CommandOutcome } from "../commands/outcome";
import { lateFeeLine, READER_NAMES } from "../invoice-document/chat-draft";
import type { InvoiceDraftRead } from "../invoice-document/draft";
import type { VerificationResult } from "../ledger";
import type { WaitingNotice, WaitingNoticeEntry } from "../notifications/waiting-notice";
import { txUrl } from "../payee-chains";
import { SIMULATED_NETWORK, type PaymentReceipt } from "../payment-receipt";
import { networkProfile, type Network } from "../network";
import { shortenAddresses, type WaitingSection } from "../telegram/messages";
import type { TodayFacts, WaitingFact } from "../telegram/today";
import type { SlackMessage } from "./api";

/**
 * What Slack shows (Slack design S6–S8, S10, S14), as Block Kit. Every value passes through `mrkdwn`, which removes
 * invisible format characters, escapes Slack's three characters and shortens a wallet address to its first and last
 * four; every mrkdwn text is `verbatim`, so Slack links nothing inside a value, and every link is absolute. A stopped
 * payable carries its buttons only when deciding from Slack is on (a card is given), Approve only when the payable
 * qualifies, and the two buttons that act are confirmed by Slack first. While it is off, the bills still waiting for
 * approval end the message in their own section, each with a Review button to its card on Approvals
 * (docs/superpowers/specs/2026-10-27-slack-review-links-design.md SR2). Pure: the callers read the facts and post.
 */

/** Decisions told one by one in a message; the rest are counted, and left to the console. Keeps a message under 50 blocks. */
export const ITEMS_SHOWN = 10;
/** Slack takes 3,000 characters in a section; the rest is room to spare. */
const TEXT_MAX = 2900;
/** How long a payee's or a payment's name is shown in a line of what waits. */
const NAME_MAX = 100;
/** How long the reason a payment waits is shown. */
const REASON_MAX = 300;

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const COUNT = new Intl.NumberFormat("en-US");

/**
 * Invisible format characters (Unicode's Cf): bidi embeddings, overrides and isolates, the marks that set direction,
 * zero-width spaces and joiners, the byte-order mark and the soft hyphen. An override in a payee's name would show the
 * rest of its line reversed, so one bill could read as another.
 */
const FORMAT = /\p{Cf}/gu;
/** Half of a surrogate pair standing alone: in a `u` pattern a whole pair is one character, and never matches. */
const LONE_SURROGATE = /\p{Cs}/gu;

/**
 * A value as Slack's mrkdwn shows it (S14; SR4): invisible format characters and half of an emoji removed, as
 * Telegram's and Discord's messages remove them, a wallet address shortened, and `&`, `<` and `>` escaped, so no value
 * writes a link or a mention of its own.
 */
export function mrkdwn(value: string): string {
  return shortenAddresses(value.replace(LONE_SURROGATE, "").replace(FORMAT, "")).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A value on a line of the bills waiting for approval or of `/vestiarion waiting` (SR4): as `mrkdwn` shows it, with
 * every newline, control character and run of whitespace one space, so a value stays on its line, and clipped to `max`
 * before it is escaped, so no cut falls inside an escape. Half of an emoji a cut leaves is removed with the rest.
 */
export function slackText(value: string, max: number): string {
  return mrkdwn(clip(shortenAddresses(value.replace(FORMAT, "").replace(/[\s\p{Cc}]+/gu, " ").trim()), max));
}

/** A confirmation dialog's text: Slack refuses the whole message past 300 characters (payment exceptions review 4). */
export const CONFIRM_TEXT_MAX = 300;

/** Mrkdwn cut short, never through one of its escapes (`&amp;`, `&lt;`, `&gt;`), which Slack would show as typed. */
function clipMrkdwn(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/&[a-z]*$/, "").trimEnd()}…`;
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
/**
 * Mrkdwn Slack shows as it is written (SR4): a web address, a channel's name or a mention inside a value is never made
 * a link. Every link Vestiarion means is written out (`<url|label>`, `<@U…>`), which Slack still shows as one.
 */
const verbatim = (text: string) => ({ type: "mrkdwn", text, verbatim: true });
const section = (text: string, blockId?: string) => ({ type: "section", ...(blockId ? { block_id: blockId } : {}), text: verbatim(clip(text, TEXT_MAX)) });
const context = (text: string, blockId?: string) => ({
  type: "context",
  ...(blockId ? { block_id: blockId } : {}),
  elements: [verbatim(clip(text, TEXT_MAX))],
});
const urlButton = (actionId: string, label: string, url: string) => ({ type: "button", action_id: actionId, text: plain(label), url });
/** What a message with links asks of Slack: no preview of any of them, as Telegram's and Discord's messages ask (SR4). */
const NO_PREVIEWS = { unfurl_links: false, unfurl_media: false } as const;

/** What a stopped payable's buttons carry and say, as the cycle's stage worked them out (S8, S9). */
export interface CardView {
  invoiceId: string;
  /** The signed card (`vx1.…`) each button carries. */
  token: string;
  /** Why Approve and pay is not offered from Slack; null when it is. */
  approveRefusal: string | null;
  /** What Approve and pay will do, for Slack's confirmation: the amount, the payee, the address shortened. */
  confirmText: string;
  /**
   * The confirmation's title and button where Approve checks an earlier transfer first rather than paying (payment
   * exceptions E3): "Approve and pay?" and "Approve and pay" when absent.
   */
  confirmTitle?: string;
  confirmLabel?: string;
}

function itemBlocks(item: ActivityItem, workspace: { slug: string }, origin: string, card: CardView | undefined): unknown[] {
  const blocks: unknown[] = [section(mrkdwn(item.text))];
  if (item.detail) blocks.push(context(mrkdwn(item.detail)));
  const open = urlButton("vx_open", item.pathLabel, orgUrl(origin, workspace.slug, item.path));
  if (!card) {
    const buttons = item.txUrl ? [urlButton("vx_tx", `${networkProfile(item.network).label} transaction`, item.txUrl ?? ""), open] : [open];
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
      confirm: {
        title: plain(card.confirmTitle ?? "Approve and pay?"),
        text: verbatim(clipMrkdwn(mrkdwn(card.confirmText), CONFIRM_TEXT_MAX)),
        confirm: plain(card.confirmLabel ?? "Approve and pay"),
        deny: plain("Cancel"),
      },
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
      text: verbatim("It will not be paid, and the agent does not look at it again."),
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
 * Said once under the bills waiting for approval, and in `/vestiarion waiting`, as Telegram's and Discord's messages say
 * it: a link opens a bill, and decides nothing.
 */
export const NEVER_APPROVES = "Opening a link never approves anything.";

/** How a waiting bill's status reads, as Telegram's and Discord's messages say it. */
const WAITING_STATUS: Record<string, string> = { held: "held", flagged: "flagged", awaiting_info: "waiting for details" };

/**
 * One bill waiting for approval (SR2): how much, to whom, why, and what it needs, with its card on Approvals as the
 * section's own Review button. The link sits apart from the values, so no value can stand inside it and no cut can
 * reach it. Its block id is never a card's (`payable-`, `why-`, `approved-`), which a decided card's rewrite matches.
 */
function billSection(entry: WaitingNoticeEntry, slug: string, origin: string): unknown {
  const parts = [`*${slackText(entry.amountText, 60)}*`, slackText(entry.payee, NAME_MAX)];
  parts.push(entry.reason ? `${WAITING_STATUS[entry.status]}: ${slackText(entry.reason, REASON_MAX)}` : WAITING_STATUS[entry.status]);
  if (entry.twoApprovals) parts.push(entry.cosign ? "needs two approvals, an accountant can co-sign" : "needs two approvals");
  return { ...section(parts.join(" · "), `waiting-${entry.invoiceId}`), accessory: urlButton("vx_review", "Review", orgUrl(origin, slug, entry.reviewPath)) };
}

/**
 * The bills waiting for approval, as the end of the decisions message (SR2): how many wait, a section each for the
 * listed ones, how many more wait in Approvals, and once that opening a link approves nothing. At most 3 + 10 blocks,
 * so with `ITEMS_SHOWN` decisions of at most 3 blocks each the message stays at 45 of Slack's 50.
 */
function waitingBlocks(notice: WaitingNotice, slug: string, origin: string): unknown[] {
  const blocks: unknown[] = [section(`${notice.total === 1 ? "1 bill waits" : `${notice.total} bills wait`} for approval:`, "waiting")];
  for (const entry of notice.entries) blocks.push(billSection(entry, slug, origin));
  if (notice.more > 0) blocks.push(section(`…and ${notice.more} more in ${link(orgUrl(origin, slug, "/approvals"), "Approvals")}.`, "waiting-more"));
  blocks.push(context(NEVER_APPROVES, "waiting-never"));
  return blocks;
}

/**
 * The agent's decisions since the channel was last told (S7): one block group each, with its reasons, its transaction
 * and its page; a stopped payable's card when `cards` names it. `cards` is null while deciding from Slack is off; then
 * the bills among the decisions still waiting for approval (`waiting`) are told once, in a section at the end with a
 * Review button each, in place of their decisions' blocks (SR2). While deciding is on, each keeps its card, whose
 * buttons act, and no section is drawn. Decisions past `ITEMS_SHOWN` are counted and left to the console.
 */
export function decisionsMessage(
  workspace: { name: string; slug: string },
  items: ActivityItem[],
  origin: string,
  cards: ReadonlyMap<string, CardView> | null,
  waiting: WaitingSection | null = null
): SlackMessage {
  const count = items.length === 1 ? "1 thing" : `${items.length} things`;
  const blocks: unknown[] = [section(`*${mrkdwn(workspace.name)}* · the agent decided ${count}`)];
  const listed = cards === null && waiting && waiting.notice.total > 0 ? waiting : null;
  const told = listed ? items.filter((item) => !(item.invoiceId && listed.invoiceIds.has(item.invoiceId))) : items;
  const shown = told.slice(0, ITEMS_SHOWN);
  for (const item of shown) {
    const card = item.tone === "stopped" && item.invoiceId ? cards?.get(item.invoiceId) : undefined;
    blocks.push(...itemBlocks(item, workspace, origin, card));
  }
  if (told.length > shown.length) {
    blocks.push(section(`…and ${told.length - shown.length} more in ${link(orgUrl(origin, workspace.slug, "/console"), "the console")}.`));
  }
  if (listed) blocks.push(...waitingBlocks(listed.notice, workspace.slug, origin));
  return { text: `${mrkdwn(workspace.name)}: the agent decided ${count}`, blocks, ...NO_PREVIEWS };
}

/** A decided card: the payable's buttons, and the reason Approve was missing, become one line saying who did what (S10). */
export function withOutcome(blocks: unknown[], invoiceId: string, line: string): unknown[] {
  return blocks.flatMap((block) => {
    const id = (block as { block_id?: unknown }).block_id;
    if (id === `why-${invoiceId}`) return [];
    if (id === `payable-${invoiceId}`) return [{ type: "context", block_id: id, elements: [verbatim(line)] }];
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
  const note = { type: "context", block_id: id, elements: [verbatim(line)] };
  const at = kept.findIndex((block) => (block as { block_id?: unknown }).block_id === `payable-${invoiceId}`);
  return at === -1 ? [...kept, note] : [...kept.slice(0, at), note, ...kept.slice(at)];
}

const VERB: Record<"approve" | "reject" | "return", string> = { approve: "approved it", reject: "rejected it", return: "returned it" };

/**
 * The line a decided card says: who decided, what came of it, and the transaction when one went out on Arc. Paid only
 * once Circle confirmed it, and named so; submitted while Circle has not; an unknown outcome when Circle never answered
 * the send (no Circle id); simulated in a sandbox (settlement lifecycle I17).
 */
export function outcomeLine(
  decision: "approve" | "reject" | "return",
  slackUserId: string,
  outcome: CommandOutcome<{ status?: string; txRef?: string | null; receipt?: Pick<PaymentReceipt, "network"> }>,
  network: Network
): string {
  const who = `<@${slackUserId}>`;
  if (!outcome.ok) return `${who} ${VERB[decision]}. ${mrkdwn(outcome.message)}`;
  if (decision === "reject") return `Rejected by ${who}.`;
  if (decision === "return") return `Returned to the agent by ${who}. It usually decides it again within a minute.`;
  const { label } = networkProfile(network);
  if (outcome.status === "paid") {
    if (outcome.receipt?.network === SIMULATED_NETWORK) return `Approved by ${who}. The payment was simulated in the sandbox.`;
    const tx = outcome.txRef && /^0x[0-9a-fA-F]{64}$/.test(outcome.txRef) ? ` ${link(txUrl(network, outcome.txRef), `${label} transaction`)}` : "";
    return `Approved by ${who}. Circle confirmed the payment on ${label}.${tx}`;
  }
  if (outcome.status === "approved") return `Approved by ${who}. One more approval, by another person, pays it.`;
  if (outcome.status === "matched") {
    return outcome.txRef
      ? `Approved by ${who}. The payment was submitted; waiting for Circle to confirm it on ${label}.`
      : `Approved by ${who}. The payment was submitted, but Circle has not answered yet, so the outcome is unknown; nothing goes out again until it does.`;
  }
  return `Approved by ${who}.`;
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

/** One payment a person must decide, for `/vestiarion waiting`: what, how much, why it waits, and where to decide it. */
function waitingLine(fact: WaitingFact, origin: string, slug: string): string {
  // A payable is reviewed on its card in Approvals, as the channel's bills are (SR3); one held for a person's verdict is
  // settled by giving one, in Vestiarion (shadow mode S4).
  const where =
    fact.kind === "payable"
      ? link(orgUrl(origin, slug, `/approvals#${approvalAnchor(fact.id)}`), fact.forVerdict ? "Give your verdict" : "Review")
      : link(orgUrl(origin, slug, "/contractors"), "Contractors");
  const why = fact.reason ? `: ${slackText(fact.reason, REASON_MAX)}` : "";
  const state = fact.forVerdict ? "waits for your verdict" : (WAITING_STATUS[fact.status] ?? slackText(fact.status, 40));
  return `• ${slackText(fact.name, NAME_MAX)} ${amountText(fact.amount, fact.currency)} · ${state}${why} ${where}`;
}

/**
 * `/vestiarion waiting` (S6, SR3): each payment a person must decide, why the agent stopped it, and where to decide it,
 * then once that opening a link approves nothing, when a Review link is listed. A payment that would pass the section's
 * 3,000 characters is counted, never cut, so no link is cut in two.
 */
export function waitingAnswer(workspaceName: string, facts: WaitingFact[], origin: string, slug: string): SlackMessage {
  if (facts.length === 0) return textAnswer(`*${slackText(workspaceName, NAME_MAX)}* · Nothing waits for a person.`);
  const more = (n: number) => `…and ${n} more in ${link(orgUrl(origin, slug, "/console"), "the console")}.`;
  // Room kept for the closing line, whatever is left out.
  const closing = `\n${more(facts.length)}`.length;
  let text = `*${slackText(workspaceName, NAME_MAX)}* · ${facts.length === 1 ? "1 payment waits" : `${facts.length} payments wait`} for a person`;
  let shown = 0;
  let reviewed = false;
  for (const fact of facts) {
    const line = `\n${waitingLine(fact, origin, slug)}`;
    if (text.length + line.length + closing > TEXT_MAX) break;
    text += line;
    shown += 1;
    if (fact.kind === "payable" && !fact.forVerdict) reviewed = true;
  }
  if (shown < facts.length) text += `\n${more(facts.length - shown)}`;
  return {
    response_type: "ephemeral",
    text,
    blocks: [section(text), ...(reviewed ? [context(NEVER_APPROVES)] : [])],
    ...NO_PREVIEWS,
  };
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
  const lateFee = lateFeeLine(draft);
  if (lateFee) lines.push(`Late fee: ${mrkdwn(lateFee)}`);
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
      `Add it in Vestiarion, where you can fix each field: ${link(invoicesUrl, "Bills & receivables")}.`,
    ].join("\n")
  );
}

/** A draft's button after its hour, or after the draft was added or dropped (S15). */
export const DRAFT_USED = "This draft was already used or has expired. Choose *Add invoice* on the message again to read it anew.";

/** What replaces a draft's answer once its button was pressed: the outcome, for the person who pressed it. */
export function draftOutcome(text: string): SlackMessage {
  return { replace_original: true, text, blocks: [section(text)] };
}
