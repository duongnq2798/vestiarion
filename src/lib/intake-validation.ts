import { z } from "zod";
import { PAYEE_CHAIN_IDS } from "./payee-chains";

const USDC_PATTERN = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/;

/** A positive amount with at most 6 decimals, kept as the string entered: both USDC and EURC have 6 decimals. */
const positiveAmountSchema = (message: string) =>
  z.string().trim()
    .regex(USDC_PATTERN, message)
    .refine((value) => {
      if (!USDC_PATTERN.test(value)) return false;
      const [whole, fraction = ""] = value.split(".");
      return BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0")) > BigInt(0);
    }, "Amount must be greater than zero");

/** A payment limit, which is always in USDC. */
export const usdcAmountSchema = positiveAmountSchema("Use a positive USDC amount with at most 6 decimal places");

/** An https link with a host: the only kind of evidence link a milestone takes. */
export function isHttpsLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** An invoice's amount, in the invoice's own currency. */
const invoiceAmountSchema = positiveAmountSchema("Use a positive amount with at most 6 decimal places");

/** The currencies an invoice can be in (EURC invoices design E1; `invoices_currency_check`, 0040). */
export const INVOICE_CURRENCIES = ["USDC", "EURC"] as const;
export type InvoiceCurrency = (typeof INVOICE_CURRENCIES)[number];

/** USDC when left out or blank; read without regard to case, so a CSV's "eurc" is EURC. */
export const invoiceCurrencySchema = z
  .string()
  .optional()
  .transform((value) => (value ?? "").trim().toUpperCase() || "USDC")
  .pipe(z.enum(INVOICE_CURRENCIES, { message: "Choose USDC or EURC as the currency." }));

const optionalText = (max: number) => z.string().trim().max(max).transform((value) => value || null);

/**
 * Like `optionalText`, but also accepts the key being absent entirely — for
 * CSV rows that were not built by `parseInvoiceCsv` (which always fills in
 * every optional column as `""`), such as a row object a caller constructs
 * by hand in the old, pre-discount column shape. Absent means the same as
 * blank: no discount.
 */
const optionalCsvText = (max: number) => z.string().trim().max(max).nullish().transform((value) => value || null);

/** A payee's chain (CCTP payouts X1): read without regard to case. */
const payeeChainSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .pipe(z.enum(PAYEE_CHAIN_IDS, { message: "Choose a chain Vestiarion can pay on: Arc testnet, Base Sepolia, Arbitrum Sepolia or Ethereum Sepolia." }));

export const counterpartyInputSchema = z.object({
  name: z.string().trim().min(2).max(160),
  role: z.enum(["vendor", "client", "contractor"]),
  address: optionalText(200),
  chain: payeeChainSchema,
  jurisdiction: optionalText(80),
  paymentLimit: z.string().trim(),
}).superRefine((value, context) => {
  // A contractor's milestones are released on Arc testnet: only a vendor is
  // paid on another chain, through CCTP (CCTP payouts, review C1).
  if (value.chain !== "ARC-TESTNET" && value.role !== "vendor") {
    context.addIssue({ code: "custom", path: ["chain"], message: "Only a vendor can be paid on another chain; a contractor's milestones are released on Arc testnet." });
  }
  if (value.role === "client" && value.paymentLimit === "") return;
  const parsed = usdcAmountSchema.safeParse(value.paymentLimit);
  if (!parsed.success) {
    context.addIssue({ code: "custom", path: ["paymentLimit"], message: parsed.error.issues[0]?.message ?? "Invalid payment limit" });
  }
});

/** A real `YYYY-MM-DD` calendar date — rejects both malformed strings and rolled-over ones like Feb 30. */
function isRealCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

const dueDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD due date").refine(isRealCalendarDate, "Due date is not a real calendar date");

// 0 < pct < 100, at most 2 decimal places, no leading zeros (mirrors usdcAmountSchema's strictness).
const DISCOUNT_PCT_PATTERN = /^(?:0|[1-9]\d?)(?:\.\d{1,2})?$/;

function isValidDiscountPct(value: string): boolean {
  return DISCOUNT_PCT_PATTERN.test(value) && Number(value) > 0;
}

/**
 * The early-payment discount pair, on an invoice form or a CSV row: both
 * fields or neither, a percent strictly between 0 and 100, a real deadline,
 * and a deadline no later than the due date (migration 0038's own checks).
 *
 * A missing half is named on the field that is missing, so a percent entered
 * without its deadline is refused at the deadline rather than added without
 * its discount: on 2026-10-02 a payable entered with 2% and no deadline was
 * added with no discount at all, and the agent scheduled the full amount.
 */
function checkDiscountPair(
  context: z.RefinementCtx,
  pctPath: string,
  deadlinePath: string,
  pct: string | null,
  deadline: string | null,
  dueDate: string
): void {
  if (pct !== null && !isValidDiscountPct(pct)) {
    context.addIssue({
      code: "custom",
      path: [pctPath],
      message: "Enter a discount percent greater than 0 and less than 100, with at most 2 decimal places.",
    });
  }
  if (pct === null && deadline !== null) {
    context.addIssue({ code: "custom", path: [pctPath], message: "Enter the discount percent, or clear the discount deadline." });
  }
  if (pct !== null && deadline === null) {
    context.addIssue({
      code: "custom",
      path: [deadlinePath],
      message: "Enter the last day the discount applies, on or before the due date, or clear the discount.",
    });
  }
  if (pct === null || deadline === null || !isValidDiscountPct(pct)) return;
  if (!isRealCalendarDate(deadline)) {
    context.addIssue({ code: "custom", path: [deadlinePath], message: "Discount deadline is not a real calendar date" });
    return;
  }
  if (isRealCalendarDate(dueDate) && deadline > dueDate) {
    context.addIssue({ code: "custom", path: [deadlinePath], message: "The discount deadline must be on or before the due date." });
  }
}

export const invoiceInputSchema = z
  .object({
    direction: z.enum(["payable", "receivable"]),
    counterpartyId: z.string().uuid(),
    amount: invoiceAmountSchema,
    currency: invoiceCurrencySchema,
    memo: optionalText(280),
    poReference: optionalText(100),
    goodsReceived: z.boolean(),
    dueDate: dueDateSchema,
    earlyPayDiscountPct: optionalText(10),
    discountDeadline: optionalText(10),
  })
  .superRefine((value, context) => {
    checkDiscountPair(context, "earlyPayDiscountPct", "discountDeadline", value.earlyPayDiscountPct, value.discountDeadline, value.dueDate);
  });

const csvBooleanSchema = z.union([z.boolean(), z.string()]).transform((value, context) => {
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) return true;
  if (["false", "no", "0", ""].includes(normalized)) return false;
  context.addIssue({ code: "custom", message: "goods_received must be true/false, yes/no, or 1/0" });
  return z.NEVER;
});

export const csvInvoiceInputSchema = z
  .object({
    direction: z.string().trim().toLowerCase().pipe(z.enum(["payable", "receivable"])),
    counterparty: z.string().trim().min(1).max(160),
    amount: invoiceAmountSchema,
    currency: invoiceCurrencySchema,
    memo: optionalText(280),
    po_reference: optionalText(100),
    goods_received: csvBooleanSchema,
    due_date: dueDateSchema,
    early_pay_discount_pct: optionalCsvText(10),
    discount_deadline: optionalCsvText(10),
  })
  .superRefine((value, context) => {
    checkDiscountPair(context, "early_pay_discount_pct", "discount_deadline", value.early_pay_discount_pct, value.discount_deadline, value.due_date);
  });

export type CsvInvoiceInput = z.input<typeof csvInvoiceInputSchema>;

export function dueDateIso(value: string): string {
  return new Date(`${value}T12:00:00.000Z`).toISOString();
}

export function firstZodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "Invalid input";
}

/** The invoice form's fields as its labels name them (src/components/intake/InvoiceIntake.tsx), so a refusal names the field the person sees. */
export const INVOICE_FIELD_LABELS = {
  direction: "Direction",
  counterpartyId: "Counterparty",
  amount: "Amount",
  currency: "Currency",
  dueDate: "Due date",
  earlyPayDiscountPct: "Early-payment discount (%)",
  discountDeadline: "Discount deadline",
  memo: "Memo",
  poReference: "PO reference",
} as const;

export type InvoiceField = keyof typeof INVOICE_FIELD_LABELS;

/**
 * A refused invoice form: each field's first error, to show under that field,
 * and a message for the whole form that names the first one by its label.
 */
export function invoiceFormRefusal(error: z.ZodError): { message: string; fieldErrors: Partial<Record<InvoiceField, string>> } {
  const fieldErrors: Partial<Record<InvoiceField, string>> = {};
  let message: string | null = null;
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field !== "string" || !(field in INVOICE_FIELD_LABELS)) continue;
    const key = field as InvoiceField;
    fieldErrors[key] ??= issue.message;
    message ??= `${INVOICE_FIELD_LABELS[key]}: ${issue.message}`;
  }
  return { message: message ?? firstZodMessage(error), fieldErrors };
}

/** A refused CSV import, naming the row as the preview counts them, from 1, and the column. */
export function csvBatchMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const [row, ...column] = issue?.path ?? [];
  if (typeof row !== "number") return firstZodMessage(error);
  return `Row ${row + 1}: ${column.length > 0 ? `${column.join(".")}: ` : ""}${issue.message}`;
}
