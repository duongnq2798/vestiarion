import type { ActivityItem } from "../agent-activity";
import { networkProfile } from "../network";
import { approvalAnchor, orgHref } from "../auth/org-paths";
import { READER_NAMES } from "../invoice-document/chat-draft";
import type { InvoiceDraftRead } from "../invoice-document/draft";
import type { VerificationResult } from "../ledger";
import type { WaitingNotice, WaitingNoticeEntry } from "../notifications/waiting-notice";
import type { TodayFacts, WaitingFact } from "./today";

/**
 * What the bot says (Telegram bot design R8–R12), as Telegram's HTML: every value escaped, every link absolute, and no
 * message longer than `MESSAGE_MAX`, so Telegram never refuses one for its markup or its length. Pure: the callers read
 * the facts and send the text.
 */

/** Telegram allows 4,096 characters; the rest is room to spare. */
export const MESSAGE_MAX = 3800;
const ITEM_TEXT_MAX = 400;
const ITEM_DETAIL_MAX = 300;

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const COUNT = new Intl.NumberFormat("en-US");

/**
 * A wallet address shortened to its first and last four characters (`0xc0ff…ee00`): Telegram never receives one in
 * full (R12), though the model's reasons and the reader's warnings can name one. A transaction's 64-character hash,
 * in an explorer link, is not an address and is left whole.
 */
export function shortenAddresses(value: string): string {
  return value.replace(/\b0x([0-9a-fA-F]{4})[0-9a-fA-F]{32}([0-9a-fA-F]{4})\b/g, "0x$1…$2");
}

/**
 * Escapes a value for Telegram's HTML: the three characters it requires escaped outside a tag, and the double quote,
 * so a value can sit inside a link's href (`&quot;` is one of the named entities Telegram reads). Every value the bot
 * sends passes through here, so this is also where wallet addresses are shortened.
 */
export function escapeHtml(value: string): string {
  return shortenAddresses(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Invisible format characters (Unicode's Cf): bidi embeddings, overrides and isolates, the marks that set direction,
 * zero-width spaces and joiners, the byte-order mark and the soft hyphen. An override in a payee's name would show the
 * rest of a bill's line reversed, so its Review link could read as another bill's.
 */
const FORMAT = /\p{Cf}/gu;
/** Half of a surrogate pair standing alone: in a `u` pattern a whole pair is one character, and never matches. */
const LONE_SURROGATE = /\p{Cs}/gu;
/** How long a payee's or a payment's name is shown. */
const NAME_MAX = 100;
/** Fullwidth "@" and "/" (U+FF20, U+FF0F): they read as the characters, and Telegram finds no @name or /command in them. */
const FULLWIDTH_AT = String.fromCodePoint(0xff20);
const FULLWIDTH_SLASH = String.fromCodePoint(0xff0f);

/**
 * A value with nothing left in it for Telegram to make tappable. Telegram finds web addresses, @names and /commands in
 * every message a bot sends, in HTML or plain text, and links each one: a payee named `Acme https://…` would put a link
 * of its own beside the bill's Review link, and one named `Acme /disconnect` a command that disconnects the chat at a
 * tap. So a dot before a domain's ending, and each dot of an IP address, reads `[.]`, and every `@`, and every `/` that
 * does not follow a letter or a digit, takes its fullwidth form: `acme.com` reads `acme[.]com` and `https://` shows
 * wide slashes, while `2.00 USDC`, `e.g.`, `1/3` and `N/A` read as they did. Discord's messages escape the same things
 * (`src/lib/discord/escape.ts`).
 */
function unlinked(value: string): string {
  return value
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (ip) => ip.split(".").join("[.]"))
    .replace(/\.(?=\p{L}{2})/gu, "[.]")
    .replace(/@/g, FULLWIDTH_AT)
    .replace(/(?<![\p{L}\p{N}])\//gu, FULLWIDTH_SLASH);
}

/**
 * A value as the decisions message, its bills waiting for approval and /waiting show it
 * (docs/superpowers/specs/2026-10-23-telegram-review-links-design.md TG4). A payee's name and the agent's reasons come
 * from documents and emails anyone can send, so invisible format characters and half of an emoji are removed, as
 * Discord's messages remove them, and every newline, control character and run of whitespace becomes one space, so a
 * value stays on its line. A wallet address is shortened before the cut, so no cut leaves most of one, and what
 * Telegram would link is broken up (`unlinked`); the value is clipped to `max` UTF-16 units, never between the two
 * halves of one character, and escaped last, so no cut falls inside an entity.
 */
export function telegramText(value: string, max: number = ITEM_DETAIL_MAX): string {
  const plain = unlinked(shortenAddresses(value.replace(LONE_SURROGATE, "").replace(FORMAT, "").replace(/[\s\p{Cc}]+/gu, " ").trim()));
  if (plain.length <= max) return escapeHtml(plain);
  return escapeHtml(`${plain.slice(0, Math.max(0, max - 1)).replace(LONE_SURROGATE, "").trimEnd()}…`);
}

const link = (href: string, label: string) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
const bold = (text: string) => `<b>${escapeHtml(text)}</b>`;

/** A page of the workspace, as an absolute link. */
export function orgUrl(origin: string, slug: string, path: string): string {
  return `${origin}${orgHref(slug, path)}`;
}

export function amountText(amount: number | string, currency: string): string {
  return `${AMOUNT.format(Number(amount))} ${currency}`;
}

/** The words a message shows, without its markup: the text sent when Telegram refused the HTML once. */
export function plainText(html: string): string {
  return html
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** A decision's mark: done, or stopped for a person. A payment Circle has not confirmed yet is neither, and has none (I17). */
const MARK: Record<ActivityItem["tone"], string> = { done: "✅ ", stopped: "⏸ ", pending: "", notice: "⚠️ " };

/** One decision: what the agent did and why, each a line of plain text, as the bills' lines show theirs (TG4), then its links. */
function decisionBlock(item: ActivityItem, slug: string, origin: string): string {
  const lines = [`${MARK[item.tone]}${telegramText(item.text, ITEM_TEXT_MAX)}`];
  if (item.detail) lines.push(`<i>${telegramText(item.detail, ITEM_DETAIL_MAX)}</i>`);
  const links = [...(item.txUrl ? [link(item.txUrl, `${networkProfile(item.network).label} transaction`)] : []), link(orgUrl(origin, slug, item.path), item.pathLabel)];
  lines.push(links.join(" · "));
  return lines.join("\n");
}

/** Said once under the bills waiting for approval, as Discord's notice says it: a link opens a bill, and decides nothing. */
export const NEVER_APPROVES = "Opening a link never approves anything.";

/** How a waiting bill's status reads, as Discord's notice and /waiting say it. */
const WAITING_STATUS: Record<string, string> = { held: "held", flagged: "flagged", awaiting_info: "waiting for details" };

/**
 * The bills among a chat's decisions that still wait for approval (TG2): the notice that lists them, and every bill it
 * stands for, listed or counted, whose decisions' blocks the section replaces.
 */
export interface WaitingSection {
  notice: WaitingNotice;
  invoiceIds: ReadonlySet<string>;
}

/** One bill, on one line: how much, to whom, why, what it needs, and its card on Approvals, to review it. */
function billLine(entry: WaitingNoticeEntry, slug: string, origin: string): string {
  const parts = [`<b>${telegramText(entry.amountText, 60)}</b>`, telegramText(entry.payee, NAME_MAX)];
  parts.push(entry.reason ? `${WAITING_STATUS[entry.status]}: ${telegramText(entry.reason)}` : WAITING_STATUS[entry.status]);
  if (entry.twoApprovals) parts.push(entry.cosign ? "needs two approvals, an accountant can co-sign" : "needs two approvals");
  parts.push(link(orgUrl(origin, slug, entry.reviewPath), "Review"));
  return `${MARK.stopped}${parts.join(" · ")}`;
}

/**
 * The bills waiting for approval, as a section of the decisions message: a line each, as many of the listed ones as fit
 * in `room`, then how many more wait in Approvals, and once that opening a link approves nothing. A bill that would pass
 * the room is counted among the more, never cut.
 */
function waitingSection(notice: WaitingNotice, slug: string, origin: string, room: number): string {
  const heading = `${notice.total === 1 ? "1 bill waits" : `${notice.total} bills wait`} for approval:`;
  const more = (n: number) => `…and ${n} more in ${link(orgUrl(origin, slug, "/approvals"), "Approvals")}.`;
  // Room kept for the closing lines, whatever is left out.
  const closing = `\n${more(notice.total)}\n${NEVER_APPROVES}`.length;
  let section = heading;
  let shown = 0;
  for (const entry of notice.entries) {
    const line = `\n${billLine(entry, slug, origin)}`;
    if (section.length + line.length + closing > room) break;
    section += line;
    shown += 1;
  }
  const left = notice.total - shown;
  return `${section}${left > 0 ? `\n${more(left)}` : ""}\n${NEVER_APPROVES}`;
}

/**
 * The agent's decisions in one workspace since the chat was last told (R8): one block each, with its reasons, its
 * transaction and the page where a person sees or handles it. The bills among them still waiting for approval are told
 * once, in a section at the end with a Review link each, in place of their decisions' blocks; the section has the first
 * claim on the room, since it is what a person acts on. Decisions that would pass the length limit are left to the
 * console, and a line says how many.
 */
export function decisionsMessage(workspace: { name: string; slug: string }, items: ActivityItem[], origin: string, waiting: WaitingSection | null = null): string {
  const header = `<b>${telegramText(workspace.name, NAME_MAX)}</b> · the agent decided ${items.length === 1 ? "1 thing" : `${items.length} things`}`;
  const more = (n: number) => `…and ${n} more in ${link(orgUrl(origin, workspace.slug, "/console"), "the console")}.`;
  const roomForMore = more(items.length).length + 2;
  const listed = waiting && waiting.notice.total > 0 ? waiting : null;
  const blocks = listed ? items.filter((item) => !(item.invoiceId && listed.invoiceIds.has(item.invoiceId))) : items;
  const section = listed
    ? `\n\n${waitingSection(listed.notice, workspace.slug, origin, MESSAGE_MAX - header.length - 2 - (blocks.length > 0 ? roomForMore : 0))}`
    : "";
  let message = header;
  let shown = 0;
  for (const item of blocks) {
    const block = `\n\n${decisionBlock(item, workspace.slug, origin)}`;
    const last = shown === blocks.length - 1;
    if (message.length + block.length + section.length + (last ? 0 : roomForMore) > MESSAGE_MAX) break;
    message += block;
    shown += 1;
  }
  return `${shown < blocks.length ? `${message}\n\n${more(blocks.length - shown)}` : message}${section}`;
}

/** A UTC day as "Oct 5". */
function shortDay(day: string): string {
  return new Date(`${day.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "2026-10-03 07:55 UTC". */
function utcMinute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** /today (R9): safe to spend today, what waits for a person, and what the agent pays next. */
export function todayMessage(workspaceName: string, facts: TodayFacts, consoleUrl: string): string {
  const lines = [
    `${bold(workspaceName)} · today`,
    "",
    `${bold(`Safe to spend today: ${amountText(facts.safeToSpend, "USDC")}`)}`,
    `The operating wallet holds ${escapeHtml(amountText(facts.cash, "USDC"))}${facts.reserve > 0 ? ` and the USYC reserve ${escapeHtml(amountText(facts.reserve, "USDC"))}, back in seconds` : ""}; ${escapeHtml(amountText(facts.dueIn30d, "USDC"))} is due in the next 30 days.`,
  ];
  if (facts.eurcLeftOut > 0) lines.push(`EURC payables due: ${escapeHtml(amountText(facts.eurcLeftOut, "EURC"))}, paid from EURC.`);
  if (facts.shortOn) lines.push(`⚠️ Before any receivable arrives, the wallet runs short on ${shortDay(facts.shortOn)}.`);
  lines.push(
    "",
    facts.waiting === 0
      ? "Nothing waits for a person."
      : `${facts.waiting} ${facts.waiting === 1 ? "payment waits" : "payments wait"} for a person: send /waiting to see why.`
  );
  if (facts.scheduled.length > 0) {
    lines.push("", "The agent pays next:");
    for (const payment of facts.scheduled) lines.push(`• ${shortDay(payment.on)}: ${escapeHtml(payment.name)} ${escapeHtml(amountText(payment.amount, payment.currency))}`);
  }
  lines.push("", `${facts.lastCycleAt ? `Last cycle ${utcMinute(facts.lastCycleAt)}. ` : ""}${link(consoleUrl, "Open the console")}`);
  return clip(lines.join("\n"), MESSAGE_MAX);
}

/** One payment a person must decide, for /waiting: what, how much, why it waits, and where to decide it. */
function waitingBlock(fact: WaitingFact, origin: string, slug: string): string {
  // A payable is reviewed on its card in Approvals, as the decisions message and Discord link it (TG3); one held for a
  // person's verdict is settled by giving one, in Vestiarion (shadow mode S4).
  const where =
    fact.kind === "payable"
      ? link(orgUrl(origin, slug, `/approvals#${approvalAnchor(fact.id)}`), fact.forVerdict ? "Give your verdict" : "Review")
      : link(orgUrl(origin, slug, "/contractors"), "Contractors");
  const why = fact.reason ? `: ${telegramText(fact.reason)}` : "";
  const state = fact.forVerdict ? "waits for your verdict" : (WAITING_STATUS[fact.status] ?? telegramText(fact.status, 40));
  return `⏸ ${telegramText(fact.name, NAME_MAX)} ${telegramText(amountText(fact.amount, fact.currency), 60)} · ${state}${why}\n${where}`;
}

/**
 * /waiting (R9, R11): each payment a person must decide, why the agent stopped it, and where to decide it, then once
 * that opening a link approves nothing. A payment that would pass the length limit is counted, never cut, so no link is
 * cut in two.
 */
export function waitingMessage(workspaceName: string, facts: WaitingFact[], origin: string, slug: string): string {
  const name = `<b>${telegramText(workspaceName, NAME_MAX)}</b>`;
  if (facts.length === 0) return `${name} · Nothing waits for a person.`;
  const more = (n: number) => `…and ${n} more in ${link(orgUrl(origin, slug, "/console"), "the console")}.`;
  // Room kept for the closing lines, whatever is left out.
  const closing = `\n\n${more(facts.length)}\n\n${NEVER_APPROVES}`.length;
  let message = `${name} · ${facts.length === 1 ? "1 payment waits" : `${facts.length} payments wait`} for a person`;
  let shown = 0;
  for (const fact of facts) {
    const block = `\n\n${waitingBlock(fact, origin, slug)}`;
    if (message.length + block.length + closing > MESSAGE_MAX) break;
    message += block;
    shown += 1;
  }
  const left = facts.length - shown;
  return `${message}${left > 0 ? `\n\n${more(left)}` : ""}\n\n${NEVER_APPROVES}`;
}

/** The ledger's verification, as the console's Verify hash chain says it (R9). */
export function ledgerMessage(workspaceName: string, result: VerificationResult): string {
  const head = bold(workspaceName);
  if (result.valid === true) {
    return `${head} · the ledger is intact: ${COUNT.format(result.checkedEntries)} entries, each signed and linked to the one before.`;
  }
  if (result.valid === false) {
    return `${head} · the ledger does not verify at entry ${result.brokenAt ?? "?"}: ${escapeHtml(result.reason ?? "unknown reason")}.`;
  }
  return `${head} · the ledger was not checked: ${escapeHtml(result.reason ?? "this deployment has no key to check it with")}.`;
}


/** An invoice read from what the member sent, every field shown for them to check before they add it (R10). */
export function draftMessage(read: InvoiceDraftRead): string {
  const { draft } = read;
  const lines = [
    `${bold(`Read the invoice from ${read.counterpartyName ?? draft.vendorName ?? "a vendor"}.`)} Check it before adding it as a payable.`,
    "",
    `Amount: ${escapeHtml(amountText(draft.amount ?? 0, draft.currency ?? "USDC"))}`,
    `Due: ${escapeHtml(draft.dueDate ?? "not read")}`,
    `Purchase order: ${escapeHtml(draft.poReference ?? "none")}`,
  ];
  if (draft.earlyPayDiscountPct && draft.discountDeadline) {
    lines.push(`Early payment: ${escapeHtml(`${draft.earlyPayDiscountPct}% if paid by ${draft.discountDeadline}`)}`);
  }
  if (draft.invoiceNumber) lines.push(`Invoice number: ${escapeHtml(draft.invoiceNumber)}`);
  if (draft.memo) lines.push(`Memo: ${escapeHtml(draft.memo)}`);
  for (const warning of read.warnings) lines.push(`⚠️ ${escapeHtml(clip(warning, ITEM_DETAIL_MAX))}`);
  if (read.modelNote) lines.push(`<i>${escapeHtml(clip(`The model's note: ${read.modelNote}`, ITEM_DETAIL_MAX))}</i>`);
  lines.push("", `Read by ${READER_NAMES[read.reader]}. The agent decides once it is added; nothing is paid from this chat.`);
  return clip(lines.join("\n"), MESSAGE_MAX);
}

/** An invoice that cannot be added from the chat as it was read, and where to finish it (R10). */
export function missingMessage(read: InvoiceDraftRead, reasons: string[], invoicesUrl: string): string {
  const from = read.counterpartyName ?? read.draft.vendorName;
  return clip(
    [
      `${bold(`Read the invoice${from ? ` from ${from}` : ""}`)}, but it cannot be added from here:`,
      ...reasons.map((reason) => `• ${escapeHtml(reason)}`),
      "",
      `Add it in Vestiarion, where you can fix each field: ${link(invoicesUrl, "Bills & receivables")}.`,
    ].join("\n"),
    MESSAGE_MAX
  );
}

/** The bot's command menu, as `npm run telegram:setup` registers it with Telegram. */
export const BOT_COMMANDS = [
  { command: "today", description: "Safe to spend today, what waits for a person, what the agent pays next" },
  { command: "waiting", description: "The payments waiting for a person, and why" },
  { command: "ledger", description: "Check that the signed ledger is intact" },
  { command: "workspaces", description: "Switch between your connected workspaces" },
  { command: "disconnect", description: "Stop sending this workspace's decisions here" },
  { command: "help", description: "What the bot does, and what it never does" },
] as const;

/** What the bot does, for /help, /start without a code, and anything it does not understand. */
export function helpMessage(connected: boolean, workspaceName?: string): string {
  if (!connected) {
    return [
      "This chat is not connected to a Vestiarion workspace yet.",
      "",
      `In Vestiarion, open ${bold("Settings")}, press ${bold("Connect Telegram")} under Notifications, and open the link it gives you. The link works once, for 10 minutes.`,
    ].join("\n");
  }
  return [
    `Connected to ${bold(workspaceName ?? "your workspace")}. The agent's decisions there are sent to this chat.`,
    "",
    "/today: safe to spend today, what waits for a person, what the agent pays next",
    "/waiting: the payments waiting for a person, and why",
    "/ledger: check that the signed ledger is intact",
    "/workspaces: switch between your connected workspaces",
    "/disconnect: stop sending this workspace's decisions here",
    "",
    "Send an invoice as a PDF, or paste its text, and I will read it for you to add as a payable.",
    "I never approve or pay anything: what the agent stopped is decided in Vestiarion.",
  ].join("\n");
}

/** The answer to a group, a supergroup or a channel (R3). */
export const PRIVATE_ONLY =
  "I only work in a private chat, so a workspace's payments are never shown to people who are not its members.";
