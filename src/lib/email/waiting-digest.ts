import { escapeHtml } from "./html";

/**
 * The digest email that tells the members who can decide payments which
 * payables are waiting for them (notifications design N3, N4, N7). Follows
 * the look of `invitationEmail` and its `escapeHtml`.
 */

export interface DigestItem {
  counterpartyName: string;
  amount: number;
  /** USDC unless the invoice is in EURC. */
  currency?: string;
  status: "held" | "flagged" | "awaiting_info";
  reason: string | null;
  escalated: boolean;
}

export const DIGEST_MAX_ITEMS = 10;
export const DIGEST_REASON_MAX = 140;

const STATUS_LABEL: Record<DigestItem["status"], string> = {
  held: "Held",
  flagged: "Flagged",
  awaiting_info: "Waiting for information",
};

/**
 * The first sentence of `text`, with anything in square brackets (such as a
 * guardrail note) dropped first, trimmed to at most `max` characters with an
 * ellipsis when it would otherwise run longer.
 */
export function firstSentence(text: string | null, max: number = DIGEST_REASON_MAX): string | null {
  if (text === null) return null;
  const withoutBrackets = text.replace(/\s*\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
  if (withoutBrackets === "") return null;
  // A sentence ends at `.`, `!` or `?` followed by whitespace or the end of
  // the text — not at any `.`, so a decimal amount ("150.5 USDC") doesn't
  // end it. An abbreviation followed by a space ("Corp. is") still reads as
  // an ending here; accepted, since there is no reliable way to tell the two
  // apart from the text alone.
  const match = withoutBrackets.match(/^.*?[.!?](?=\s|$)/s);
  const sentence = (match ? match[0] : withoutBrackets).trim();
  if (sentence.length <= max) return sentence;
  return `${sentence.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function formatAmount(amount: number): string {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(amount);
}

interface RenderedLine {
  counterpartyName: string;
  amountText: string;
  statusLabel: string;
  reminder: boolean;
  reason: string | null;
}

function renderLines(items: DigestItem[]): RenderedLine[] {
  return items.slice(0, DIGEST_MAX_ITEMS).map((item) => ({
    counterpartyName: item.counterpartyName,
    amountText: `${formatAmount(item.amount)} ${item.currency ?? "USDC"}`,
    statusLabel: STATUS_LABEL[item.status],
    reminder: item.escalated,
    reason: firstSentence(item.reason),
  }));
}

export function waitingDigestEmail(input: {
  orgName: string;
  items: DigestItem[];
  link: string;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { orgName, items, link, origin } = input;
  const n = items.length;
  const subject = `${n} payment${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a decision in ${orgName}`;

  const orgNameSafe = escapeHtml(orgName);
  const linkSafe = escapeHtml(link);
  const originSafe = escapeHtml(origin);
  const lines = renderLines(items);
  const more = n - lines.length;
  const footer = `You get this because you can approve payments in ${orgName}. You can turn these emails off in Settings, under Notifications.`;
  const footerSafe = `You get this because you can approve payments in ${orgNameSafe}. You can turn these emails off in Settings, under Notifications.`;

  const htmlItems = lines
    .map((line) => {
      const reasonHtml = line.reason ? ` &mdash; ${escapeHtml(line.reason)}` : "";
      const reminderHtml = line.reminder ? ` <span style="color:#b3541e;">(reminder)</span>` : "";
      return `<tr><td style="padding:10px 0;border-top:1px solid #ddd8ca;font-size:14px;line-height:20px;color:#18211c;">` +
        `<strong>${escapeHtml(line.counterpartyName)}</strong> &mdash; ${escapeHtml(line.amountText)} &mdash; ` +
        `<span style="color:#4d5a53;">${escapeHtml(line.statusLabel)}</span>${reminderHtml}${reasonHtml}</td></tr>`;
    })
    .join("\n");
  const moreHtml = more > 0
    ? `<tr><td style="padding:10px 0;border-top:1px solid #ddd8ca;font-size:13px;line-height:20px;color:#646c67;">and ${more} more</td></tr>`
    : "";

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Payments waiting for a decision</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f0e7;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${n} payment${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a decision in ${orgNameSafe}.&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f0e7;">
  <tr>
    <td align="center" style="padding:40px 16px 48px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">

        <tr>
          <td style="padding:0 4px 24px 4px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="vertical-align:middle;"><img src="${originSafe}/email/logo.png" width="48" height="48" alt="Vestiarion" style="display:block;border:0;outline:none;text-decoration:none;"></td>
                <td style="vertical-align:middle;padding-left:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:20px;font-weight:700;letter-spacing:3px;color:#3048c9;">VESTIARION</td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="background-color:#fffefa;border:1px solid #ddd8ca;border-radius:16px;padding:40px 40px 32px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            <p style="margin:0 0 12px 0;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:2px;text-transform:uppercase;color:#646c67;">Waiting for a decision</p>
            <h1 style="margin:0 0 16px 0;font-size:26px;line-height:32px;font-weight:700;color:#18211c;">${n} payment${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a decision</h1>
            <p style="margin:0 0 20px 0;font-size:15px;line-height:24px;color:#4d5a53;">These are waiting for a decision in <strong style="color:#18211c;">${orgNameSafe}</strong>.</p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${htmlItems}
${moreHtml}
            </table>

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 20px 0;">
              <tr>
                <td align="center" bgcolor="#3048c9" style="border-radius:10px;background-color:#3048c9;">
                  <a href="${linkSafe}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">Open the inbox</a>
                </td>
              </tr>
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #ddd8ca;font-size:0;line-height:0;">&nbsp;</td></tr></table>

            <p style="margin:20px 0 8px 0;font-size:13px;line-height:20px;color:#4d5a53;">Button not working? Copy this address into your browser:</p>
            <p style="margin:0;padding:12px 14px;background-color:#f3f0e7;border:1px solid #ddd8ca;border-radius:8px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:12px;line-height:18px;word-break:break-all;"><a href="${linkSafe}" target="_blank" style="color:#3048c9;text-decoration:none;">${linkSafe}</a></p>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 4px 0 4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#646c67;">
            <p style="margin:0 0 6px 0;">${footerSafe}</p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const textLines = lines.map((line) => {
    const reminder = line.reminder ? " (reminder)" : "";
    const reason = line.reason ? ` — ${line.reason}` : "";
    return `- ${line.counterpartyName} — ${line.amountText} — ${line.statusLabel}${reminder}${reason}`;
  });
  if (more > 0) textLines.push(`and ${more} more`);

  const text = [
    `${n} payment${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a decision in ${orgName}.`,
    "",
    ...textLines,
    "",
    "Open the inbox:",
    link,
    "",
    footer,
  ].join("\n");

  return { subject, html, text };
}
