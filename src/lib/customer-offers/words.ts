/**
 * What a customer and a workspace read of an early-payment discount (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md
 * C4). Pure and browser-safe.
 */

const money = (value: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Pinecrest Studio offers 1.00% off invoice INV-108: pay 990.00 USDC by Oct 22, 2026 instead of 1,000.00 USDC on Nov 30, 2026." */
export function discountLine(input: { orgName: string; reference: string | null; amount: number; discounted: number; currency: string; pct: number; dueDate: string; payBy: string }): string {
  const invoice = input.reference ? `invoice ${input.reference}` : "your invoice";
  return `${input.orgName} offers ${input.pct.toFixed(2)}% off ${invoice}: pay ${money(input.discounted)} ${input.currency} by ${day(input.payBy)} instead of ${money(input.amount)} ${input.currency} on ${day(input.dueDate)}.`;
}

const STATUS: Record<string, string> = {
  open: "was offered",
  accepted: "accepted",
  declined: "declined",
  withdrawn: "was offered, then withdrawn,",
  paid: "paid at",
};

/** One line of the recent offers on Bills & receivables: "Acme accepted 1.00% off 500.00 USDC, to pay by Oct 22, 2026." */
export function recentDiscountLine(row: { customerName: string; status: string; pct: number; amount: number; discounted: number; payBy: string }): string {
  if (row.status === "paid") return `${row.customerName} paid ${money(row.discounted)} USDC at ${row.pct.toFixed(2)}% off ${money(row.amount)}, by ${day(row.payBy)}.`;
  return `${row.customerName} ${STATUS[row.status] ?? row.status} ${row.pct.toFixed(2)}% off ${money(row.amount)} USDC, to pay by ${day(row.payBy)}.`;
}
