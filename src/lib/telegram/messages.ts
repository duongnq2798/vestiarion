import type { ActivityItem } from "../agent-activity";
import { orgHref } from "../auth/org-paths";
import { READER_NAMES } from "../invoice-document/chat-draft";
import type { InvoiceDraftRead } from "../invoice-document/draft";
import type { VerificationResult } from "../ledger";
import { arcTxUrl } from "../payee-chains";
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

function decisionBlock(item: ActivityItem, slug: string, origin: string): string {
  const lines = [`${item.tone === "done" ? "✅" : "⏸"} ${escapeHtml(clip(item.text, ITEM_TEXT_MAX))}`];
  if (item.detail) lines.push(`<i>${escapeHtml(clip(item.detail, ITEM_DETAIL_MAX))}</i>`);
  const links = [...(item.txHash ? [link(arcTxUrl(item.txHash), "Arc testnet transaction")] : []), link(orgUrl(origin, slug, item.path), item.pathLabel)];
  lines.push(links.join(" · "));
  return lines.join("\n");
}

/**
 * The agent's decisions in one workspace since the chat was last told (R8): one block each, with its reasons, its
 * transaction and the page where a person sees or handles it. Decisions that would pass the length limit are left to
 * the console, and the last line says how many.
 */
export function decisionsMessage(workspace: { name: string; slug: string }, items: ActivityItem[], origin: string): string {
  const header = `${bold(workspace.name)} · the agent decided ${items.length === 1 ? "1 thing" : `${items.length} things`}`;
  const more = (n: number) => `…and ${n} more in ${link(orgUrl(origin, workspace.slug, "/console"), "the console")}.`;
  const roomForMore = more(items.length).length + 2;
  let message = header;
  let shown = 0;
  for (const item of items) {
    const block = `\n\n${decisionBlock(item, workspace.slug, origin)}`;
    const last = shown === items.length - 1;
    if (message.length + block.length + (last ? 0 : roomForMore) > MESSAGE_MAX) break;
    message += block;
    shown += 1;
  }
  return shown < items.length ? `${message}\n\n${more(items.length - shown)}` : message;
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

const WAITING_STATUS: Record<string, string> = { held: "held", flagged: "flagged", awaiting_info: "waiting for information" };

/** /waiting (R9, R11): each payment a person must decide, why the agent stopped it, and where to decide it. */
export function waitingMessage(workspaceName: string, facts: WaitingFact[], origin: string, slug: string): string {
  if (facts.length === 0) return `${bold(workspaceName)} · Nothing waits for a person.`;
  const lines = [`${bold(workspaceName)} · ${facts.length === 1 ? "1 payment waits" : `${facts.length} payments wait`} for a person`];
  for (const fact of facts) {
    const where = fact.kind === "payable" ? link(orgUrl(origin, slug, `/approvals#payable-${fact.id}`), "Decide in Approvals") : link(orgUrl(origin, slug, "/contractors"), "Contractors");
    const why = fact.reason ? `: ${escapeHtml(clip(fact.reason, ITEM_DETAIL_MAX))}` : "";
    lines.push("", `⏸ ${escapeHtml(fact.name)} ${escapeHtml(amountText(fact.amount, fact.currency))} · ${WAITING_STATUS[fact.status] ?? escapeHtml(fact.status)}${why}`, where);
  }
  return clip(lines.join("\n"), MESSAGE_MAX);
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
      `Add it in Vestiarion, where you can fix each field: ${link(invoicesUrl, "Invoices")}.`,
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
