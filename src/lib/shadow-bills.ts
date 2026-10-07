import { billAmount, usdcFor } from "./bill-amount";
import { db } from "./dal";
import { usdRate, type UsdRate } from "./fx/usd-rates";
import { shadowCurrency } from "./shadow-currency";
import { readShadowMode } from "./shadow-mode";

/**
 * A bill in the business's own currency, taken in shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-design.md
 * S6): its amount read as written, the USDC it is paid in at the day's rate, and the rate kept with it. Only in shadow
 * mode: elsewhere the agent pays real suppliers, who are paid in USDC or EURC, never at a converted figure. Runs inside
 * an organization scope.
 */

export { billAmount, usdcFor };

/** The bill as it was written, and the rate its USDC amount was worked out at: the invoice's `original_*` columns. */
export interface OriginalBill {
  currency: string;
  amount: number;
  /** How many of the currency made one US dollar. */
  perUsd: number;
  source: string;
  /** When the source published the rate. */
  at: string;
}

export type ShadowBillErrorCode = "not_in_shadow" | "invalid_currency" | "amount" | "too_small";

const MESSAGES: Record<ShadowBillErrorCode, string> = {
  not_in_shadow: "A bill in another currency is taken in shadow mode only. Vestiarion pays in USDC or EURC.",
  invalid_currency: "Choose the bill's currency as a three-letter code, such as VND.",
  amount: "Type the bill's amount as it is written on it, such as 2.500.000.",
  too_small: "That bill comes to less than 0.01 USDC at the day's rate.",
};

export class ShadowBillError extends Error {
  constructor(readonly code: ShadowBillErrorCode) {
    super(MESSAGES[code]);
    this.name = "ShadowBillError";
  }
}

export async function shadowBill(
  input: { currency: string; amount: string },
  deps: { rate?: (currency: string) => Promise<UsdRate> } = {}
): Promise<{ usdc: number; original: OriginalBill }> {
  if (!(await readShadowMode(db()))) throw new ShadowBillError("not_in_shadow");
  const currency = shadowCurrency(input.currency);
  if (!currency) throw new ShadowBillError("invalid_currency");
  const amount = billAmount(input.amount, currency);
  if (amount === null) throw new ShadowBillError("amount");
  const rate = await (deps.rate ?? ((code: string) => usdRate(code)))(currency);
  const usdc = usdcFor(amount, rate.perUsd);
  if (usdc === null) throw new ShadowBillError("too_small");
  return { usdc, original: { currency, amount, perUsd: rate.perUsd, source: rate.source, at: rate.at } };
}
