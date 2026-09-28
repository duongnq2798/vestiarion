/**
 * A minimal singular/plural chooser. `one` and `many` are whatever text the
 * caller wants for each case — often a full phrase with the count already
 * interpolated in, not just a bare word — so this stays a ternary with a
 * name, not a pluralization engine.
 */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
