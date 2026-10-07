/**
 * What shadow mode is, as the browser shows it (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S1): the
 * business's own currency, and since when. Browser-safe; `src/lib/shadow-mode.ts` reads and changes it on the server.
 */

export interface ShadowMode {
  /** The business's own currency, ISO 4217: what its bills are written in. */
  currency: string;
  startedAt: string;
  startedBy: string | null;
}

/** The currencies Settings offers; the server takes any other three-letter code too. */
export const SHADOW_CURRENCIES = ["VND", "USD", "EUR", "GBP", "SGD", "THB", "IDR", "PHP", "MYR", "JPY", "KRW", "INR", "AUD", "CAD"] as const;

/** A bill's currency as typed, in capitals: three letters, and never a stablecoin the agent pays in. Null otherwise. */
export function shadowCurrency(typed: string): string | null {
  const code = typed.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) && code !== "USDC" && code !== "EURC" ? code : null;
}
