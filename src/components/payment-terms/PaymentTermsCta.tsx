import Link from "next/link";
import { TRY_HREF, TRY_LABEL } from "@/components/landing/cta";
import { Button } from "@/components/ui/Button";

/**
 * The payment terms pages' call to action (docs/superpowers/specs/2026-10-28-payment-terms-design.md PT9): what the
 * agent does with the same terms, and the landing's own way in, with shadow mode ticked. The link is the one line the
 * free tools' shared call to action replaces once it credits a workspace to the tool it started from.
 */
export function PaymentTermsCta() {
  return (
    <section aria-labelledby="payment-terms-cta" className="mt-10 rounded-2xl border border-line bg-surface px-5 py-6 sm:px-6">
      <h2 id="payment-terms-cta" className="text-lg font-semibold tracking-[-0.01em] text-ink">
        Your AI agent for bills and payments
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-ink-2">Vestiarion reads the terms on every bill and pays on the right day, within limits you set.</p>
      <div className="mt-5">
        <Button asChild>
          <Link href={TRY_HREF} data-cta="payment-terms-start">
            {TRY_LABEL}
          </Link>
        </Button>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-ink-3">In shadow mode it decides on your real bills while you keep paying them as you do now.</p>
    </section>
  );
}
