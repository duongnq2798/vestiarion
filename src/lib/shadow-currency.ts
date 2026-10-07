/**
 * What shadow mode is, as the browser shows it (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S1): the
 * business's own currency, and since when. Browser-safe; `src/lib/shadow-mode.ts` reads and changes it on the server.
 */

export interface ShadowMode {
  /** USDC, for bills entered in USDC with nothing converted; or the business's own currency, ISO 4217. */
  currency: string;
  startedAt: string;
  startedBy: string | null;
}

/**
 * The currencies Settings offers, USDC first and chosen until the owner picks another: a bill entered in USDC is paid as
 * it is. Never VND: crypto is no means of payment in Vietnam, so Vestiarion does not offer to mirror a dong bill in USDC
 * (partner, 2026-10-07). The server takes any other three-letter code too.
 */
export const SHADOW_CURRENCIES = ["USDC", "USD", "EUR", "GBP", "SGD", "THB", "IDR", "PHP", "MYR", "JPY", "KRW", "INR", "AUD", "CAD"] as const;

/** A bill's currency as typed, in capitals: three letters, and never a stablecoin the agent pays in. Null otherwise. */
export function shadowCurrency(typed: string): string | null {
  const code = typed.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) && code !== "USDC" && code !== "EURC" ? code : null;
}

/** The currency shadow mode runs in, as chosen: USDC, or a bill's own currency as `shadowCurrency` reads it. Null otherwise. */
export function shadowModeCurrency(typed: string): string | null {
  const code = typed.trim().toUpperCase();
  return code === "USDC" ? code : shadowCurrency(code);
}

/** The currency the invoice form converts a bill from, in this shadow mode: none in USDC, or outside shadow mode. */
export function billCurrencyOf(mode: { currency?: string } | null | undefined): string | undefined {
  return mode?.currency && mode.currency !== "USDC" ? mode.currency : undefined;
}
