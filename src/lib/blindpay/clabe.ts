/**
 * A Mexican CLABE (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B4): 18 digits, a 3-digit bank code, a
 * 3-digit branch, 11 account digits and a control digit, weighted 3, 7, 1 from the left, mod 10. Checked before anything
 * is sent to BlindPay, so a mistyped digit is refused here. Pure and browser-safe.
 */

const WEIGHTS = [3, 7, 1];

/** The digits of a CLABE as typed (spaces and dashes allowed), or null when it is not 18 digits with a good control digit. */
export function readClabe(typed: string): string | null {
  const digits = typed.replace(/[\s-]/g, "");
  if (!/^\d{18}$/.test(digits)) return null;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += (Number(digits[i]) * WEIGHTS[i % 3]) % 10;
  const control = (10 - (sum % 10)) % 10;
  return control === Number(digits[17]) ? digits : null;
}

/** The banks a CLABE's first three digits name most often, for the card; another code is shown as its number. */
const BANKS: Record<string, string> = {
  "002": "Banamex",
  "012": "BBVA",
  "014": "Santander",
  "021": "HSBC",
  "030": "BanBajío",
  "032": "IXE",
  "036": "Inbursa",
  "044": "Scotiabank",
  "058": "Banregio",
  "072": "Banorte",
  "127": "Banco Azteca",
  "137": "BanCoppel",
  "638": "Nu México",
  "646": "STP",
  "722": "Mercado Pago",
};

export function clabeBank(bankCode: string): string {
  return BANKS[bankCode] ?? `bank ${bankCode}`;
}

/** What is kept of a CLABE: its bank code and last four digits, never the whole number. */
export function clabeShown(digits: string): { bankCode: string; last4: string } {
  return { bankCode: digits.slice(0, 3), last4: digits.slice(-4) };
}
