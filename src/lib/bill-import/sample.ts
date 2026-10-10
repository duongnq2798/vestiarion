import { billAmount, usdcFor } from "@/lib/bill-amount";
import {
  conversionKey,
  conversionsNeeded,
  countFates,
  fatesOf,
  importSettingsSchema,
  questionsFor,
  readRows,
  unanswered,
  type Conversion,
  type ExistingInvoice,
  type ImportedFate,
  type ImportWorkspace,
  type RowFate,
} from "@/lib/bill-import/rows";
import { readTable, TableError } from "@/lib/bill-import/table";

/**
 * A stand-in for the server's check and import of a bill list, for the design page and the guide's screenshots: the
 * same reading and fates, against a sample workspace in shadow mode in yen, at 150 yen to the dollar. Nothing leaves
 * the browser. The sample keeps what it "added", so a second import of the same list adds nothing, as on the server.
 */

export const SAMPLE_WORKSPACE: ImportWorkspace = { shadowOn: true, shadowCurrency: "JPY", network: "arc-testnet" };

export const SAMPLE_COUNTERPARTIES = [
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1", name: "Kanto Paper Co., Ltd." },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c2", name: "Lion City Logistics Pte Ltd" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c3", name: "Manila Print House" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c4", name: "Seoul Office Supply" },
];

/** A list as a business keeps it: its own columns, day-first dates, yen and USDC, and three rows that cannot be added. */
export const SAMPLE_LIST = [
  "Supplier\tInvoice No.\tDescription\tDue\tTotal\tCurrency",
  "Kanto Paper\tKP-1042\tCopy paper\t15/10/2026\t¥120,000\tJPY",
  "Lion City Logistics Pte Ltd\tLC-77\tFreight, October\t20/10/2026\t1,250.00\tUSDC",
  "Manila Print House\tMP-310\tBrochures\t03/11/2026\t¥48,500\tJPY",
  "Seoul Office Supply\tSO-5\tToner\t31/02/2026\t¥9,800\tJPY",
  "Kanto Paper\tKP-1043\tEnvelopes\t28/10/2026\t¥1,500.5\tJPY",
  "Harbor Movers\tHM-9\tMoving\t30/10/2026\t2,000.00\tUSDC",
].join("\n");

const RATE = { perUsd: 150, source: "ExchangeRate-API", at: "2026-10-10T00:02:31.000Z" };

function sampleConversions(rows: ReturnType<typeof readRows>): Map<string, Conversion> {
  return new Map(
    conversionsNeeded(rows).map(({ currency, amount }) => {
      const usdc = usdcFor(billAmount(amount, currency) ?? 0, RATE.perUsd);
      const conversion: Conversion = usdc === null
        ? { ok: false, reason: "That bill comes to less than 0.01 USDC at the day's rate." }
        : { ok: true, usdc, original: { currency, amount: Number(amount), perUsd: RATE.perUsd, source: RATE.source, at: RATE.at } };
      return [conversionKey(currency, amount), conversion];
    })
  );
}

/** The sample's fates for a list, as the server's check gives them, or what the server would refuse it with. */
export function sampleFates(text: string, answers: unknown, existing: readonly ExistingInvoice[]): { ok: true; fates: RowFate[] } | { ok: false; message: string } {
  const settings = importSettingsSchema.safeParse(answers);
  if (!settings.success) return { ok: false, message: "The answers could not be read. Choose the columns again." };
  let table;
  try {
    table = readTable(text);
  } catch (error) {
    return { ok: false, message: error instanceof TableError ? error.message : "The list could not be read." };
  }
  const missing = unanswered(questionsFor(table, settings.data, SAMPLE_WORKSPACE), settings.data);
  if (missing) return { ok: false, message: missing };
  const rows = readRows(table, settings.data, SAMPLE_WORKSPACE);
  return { ok: true, fates: fatesOf(rows, { counterparties: SAMPLE_COUNTERPARTIES, existing, conversions: sampleConversions(rows) }) };
}

/** What the sample adds: each row to add becomes an invoice it keeps, and the import's fates say which. */
export function sampleImport(fates: readonly RowFate[], existing: ExistingInvoice[]): ImportedFate[] {
  return fates.map((fate) => {
    if (fate.status !== "add") return fate;
    const id = `0b6c1c9e-4a4f-4a7e-9b1e-${String(existing.length + 1).padStart(12, "0")}`;
    existing.push({
      id,
      counterpartyId: fate.counterpartyId,
      dueDate: fate.invoice.dueDate,
      amount: fate.invoice.amount,
      currency: fate.invoice.currency,
      originalAmount: fate.original ? String(fate.original.amount) : null,
      originalCurrency: fate.original?.currency ?? null,
      poReference: fate.invoice.poReference,
      memo: fate.invoice.memo,
    });
    const { line, counterparty, amount, currency, dueDate, reference, usdc } = fate;
    return { line, counterparty, amount, currency, dueDate, reference, usdc, status: "added", invoiceId: id };
  });
}

export { countFates };
