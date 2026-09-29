import type { OrgRole } from "../auth/roles";
import { escapeHtml } from "./html";

/**
 * The invitation email a person receives when someone adds them to a
 * workspace (spec §7, §10 step 5b). Follows the look of
 * `supabase/templates/magic-link.html`.
 */

export function invitationEmail(input: {
  orgName: string;
  role: OrgRole;
  link: string;
  expiresAt: Date;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { orgName, role, link, expiresAt, origin } = input;
  const orgNameSafe = escapeHtml(orgName);
  const roleSafe = escapeHtml(role);
  const linkSafe = escapeHtml(link);
  const originSafe = escapeHtml(origin);
  const expiryDate = expiresAt.toISOString().slice(0, 10);
  const expiryLine = `This invitation expires on ${expiryDate} (UTC). Accept it while signed in with this email address.`;
  const subject = `You're invited to ${orgName} on Vestiarion`;

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>You&rsquo;re invited to Vestiarion</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f0e7;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">You&rsquo;ve been invited to join ${orgNameSafe} on Vestiarion.&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
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
            <p style="margin:0 0 12px 0;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:2px;text-transform:uppercase;color:#646c67;">Workspace invitation</p>
            <h1 style="margin:0 0 16px 0;font-size:26px;line-height:32px;font-weight:700;color:#18211c;">You&rsquo;re invited to ${orgNameSafe}</h1>
            <p style="margin:0;font-size:15px;line-height:24px;color:#4d5a53;">You&rsquo;ve been invited to join <strong style="color:#18211c;">${orgNameSafe}</strong> on Vestiarion with the <strong style="color:#18211c;">${roleSafe}</strong> role. Use the button below to accept.</p>

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 20px 0;">
              <tr>
                <td align="center" bgcolor="#3048c9" style="border-radius:10px;background-color:#3048c9;">
                  <a href="${linkSafe}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">Accept invitation</a>
                </td>
              </tr>
            </table>

            <p style="margin:0 0 28px 0;font-size:13px;line-height:20px;color:#646c67;">${expiryLine}</p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #ddd8ca;font-size:0;line-height:0;">&nbsp;</td></tr></table>

            <p style="margin:20px 0 8px 0;font-size:13px;line-height:20px;color:#4d5a53;">Button not working? Copy this address into your browser:</p>
            <p style="margin:0;padding:12px 14px;background-color:#f3f0e7;border:1px solid #ddd8ca;border-radius:8px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:12px;line-height:18px;word-break:break-all;"><a href="${linkSafe}" target="_blank" style="color:#3048c9;text-decoration:none;">${linkSafe}</a></p>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 4px 0 4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#646c67;">
            <p style="margin:0 0 6px 0;"><strong style="color:#4d5a53;">Vestiarion</strong> &middot; An autonomous treasury agent, settled in USDC on Arc.</p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    `You've been invited to join ${orgName} on Vestiarion with the ${role} role.`,
    "",
    "Accept your invitation:",
    link,
    "",
    expiryLine,
  ].join("\n");

  return { subject, html, text };
}
