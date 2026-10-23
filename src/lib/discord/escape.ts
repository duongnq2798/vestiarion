import { shortenAddresses } from "../telegram/messages";

/**
 * A value as a Discord message may show it (docs/superpowers/specs/2026-10-22-discord-design.md DC4). A payee's name, a
 * memo and the agent's reasons come from documents and emails anyone can send, and Discord's markdown would render them:
 * a masked link (`[Approve](https://…)`), a heading or a quote at the start of a line, a mention (`@everyone`, `<@&id>`,
 * `<#channel>`), a timestamp (`<t:…>`), or a bare URL. So invisible format characters are removed first (bidi
 * embeddings, overrides and isolates, which would show the rest of a bill's line reversed, and zero-width characters,
 * which break up words), and so is half of an emoji left alone by an earlier cut. Every newline, control character and
 * run of whitespace becomes one space, so no line can start inside a value; wallet addresses are shortened as
 * Telegram's and Slack's messages shorten them; and every character Discord reads as markup is escaped with a
 * backslash, which Discord shows as the character itself. Then the value is clipped, never inside an escape and never
 * between the two halves of one character. Pure.
 */

/** Each character Discord's markdown or its mentions read: escaped, the backslash first. */
const MARKUP = /[\\*_~`|>#\-[\]()<@:]/g;

/**
 * Invisible format characters (Unicode's Cf): bidi embeddings, overrides and isolates, the marks that set direction,
 * zero-width spaces and joiners, the byte-order mark and the soft hyphen. Removed rather than spaced, so a zero-width
 * space inside a word joins the word back up. Spaces and combining marks are left alone: real names carry them.
 */
const FORMAT = /\p{Cf}/gu;

/** Half of a surrogate pair standing alone: what a cut in the middle of an emoji leaves, which JSON sends as a lone escape. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A high surrogate at the very end: the first half of a character a cut split. */
const HALF_AT_END = /[\uD800-\uDBFF]$/;

/** How long a value is when no length is given. */
export const DISCORD_TEXT_MAX = 300;

/**
 * `text` cut to at most `max` UTF-16 units, the measure Discord's limits and the message's budget use, never between the
 * two halves of one character.
 */
export function sliceUnits(text: string, max: number): string {
  return text.slice(0, Math.max(0, max)).replace(HALF_AT_END, "");
}

export function discordText(value: string, max: number = DISCORD_TEXT_MAX): string {
  const plain = value.replace(LONE_SURROGATE, "").replace(FORMAT, "").replace(/[\s\p{Cc}]+/gu, " ").trim();
  const escaped = shortenAddresses(plain).replace(MARKUP, (character) => `\\${character}`);
  if (escaped.length <= max) return escaped;
  let cut = sliceUnits(escaped, max - 1).trimEnd();
  // An odd run of backslashes at the end is an escape cut in two: its backslash would escape the ellipsis instead.
  const trailing = /\\+$/.exec(cut)?.[0].length ?? 0;
  if (trailing % 2 === 1) cut = cut.slice(0, -1);
  return `${cut}…`;
}
