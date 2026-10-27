import Link from "next/link";
import { TRY_HREF, TRY_LABEL } from "@/components/landing/cta";
import { Button } from "@/components/ui/Button";

/**
 * The free bill list check's call to action (docs/superpowers/specs/2026-10-28-check-bills-design.md CB11): what
 * Vestiarion does with the same bills, and **Try it on your bills**, where the landing's goes. Kept in its own file,
 * apart from the checker, so recording where a workspace came from can be added here alone (CB9).
 */
export function CheckBillsCta() {
  return (
    <section aria-labelledby="check-bills-in-vestiarion" className="mt-10 rounded-2xl border border-line bg-surface px-5 py-6 sm:px-6">
      <h2 id="check-bills-in-vestiarion" className="text-lg font-semibold tracking-[-0.01em] text-ink">
        What Vestiarion does with your bills
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-ink-2">
        Vestiarion runs its duplicate check, purchase-order match, sanctions screening and a payee lock on every new bill, and weighs
        early-payment discounts and late fees, before it pays. Start a shadow workspace and drop this same file into its bill import.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-ink-3">
        The import takes up to 200 bills at a time, for vendors you have added in Counterparties, and shows what happens to every row before
        anything is added.
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button asChild>
          <Link href={TRY_HREF} data-cta="check-bills-start">
            {TRY_LABEL}
          </Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href="/docs/guides/import-bills">How the bill import works</Link>
        </Button>
      </div>
      <p className="mt-3 text-sm text-ink-3">In shadow mode it decides on your real bills while you keep paying them as you do now.</p>
    </section>
  );
}
