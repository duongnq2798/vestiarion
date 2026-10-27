import { ToolCta } from "@/components/public/ToolCta";

/**
 * The payment terms pages' call to action (docs/superpowers/specs/2026-10-28-payment-terms-design.md PT9): what the
 * agent does with the same terms, and the free tools' shared **Try it on your bills**, `ToolCta` for `payment-terms`
 * (`data-cta="payment-terms-start"`). It goes to the landing's start with shadow mode ticked and credits a workspace
 * opened next to this tool (docs/superpowers/specs/2026-10-28-free-tool-attribution-design.md TA3); the cookie it
 * writes lives in `ToolCta`, apart from the calculator, whose code touches none.
 */
export function PaymentTermsCta() {
  return (
    <section aria-labelledby="payment-terms-cta" className="mt-10 rounded-2xl border border-line bg-surface px-5 py-6 sm:px-6">
      <h2 id="payment-terms-cta" className="text-lg font-semibold tracking-[-0.01em] text-ink">
        Your AI agent for bills and payments
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-ink-2">
        Vestiarion&apos;s agent checks every bill before it is paid, weighs an early-payment discount against holding the cash to the due date, and
        pays in USDC within the limits you set.
      </p>
      <div className="mt-5">
        <ToolCta tool="payment-terms" />
      </div>
      <p className="mt-3 text-sm leading-relaxed text-ink-3">In shadow mode it decides on your real bills while you keep paying them as you do now.</p>
    </section>
  );
}
