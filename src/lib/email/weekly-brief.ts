import { escapeHtml } from "./html";

/**
 * The agent's weekly brief (docs/superpowers/specs/2026-10-18-weekly-brief-design.md W3): what it did in the last 7 days,
 * what waits for a person, what leaves in the next 7 days and whether the cash covers it. Every figure is worked out by
 * code; the email only says them. Follows the look of `waitingDigestEmail`.
 */

export interface WeeklyBriefFacts {
  /** The ISO week, "2026-W43". */
  week: string;
  /** The last 7 days, `YYYY-MM-DD`, both days included. */
  from: string;
  to: string;
  paid: { count: number; usdc: number };
  received: { count: number; usdc: number };
  decisions: number;
  waiting: number;
  next7: {
    count: number;
    usdc: number;
    /** The first few, by day. */
    lines: Array<{ day: string; label: string; amount: number; note: string }>;
    expectedUsdc: number;
  };
  cash: {
    operating: number;
    reserve: number;
    /** How short the wallet runs within 30 days; null when it never does. */
    short: { shortOn: string; shortBy: number; lowestOn: string; need: number } | null;
  };
  /**
   * In shadow mode (W6): the verdicts given in the last 7 days, and since shadow mode began (`since`, `YYYY-MM-DD`). Null
   * outside it. The wallet then only mirrors agreed payments, so `cash.short` is null.
   */
  shadow?: { verdicts: { given: number; agreed: number }; sinceStart: { given: number; agreed: number; since: string } } | null;
  /**
   * Payee addresses in the last 7 days (docs/superpowers/specs/2026-10-22-weekly-brief-payee-lock-design.md WP1): whether
   * the payee lock is on, addresses changed and confirmed, payments the agent held for an address, payees' contacts asked
   * "Was this you?" and those who said not, and payees frozen now. Absent where it could not be read.
   */
  payees?: { lockOn: boolean; changed: number; confirmed: number; held: number; asked: number; notMe: number; frozen: number } | null;
}

export const BRIEF_LINES = 5;

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdc = (value: number) => `${AMOUNT.format(value)} USDC`;
/** What is short, up to the cent: it is what to bring in. */
const shortUsdc = (value: number) => usdc(Math.ceil(Math.round(value * 1e6) / 1e4) / 100);
const day = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const NOTE: Record<string, string> = {
  scheduled: "scheduled",
  held: "held for you",
  due: "due",
  overdue: "overdue",
  verified: "milestone, verified",
  "payable once verified": "milestone, once verified",
};

/**
 * What the brief says of payee addresses (WP2), or nothing in a week with none of it. A frozen payee is said first: it is
 * the one a person must act on.
 */
export function payeeSentences(payees: WeeklyBriefFacts["payees"]): string[] {
  if (!payees) return [];
  const said: string[] = [];
  if (payees.frozen > 0) {
    said.push(`${plural(payees.frozen, "payee is", "payees are")} frozen: their contact said they did not make a change to their address. An owner or admin unfreezes one on Counterparties after checking with them.`);
  }
  if (payees.changed > 0) {
    said.push(`${plural(payees.changed, "payee address", "payee addresses")} changed${payees.confirmed > 0 ? `, and ${plural(payees.confirmed, "address was", "addresses were")} confirmed` : ""}.`);
  } else if (payees.confirmed > 0) {
    said.push(`${plural(payees.confirmed, "payee address was", "payee addresses were")} confirmed.`);
  }
  if (payees.held > 0) said.push(`The agent held ${plural(payees.held, "payment", "payments")} for an address no one had confirmed, or one an invoice asked for instead.`);
  if (payees.asked > 0) {
    said.push(`${plural(payees.asked, "payee's contact was", "payees' contacts were")} asked whether they made a change${payees.notMe > 0 ? `, and ${payees.notMe} said they did not` : ""}.`);
  }
  if (said.length > 0 && !payees.lockOn) said.push("The payee lock is off: turn it on in Settings to have a second person record how each changed address was checked.");
  return said;
}

/** The brief's sentences, shared by the HTML and the text version. */
export function briefSentences(facts: WeeklyBriefFacts): {
  lastWeek: string[];
  waiting: string;
  ahead: string;
  lines: string[];
  more: number;
  cash: string;
  payees: string[];
} {
  const shadow = facts.shadow ?? null;
  const lastWeek = shadow
    ? [
        `Made ${plural(facts.decisions, "decision", "decisions")} on your bills; in shadow mode each waits for your verdict.`,
        shadow.verdicts.given > 0 ? `You gave ${plural(shadow.verdicts.given, "verdict", "verdicts")} and agreed with ${shadow.verdicts.agreed}.` : "You gave no verdict.",
        facts.paid.count > 0 ? `Paid ${plural(facts.paid.count, "bill you agreed with", "bills you agreed with")} on Arc testnet, ${usdc(facts.paid.usdc)} in all.` : "Paid nothing on Arc testnet.",
        ...(facts.received.count > 0 ? [`Customers paid ${plural(facts.received.count, "invoice", "invoices")}, ${usdc(facts.received.usdc)}.`] : []),
      ]
    : [
        facts.paid.count > 0 ? `Paid ${plural(facts.paid.count, "payment", "payments")}, ${usdc(facts.paid.usdc)} in all.` : "Paid nothing.",
        facts.received.count > 0 ? `Customers paid ${plural(facts.received.count, "invoice", "invoices")}, ${usdc(facts.received.usdc)}.` : "No customer payment came in.",
        `Made ${plural(facts.decisions, "decision", "decisions")}, each signed with its reasoning.`,
      ];
  const waiting =
    facts.waiting > 0
      ? `${plural(facts.waiting, "payment waits", "payments wait")} for ${shadow ? "your verdict or a decision" : "a decision"} from you.`
      : "Nothing waits for you.";
  const ahead =
    facts.next7.count > 0
      ? `${plural(facts.next7.count, "payment leaves", "payments leave")} in the next 7 days, ${usdc(facts.next7.usdc)} in all${facts.next7.expectedUsdc > 0 ? `, and customers owe ${usdc(facts.next7.expectedUsdc)} by then` : ""}.`
      : `Nothing is due in the next 7 days${facts.next7.expectedUsdc > 0 ? `, and customers owe ${usdc(facts.next7.expectedUsdc)}` : ""}.`;
  const lines = facts.next7.lines.slice(0, BRIEF_LINES).map((line) => `${day(line.day)}: ${line.label}, ${usdc(line.amount)}${NOTE[line.note] ? ` (${NOTE[line.note]})` : ""}`);
  const short = facts.cash.short;
  const cash = shadow
    ? `${shadow.sinceStart.given > 0 ? `Since shadow mode began on ${day(shadow.sinceStart.since)}, you agreed with the agent on ${shadow.sinceStart.agreed} of ${plural(shadow.sinceStart.given, "decision", "decisions")}.` : `Shadow mode began on ${day(shadow.sinceStart.since)}.`} Your own money did not move: you keep paying your bills as before.`
    : short
    ? short.lowestOn === short.shortOn
      ? `The cash runs short on ${day(short.shortOn)}: ${shortUsdc(short.need)} more is needed by then.`
      : `The cash runs short on ${day(short.shortOn)}: ${shortUsdc(short.shortBy)} short that day, and ${shortUsdc(short.need)} by ${day(short.lowestOn)}.`
    : `The cash covers everything due in the next 30 days: ${usdc(facts.cash.operating + facts.cash.reserve)} in the wallet${facts.cash.reserve > 0 ? " and the reserve" : ""}.`;
  return { lastWeek, waiting, ahead, lines, more: Math.max(0, facts.next7.count - lines.length), cash, payees: payeeSentences(facts.payees ?? null) };
}

export function weeklyBriefEmail(input: {
  orgName: string;
  facts: WeeklyBriefFacts;
  /** `invite`, when the workspace has one member: Members, with the approver role chosen (invite nudge I4). */
  links: { console: string; approvals: string; plan: string; invite?: string };
  origin: string;
}): {
  subject: string;
  html: string;
  text: string;
} {
  const { orgName, facts, links, origin } = input;
  const said = briefSentences(facts);
  const subject = facts.shadow
    ? facts.shadow.sinceStart.given > 0
      ? `${orgName}: you agreed with the agent on ${facts.shadow.sinceStart.agreed} of ${facts.shadow.sinceStart.given} · your week in shadow mode`
      : `${orgName}: your week with the agent in shadow mode`
    : facts.cash.short
      ? `${orgName}: the cash runs short on ${day(facts.cash.short.shortOn)} · your week with the agent`
      : `${orgName}: your week with the agent`;
  const footer = `You get this because you can approve payments in ${orgName} and keep its emails on. You can turn them off in Settings, under Notifications.`;
  const alone = `You run ${orgName} alone on Vestiarion. Invite your approver or your accountant:`;

  const text = [
    `${orgName}, ${day(facts.from)} to ${day(facts.to)}`,
    "",
    "Last 7 days",
    ...said.lastWeek.map((line) => `- ${line}`),
    "",
    said.waiting,
    "",
    ...(said.payees.length > 0 ? ["Payee addresses", ...said.payees.map((line) => `- ${line}`), ""] : []),
    "Next 7 days",
    said.ahead,
    ...said.lines.map((line) => `- ${line}`),
    ...(said.more > 0 ? [`- and ${said.more} more`] : []),
    "",
    said.cash,
    "",
    `Console: ${links.console}`,
    ...(facts.waiting > 0 ? [`Approvals: ${links.approvals}`] : []),
    `Payment plan: ${links.plan}`,
    ...(links.invite ? ["", `${alone} ${links.invite}`] : []),
    "",
    footer,
  ].join("\n");

  const p = (body: string, color = "#4d5a53") => `<p style="margin:0 0 10px 0;font-size:15px;line-height:24px;color:${color};">${body}</p>`;
  const heading = (body: string) =>
    `<p style="margin:24px 0 10px 0;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:2px;text-transform:uppercase;color:#646c67;">${body}</p>`;
  const row = (body: string) => `<tr><td style="padding:8px 0;border-top:1px solid #ddd8ca;font-size:14px;line-height:20px;color:#18211c;">${body}</td></tr>`;
  const button = (href: string, label: string) =>
    `<td align="center" bgcolor="#3048c9" style="border-radius:10px;background-color:#3048c9;"><a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a></td>`;
  const orgNameSafe = escapeHtml(orgName);
  const cashColor = facts.cash.short && !facts.shadow ? "#b3541e" : "#18211c";

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Your week with the agent</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f0e7;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f0e7;">
  <tr>
    <td align="center" style="padding:40px 16px 48px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr>
          <td style="padding:0 4px 24px 4px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="vertical-align:middle;"><img src="${escapeHtml(origin)}/email/logo.png" width="48" height="48" alt="Vestiarion" style="display:block;border:0;outline:none;text-decoration:none;"></td>
                <td style="vertical-align:middle;padding-left:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:20px;font-weight:700;letter-spacing:3px;color:#3048c9;">VESTIARION</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background-color:#fffefa;border:1px solid #ddd8ca;border-radius:16px;padding:36px 36px 28px 36px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            <p style="margin:0 0 12px 0;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:2px;text-transform:uppercase;color:#646c67;">Your week with the agent${facts.shadow ? " · shadow mode" : ""}</p>
            <h1 style="margin:0 0 16px 0;font-size:24px;line-height:30px;font-weight:700;color:#18211c;">${orgNameSafe}, ${escapeHtml(day(facts.from))} to ${escapeHtml(day(facts.to))}</h1>
            ${p(escapeHtml(said.cash), cashColor)}
            ${heading("Last 7 days")}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${said.lastWeek.map((line) => row(escapeHtml(line))).join("\n")}
            </table>
            ${heading("Waiting for you")}
            ${p(escapeHtml(said.waiting))}${
              said.payees.length > 0
                ? `
            ${heading("Payee addresses")}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${said.payees.map((line) => row(escapeHtml(line))).join("\n")}
            </table>`
                : ""
            }
            ${heading("Next 7 days")}
            ${p(escapeHtml(said.ahead))}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${said.lines.map((line) => row(escapeHtml(line))).join("\n")}
${said.more > 0 ? row(`<span style="color:#646c67;">and ${said.more} more</span>`) : ""}
            </table>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 8px 0;">
              <tr>
                ${facts.waiting > 0 ? `${button(links.approvals, "Decide what waits")}<td style="width:10px;"></td>` : ""}${button(links.plan, "See the payment plan")}
              </tr>
            </table>
            <p style="margin:16px 0 0 0;font-size:13px;line-height:20px;color:#4d5a53;">The console: <a href="${escapeHtml(links.console)}" target="_blank" style="color:#3048c9;text-decoration:none;">${escapeHtml(links.console)}</a></p>${
              links.invite
                ? `
            <p style="margin:12px 0 0 0;font-size:13px;line-height:20px;color:#4d5a53;">${escapeHtml(alone)} <a href="${escapeHtml(links.invite)}" target="_blank" style="color:#3048c9;text-decoration:none;">Invite them</a></p>`
                : ""
            }
          </td>
        </tr>
        <tr>
          <td style="padding:28px 4px 0 4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#646c67;">
            <p style="margin:0 0 6px 0;">${escapeHtml(footer)}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
  return { subject, html, text };
}
