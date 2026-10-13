import { currentOrgId } from "./context";
import { db, type OrgDb } from "./dal";
import { notSetUp } from "./fx/rates-store";
import { assertLedgerCanSign } from "./ledger";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";
import { isReportingCurrency, REPORTING_CURRENCIES, type ReportingCurrency } from "./money";

/**
 * The workspace's reporting currency (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M4): the one its
 * report and plans total in, with the rates shown. One row of `reporting_currencies` (0113). Payments still settle in
 * USDC, or EURC on Arc testnet: nothing that decides or pays reads it. Who may set it (`reporting.manage`, owners and
 * admins) is the command's check. Every export runs inside an organization scope.
 *
 * Before migration 0113 runs, reading answers `available: false` and setting refuses with `not_ready`.
 */

export const REPORTING_CURRENCY_ACTION = "reporting_currency_changed";

export interface ReportingCurrencySetting {
  currency: ReportingCurrency;
  setBy: string | null;
  setAt: string;
}

export type ReportingCurrencyRead = { available: false } | { available: true; setting: ReportingCurrencySetting | null };

export type ReportingCurrencyErrorCode = "not_ready" | "currency" | "unchanged";

export const REPORTING_CURRENCY_MESSAGES: Record<ReportingCurrencyErrorCode, string> = {
  not_ready: "The reporting currency is not set up on this deployment yet.",
  currency: `Choose one of ${REPORTING_CURRENCIES.join(", ")}.`,
  unchanged: "That is the reporting currency already.",
};

export class ReportingCurrencyError extends Error {
  constructor(readonly code: ReportingCurrencyErrorCode) {
    super(REPORTING_CURRENCY_MESSAGES[code]);
    this.name = "ReportingCurrencyError";
  }
}

type Row = { currency: string; set_by: string | null; set_at: string };

export async function readReportingCurrency(orgDb: OrgDb = db()): Promise<ReportingCurrencyRead> {
  const result = await orgDb.from("reporting_currencies").select("currency, set_by, set_at").limit(1);
  if (result.error) {
    if (notSetUp(result.error)) return { available: false };
    throw new Error(`reporting_currencies not read: ${result.error.message}`);
  }
  const row = ((result.data ?? []) as Row[])[0];
  return { available: true, setting: row && isReportingCurrency(row.currency) ? { currency: row.currency, setBy: row.set_by, setAt: row.set_at } : null };
}

/** The reporting currency, or null when none is set or it cannot be set yet: for pages that only show it. */
export async function reportingCurrencyOrNull(orgDb: OrgDb = db()): Promise<ReportingCurrency | null> {
  const read = await readReportingCurrency(orgDb);
  return read.available ? (read.setting?.currency ?? null) : null;
}

export async function setReportingCurrency(input: { actorId: string; currency: string }): Promise<ReportingCurrencySetting> {
  const currency = input.currency.trim().toUpperCase();
  if (!isReportingCurrency(currency)) throw new ReportingCurrencyError("currency");
  const before = await readReportingCurrency();
  if (!before.available) throw new ReportingCurrencyError("not_ready");
  if (before.setting?.currency === currency) throw new ReportingCurrencyError("unchanged");
  // An unreadable signing key refuses the change before it is written, rather than leave it unsigned.
  assertLedgerCanSign();

  const values = { currency, set_by: input.actorId, set_at: new Date().toISOString() };
  // The first setting adds the row, a later one changes it; one set by someone else meanwhile is changed (23505).
  const insert = () => db().from("reporting_currencies").insert(values).select("currency, set_by, set_at").single<Row>();
  const update = () => db().from("reporting_currencies").update(values).select("currency, set_by, set_at").single<Row>();
  let write = before.setting ? await update() : await insert();
  if (write.error?.code === "23505") write = await update();
  if (write.error) {
    if (notSetUp(write.error)) throw new ReportingCurrencyError("not_ready");
    throw new Error(`reporting_currencies not written: ${write.error.message}`);
  }
  const from = before.setting?.currency ?? null;
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "system",
    action: REPORTING_CURRENCY_ACTION,
    summary: from ? `Changed the reporting currency from ${from} to ${currency}` : `Set the reporting currency to ${currency}`,
    detail: { by: input.actorId, from, to: currency },
  });
  return { currency, setBy: write.data.set_by, setAt: write.data.set_at };
}
