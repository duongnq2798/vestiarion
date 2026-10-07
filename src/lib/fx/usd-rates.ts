/**
 * The day's rate for a bill's currency against the US dollar (docs/superpowers/specs/2026-10-07-shadow-mode-design.md
 * S6): how many of the currency make one dollar, which a USDC is worth. From ExchangeRate-API's open endpoint
 * (open.er-api.com, no key, published once a day; its terms ask for attribution, which the pages that show a rate give).
 * Read at most once an hour per server; a rate that cannot be read is said, never guessed. Nothing about the business or
 * its bills is sent: the request names only the dollar.
 */

const SOURCE_URL = "https://open.er-api.com/v6/latest/USD";
const READ_EVERY_MS = 60 * 60_000;
const TIMEOUT_MS = 10_000;

export interface UsdRate {
  currency: string;
  /** How many of the currency make one US dollar. */
  perUsd: number;
  source: string;
  /** When the source published the rate. */
  at: string;
}

export class FxRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FxRateError";
  }
}

const UNREADABLE = "The day's rate could not be read. Try again in a moment.";

let kept: { readAt: number; at: string; rates: Record<string, number> } | null = null;

/** Forgets the rates read, so the next ask reads them again: for tests. */
export function forgetUsdRates(): void {
  kept = null;
}

async function readRates(fetchFn: typeof fetch, now: number): Promise<{ at: string; rates: Record<string, number> }> {
  if (kept && now - kept.readAt < READ_EVERY_MS) return kept;
  let body: { result?: unknown; time_last_update_unix?: unknown; rates?: unknown };
  try {
    const response = await fetchFn(SOURCE_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`status ${response.status}`);
    body = (await response.json()) as typeof body;
  } catch {
    throw new FxRateError(UNREADABLE);
  }
  if (body.result !== "success" || typeof body.rates !== "object" || body.rates === null || typeof body.time_last_update_unix !== "number") {
    throw new FxRateError(UNREADABLE);
  }
  const rates = Object.fromEntries(
    Object.entries(body.rates as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0)
  );
  // An answer with no usable rate is no answer: nothing is kept, and the next ask reads again.
  if (Object.keys(rates).length === 0) throw new FxRateError(UNREADABLE);
  kept = { readAt: now, at: new Date(body.time_last_update_unix * 1000).toISOString(), rates };
  return kept;
}

export async function usdRate(currency: string, deps: { fetch?: typeof fetch; now?: () => number } = {}): Promise<UsdRate> {
  const code = currency.trim().toUpperCase();
  const now = (deps.now ?? Date.now)();
  if (code === "USD") return { currency: "USD", perUsd: 1, source: "USD = USDC", at: new Date(now).toISOString() };
  const { at, rates } = await readRates(deps.fetch ?? fetch, now);
  const perUsd = rates[code];
  if (perUsd === undefined) throw new FxRateError(`There is no rate for ${code}. Choose another currency.`);
  return { currency: code, perUsd, source: "ExchangeRate-API", at };
}
