import { Callout } from "@/components/ui/Callout";
import { PAYMENTS_OFF } from "@/lib/payments-switch";

/**
 * What every workspace page says while the platform has payments switched off (payment safety S5,
 * docs/superpowers/specs/2026-10-05-payment-safety-design.md), so no one mistakes it for a stuck agent. Drawn by the
 * workspace layout from the deployment's own switch, so it reads no tenant rows.
 */
export function PaymentsOffBanner() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-5 sm:px-6 sm:pt-7 lg:px-8 lg:pt-8">
      <Callout tone="held" title="Payments switched off">
        {PAYMENTS_OFF} The agent does not run, and nothing is paid, moved or locked until they are back on. Every page still reads as usual.
      </Callout>
    </div>
  );
}
