"use client";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { formatRateValue, rateTime, rateValue } from "@/lib/money";

/**
 * Exchange rates in Treasury's What if section (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M7): for
 * each currency an open bill was written in, a rate a person may type, how many of it make one US dollar. Empty keeps
 * each bill at the rate it was converted at; today's reference rate is offered beside it, with its source and time.
 * Nothing typed here changes a bill or a payment.
 */

/** Today's reference rate for a currency, as the page read and stored it. */
export interface RateHint {
  currency: string;
  perUsd: string;
  source: string;
  at: string;
}

export interface RateCurrency {
  currency: string;
  /** Open bills written in it, within 90 days. */
  bills: number;
}

export function ScenarioRates({
  id,
  currencies,
  hints,
  values,
  onChange,
}: {
  id: string;
  currencies: RateCurrency[];
  hints: Record<string, RateHint>;
  values: Record<string, string>;
  onChange: (currency: string, value: string) => void;
}) {
  if (currencies.length === 0) return null;
  return (
    <div className="grid gap-3 sm:col-span-2">
      <div>
        <p className="text-sm font-medium text-ink">Exchange rates</p>
        <p className="text-xs leading-5 text-ink-3">
          Bills written in another currency were worked out in USDC at the rate of their day. Type a rate to see them at it; empty keeps each bill at its own.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {currencies.map(({ currency, bills }) => {
          const hint = hints[currency];
          const typed = values[currency] ?? "";
          const invalid = typed.trim() !== "" && rateValue(typed) === null;
          return (
            <div key={currency} className="grid content-start gap-1.5">
              <Field
                id={`${id}-rate-${currency}`}
                label={`${currency} per US dollar`}
                description={
                  hint
                    ? `${bills} ${bills === 1 ? "bill" : "bills"}. Today's reference rate: ${formatRateValue(hint.perUsd)}, from ${hint.source}, published ${rateTime(hint.at)}.`
                    : `${bills} ${bills === 1 ? "bill" : "bills"}. Today's reference rate could not be read.`
                }
                error={invalid ? "Type a rate above zero, such as 1.35." : undefined}
              >
                <Input inputMode="decimal" placeholder="Each bill at its own rate" value={typed} onChange={(event) => onChange(currency, event.target.value)} />
              </Field>
              {hint && typed.trim() !== formatRateValue(hint.perUsd) && rateValue(typed) !== rateValue(hint.perUsd) && (
                <div>
                  <Button size="sm" variant="ghost" onClick={() => onChange(currency, hint.perUsd)}>
                    {`Use today's rate, ${formatRateValue(hint.perUsd)}`}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
