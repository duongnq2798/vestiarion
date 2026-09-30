/**
 * A minimal singular/plural chooser. `one` and `many` are whatever text the
 * caller wants for each case — often a full phrase with the count already
 * interpolated in, not just a bare word — so this stays a ternary with a
 * name, not a pluralization engine.
 */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * An instant's day in UTC, with the month named: "Sep 30, 2026". Built by hand
 * rather than with `Intl`, so a server render and the browser's hydration
 * produce the same text whatever their locale data.
 */
export function utcDay(iso: string): string {
  const at = new Date(iso);
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()}`;
}

/** An instant to the minute, in UTC: "Sep 29, 2026, 14:05 UTC". Built by hand for the same reason as `utcDay`. */
export function utcMinute(iso: string): string {
  const at = new Date(iso);
  return `${utcDay(iso)}, ${at.toISOString().slice(11, 16)} UTC`;
}

/**
 * What the console's balance tile says when the chain could not be read. A
 * fixed sentence on purpose: Circle's own error can carry request details,
 * so it is never shown or returned, only this.
 */
export const CIRCLE_UNREACHABLE = "Could not reach Circle; showing the last known balance";
