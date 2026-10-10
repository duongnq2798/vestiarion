import { Callout } from "@/components/ui/Callout";
import { PAYMENTS_OFF } from "@/lib/payments-switch";

/**
 * What every workspace page says while the platform has payments switched off (payment safety S5,
 * docs/superpowers/specs/2026-10-05-payment-safety-design.md), so no one mistakes it for a stuck agent. Drawn by the
 * workspace layout from the platform's switch (S7), so it reads no tenant rows; it gives the reason the switch records.
 * Drawn under the page's header (workspace shell design S4).
 */
export function PaymentsOffBanner({ reason = null }: { reason?: string | null }) {
  return (
    <Callout tone="held" title="Payments switched off">
      {PAYMENTS_OFF} The agent does not run, and nothing is paid, moved or locked until they are back on. Every page still reads as usual.
      {reason && <span className="mt-1 block">Why: {reason}</span>}
    </Callout>
  );
}
