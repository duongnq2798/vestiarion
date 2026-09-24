import { z } from "zod";

const USDC_PATTERN = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/;

export const usdcAmountSchema = z.string().trim()
  .regex(USDC_PATTERN, "Use a positive USDC amount with at most 6 decimal places")
  .refine((value) => {
    if (!USDC_PATTERN.test(value)) return false;
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0")) > BigInt(0);
  }, "Amount must be greater than zero");

const optionalText = (max: number) => z.string().trim().max(max).transform((value) => value || null);

export const counterpartyInputSchema = z.object({
  name: z.string().trim().min(2).max(160),
  role: z.enum(["vendor", "client", "contractor"]),
  address: optionalText(200),
  chain: z.string().trim().min(2).max(40),
  jurisdiction: optionalText(80),
  paymentLimit: z.string().trim(),
}).superRefine((value, context) => {
  if (value.role === "client" && value.paymentLimit === "") return;
  const parsed = usdcAmountSchema.safeParse(value.paymentLimit);
  if (!parsed.success) {
    context.addIssue({ code: "custom", path: ["paymentLimit"], message: parsed.error.issues[0]?.message ?? "Invalid payment limit" });
  }
});

const dueDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD due date").refine((value) => {
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}, "Due date is not a real calendar date");

export const invoiceInputSchema = z.object({
  direction: z.enum(["payable", "receivable"]),
  counterpartyId: z.string().uuid(),
  amount: usdcAmountSchema,
  memo: optionalText(280),
  poReference: optionalText(100),
  goodsReceived: z.boolean(),
  dueDate: dueDateSchema,
});

const csvBooleanSchema = z.union([z.boolean(), z.string()]).transform((value, context) => {
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) return true;
  if (["false", "no", "0", ""].includes(normalized)) return false;
  context.addIssue({ code: "custom", message: "goods_received must be true/false, yes/no, or 1/0" });
  return z.NEVER;
});

export const csvInvoiceInputSchema = z.object({
  direction: z.string().trim().toLowerCase().pipe(z.enum(["payable", "receivable"])),
  counterparty: z.string().trim().min(1).max(160),
  amount: usdcAmountSchema,
  memo: optionalText(280),
  po_reference: optionalText(100),
  goods_received: csvBooleanSchema,
  due_date: dueDateSchema,
});

export type CsvInvoiceInput = z.input<typeof csvInvoiceInputSchema>;

export function dueDateIso(value: string): string {
  return new Date(`${value}T12:00:00.000Z`).toISOString();
}

export function firstZodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "Invalid input";
}
