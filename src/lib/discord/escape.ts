import { shortenAddresses } from "../telegram/messages";

/**
 * A value as a Discord message may show it (docs/superpowers/specs/2026-10-22-discord-design.md DC4). A payee's name, a
 * memo and the agent's reasons come from documents and emails anyone can send, and Discord's markdown would render them:
 * a masked link (`[Approve](https://…)`), a heading or a quote at the start of a line, a mention (`@everyone`, `<@&id>`,
 * `<#channel>`), a timestamp (`<t:…>`), or a bare URL. So every newline and run of whitespace becomes one space, no line
 * can start inside a value, wallet addresses are shortened as Telegram's and Slack's messages shorten them, and every
 * character Discord reads as markup is escaped with a backslash, which Discord shows as the character itself. Then the
 * value is clipped, never inside an escape. Pure.
 */

/** Each character Discord's markdown or its mentions read: escaped, the backslash first. */
const MARKUP = /[\\*_~`|>#\-[\]()<@:]/g;

/** How long a value is when no length is given. */
export const DISCORD_TEXT_MAX = 300;

export function discordText(value: string, max: number = DISCORD_TEXT_MAX): string {
  const escaped = shortenAddresses(value.replace(/\s+/g, " ").trim()).replace(MARKUP, (character) => `\\${character}`);
  if (escaped.length <= max) return escaped;
  let cut = escaped.slice(0, Math.max(0, max - 1)).trimEnd();
  // An odd run of backslashes at the end is an escape cut in two: its backslash would escape the ellipsis instead.
  const trailing = /\\+$/.exec(cut)?.[0].length ?? 0;
  if (trailing % 2 === 1) cut = cut.slice(0, -1);
  return `${cut}…`;
}
