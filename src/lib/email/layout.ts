import { escapeHtml } from "./html";

/**
 * One call to action in Vestiarion's email look (the invitation's, after
 * `supabase/templates/magic-link.html`): logo, a card with an eyebrow, a
 * heading, paragraphs, one button, a note, and the link spelled out for
 * clients that drop the button. Plain strings are escaped here;
 * `paragraphsHtml` is HTML its caller has already escaped.
 */
export function actionEmailHtml(input: {
  title: string;
  preheader: string;
  eyebrow: string;
  heading: string;
  paragraphsHtml: string[];
  button: { label: string; link: string };
  note: string;
  origin: string;
}): string {
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const mono = "'SFMono-Regular',Menlo,Consolas,monospace";
  const link = escapeHtml(input.button.link);
  const origin = escapeHtml(input.origin);
  const paragraphs = input.paragraphsHtml
    .map((html, index) => `<p style="margin:${index === 0 ? "0" : "12px 0 0 0"};font-size:15px;line-height:24px;color:#4d5a53;">${html}</p>`)
    .join("\n            ");

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f0e7;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f0e7;">
  <tr>
    <td align="center" style="padding:40px 16px 48px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr>
          <td style="padding:0 4px 24px 4px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="vertical-align:middle;"><img src="${origin}/email/logo.png" width="48" height="48" alt="Vestiarion" style="display:block;border:0;outline:none;text-decoration:none;"></td>
                <td style="vertical-align:middle;padding-left:12px;font-family:${font};font-size:15px;line-height:20px;font-weight:700;letter-spacing:3px;color:#3048c9;">VESTIARION</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background-color:#fffefa;border:1px solid #ddd8ca;border-radius:16px;padding:40px 40px 32px 40px;font-family:${font};">
            <p style="margin:0 0 12px 0;font-family:${mono};font-size:11px;line-height:16px;letter-spacing:2px;text-transform:uppercase;color:#646c67;">${escapeHtml(input.eyebrow)}</p>
            <h1 style="margin:0 0 16px 0;font-size:26px;line-height:32px;font-weight:700;color:#18211c;">${escapeHtml(input.heading)}</h1>
            ${paragraphs}
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 20px 0;">
              <tr>
                <td align="center" bgcolor="#3048c9" style="border-radius:10px;background-color:#3048c9;">
                  <a href="${link}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${font};font-size:15px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(input.button.label)}</a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 28px 0;font-size:13px;line-height:20px;color:#646c67;">${escapeHtml(input.note)}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #ddd8ca;font-size:0;line-height:0;">&nbsp;</td></tr></table>
            <p style="margin:20px 0 8px 0;font-size:13px;line-height:20px;color:#4d5a53;">Button not working? Copy this address into your browser:</p>
            <p style="margin:0;padding:12px 14px;background-color:#f3f0e7;border:1px solid #ddd8ca;border-radius:8px;font-family:${mono};font-size:12px;line-height:18px;word-break:break-all;"><a href="${link}" target="_blank" style="color:#3048c9;text-decoration:none;">${link}</a></p>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 4px 0 4px;font-family:${font};font-size:12px;line-height:18px;color:#646c67;">
            <p style="margin:0 0 6px 0;"><strong style="color:#4d5a53;">Vestiarion</strong> &middot; An autonomous treasury agent, settled in USDC on Arc.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
