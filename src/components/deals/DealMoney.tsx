import { cn } from "@/components/ui/cn";
import { formatMinor } from "@/lib/deals/money";

/**
 * A deal's amount in its own currency and minor unit: 1,250.00 USDC, or 1,000,000 JPY. The same look as `Money`, which
 * always writes two decimals.
 */
export function DealMoney({ minor, digits, currency, sign, className }: { minor: number; digits: number; currency: string; sign?: boolean; className?: string }) {
  const text = formatMinor(Math.abs(minor), digits);
  const prefix = minor < 0 ? "−" : sign && minor > 0 ? "+" : "";
  return (
    <span className={cn("whitespace-nowrap tabular-nums", className)}>
      {prefix && <span className="mr-0.5 text-ink-3">{prefix}</span>}
      {text}
      <span className="ml-1 text-[0.72em] font-medium tracking-wide text-ink-3">{currency}</span>
    </span>
  );
}
