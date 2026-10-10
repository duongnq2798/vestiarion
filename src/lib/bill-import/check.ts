import { createHash } from "node:crypto";
import { db, unwrap } from "../dal";
import { FxRateError, usdRate, type UsdRate } from "../fx/usd-rates";
import { shadowBill, ShadowBillError } from "../shadow-bills";
import { readShadowMode } from "../shadow-mode";
import { workspaceNetwork } from "../workspace-network";
import {
  conversionKey,
  conversionsNeeded,
  fatesOf,
  importSettingsSchema,
  questionsFor,
  readRows,
  unanswered,
  type Conversion,
  type ExistingInvoice,
  type ImportFacts,
  type ImportWorkspace,
  type ReadRow,
  type RowFate,
} from "./rows";
import { readTable, TableError } from "./table";

/**
 * A bill list checked in the workspace's scope (import design B11): read again from its text and the person's answers,
 * never from what the browser read, with the facts only the server holds: the counterparties, the invoices a row could
 * repeat, shadow mode and the day's rates. Writes nothing.
 */

/** The largest list read, in characters of text (B14). */
export const MAX_LIST_CHARS = 1_000_000;

export type CheckedList = { ok: true; fates: RowFate[]; file: string } | { ok: false; message: string };

/** The workspace's shadow mode and network, as the import reads them. */
export async function importWorkspace(): Promise<ImportWorkspace> {
  const shadow = await readShadowMode(db());
  return {
    shadowOn: shadow !== null,
    shadowCurrency: shadow && shadow.currency !== "USDC" ? shadow.currency : null,
    network: workspaceNetwork().id,
  };
}

interface InvoiceRow {
  id: string;
  counterparty_id: string;
  due_date: string;
  amount: number | string;
  currency: string;
  original_amount: number | string | null;
  original_currency: string | null;
  po_reference: string | null;
  memo: string | null;
}

/** The invoices a row could repeat: due within the list's days. Every status counts (B10). */
async function possibleDuplicates(rows: readonly ReadRow[]): Promise<ExistingInvoice[]> {
  const days = rows.flatMap((row) => (row.dueDate ? [row.dueDate] : [])).sort();
  if (days.length === 0) return [];
  const found = unwrap(
    await db()
      .from("invoices")
      .select("id, counterparty_id, due_date, amount, currency, original_amount, original_currency, po_reference, memo")
      .gte("due_date", `${days[0]}T00:00:00.000Z`)
      .lte("due_date", `${days.at(-1)}T23:59:59.999Z`)
  ) as InvoiceRow[];
  return found.map((invoice) => ({
    id: invoice.id,
    counterpartyId: invoice.counterparty_id,
    dueDate: new Date(invoice.due_date).toISOString().slice(0, 10),
    amount: String(invoice.amount),
    currency: invoice.currency,
    originalAmount: invoice.original_amount === null ? null : String(invoice.original_amount),
    originalCurrency: invoice.original_currency,
    poReference: invoice.po_reference,
    memo: invoice.memo,
  }));
}

/** Each bill in the business's own currency at its USDC amount, through the shadow path, with each day's rate read once (B15). */
async function conversions(rows: readonly ReadRow[], workspace: ImportWorkspace): Promise<Map<string, Conversion>> {
  const rates = new Map<string, Promise<UsdRate>>();
  const rate = (currency: string) => {
    if (!rates.has(currency)) rates.set(currency, usdRate(currency));
    return rates.get(currency) as Promise<UsdRate>;
  };
  const converted = new Map<string, Conversion>();
  for (const { currency, amount } of conversionsNeeded(rows)) {
    try {
      const bill = await shadowBill({ currency, amount }, { rate, shadowOn: workspace.shadowOn });
      converted.set(conversionKey(currency, amount), { ok: true, usdc: bill.usdc, original: bill.original });
    } catch (error) {
      if (!(error instanceof ShadowBillError || error instanceof FxRateError)) throw error;
      converted.set(conversionKey(currency, amount), { ok: false, reason: error.message });
    }
  }
  return converted;
}

export async function checkBillList(text: string, answers: unknown): Promise<CheckedList> {
  if (text.length > MAX_LIST_CHARS) return { ok: false, message: "The list must be smaller than 1 MB." };
  const settings = importSettingsSchema.safeParse(answers);
  if (!settings.success) return { ok: false, message: "The answers could not be read. Choose the columns again." };
  let table;
  try {
    table = readTable(text);
  } catch (error) {
    if (error instanceof TableError) return { ok: false, message: error.message };
    throw error;
  }
  const workspace = await importWorkspace();
  const missing = unanswered(questionsFor(table, settings.data, workspace), settings.data);
  if (missing) return { ok: false, message: missing };

  const rows = readRows(table, settings.data, workspace);
  const counterparties = unwrap(await db().from("counterparties").select("id, name")) as ImportFacts["counterparties"];
  const facts: ImportFacts = {
    counterparties,
    existing: await possibleDuplicates(rows),
    conversions: await conversions(rows, workspace),
  };
  return { ok: true, fates: fatesOf(rows, facts), file: createHash("sha256").update(text, "utf8").digest("hex") };
}
