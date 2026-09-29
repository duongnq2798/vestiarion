/**
 * A minimal singular/plural chooser. `one` and `many` are whatever text the
 * caller wants for each case — often a full phrase with the count already
 * interpolated in, not just a bare word — so this stays a ternary with a
 * name, not a pluralization engine.
 */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * An instant to the minute, in UTC: "2026-09-29 14:05 UTC". Built from the ISO
 * string rather than `Intl`, so a server render and the browser's hydration
 * produce the same text whatever their locale data.
 */
export function utcMinute(iso: string): string {
  const at = new Date(iso).toISOString();
  return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
}
