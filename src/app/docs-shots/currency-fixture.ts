import type { SavedScenarioView } from "@/components/vx/ScenarioVersions";
import type { RateHint } from "@/components/vx/ScenarioRates";
import type { ActualRecord } from "@/lib/actual-payment-fields";
import { buildCurrencyReport } from "@/lib/currency-report";
import type { RecordedVariance, UnknownVariance } from "@/lib/fx/variances";
import type { LedgerEntry } from "@/lib/ledger";
import { fxVariance, money, rateBook, referenceRate, type FxRate } from "@/lib/money";
import type { CounterpartyRow, InvoiceRow } from "@/lib/queries";
import type { ReportBill, ReportFacts } from "@/lib/workspace-report";

/**
 * Currencies with sample data, for the partner's review of docs/superpowers/specs/2026-10-13-currency-provenance-design.md
 * (`docs/superpowers/specs/currency-provenance-shots/`): a Singapore business in shadow mode on Tuesday, Oct 13, 2026,
 * reporting in SGD, with bills written in SGD, JPY, KRW, PHP and MYR and one in USDC; the day's reference rates, none
 * for the won; one bill paid at a rate that moved since it was converted; and a saved cash scenario with the Singapore
 * dollar typed weaker. Made up: no workspace has these bills. Every figure is worked out by the pages' own functions.
 */

export const CURRENCY_TODAY = "2026-10-13";
const NOW = "2026-10-13T09:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = "ExchangeRate-API";
const ref = (currency: string, perUsd: string, at: string) => referenceRate(currency, perUsd, source, at) as FxRate;

/** The day's reference rates the report and Treasury read: no KRW rate was recorded this week. */
export const TODAY_RATES: FxRate[] = [
  ref("SGD", "1.3512", "2026-10-13T00:02:31.000Z"),
  ref("JPY", "149.235", "2026-10-13T00:02:31.000Z"),
  ref("PHP", "56.812", "2026-10-13T00:02:31.000Z"),
  ref("MYR", "4.4725", "2026-10-13T00:02:31.000Z"),
];
export const BOOK = rateBook(TODAY_RATES, { KRW: "The last KRW rate recorded was published 2 Oct 2026, 00:02 UTC, too old to report with." });

type Written = { currency: string; amount: number; perUsd: number; at: string };
const bill = (n: number, payee: string, usdc: number, written: Written | null, over: Partial<ReportBill> = {}): ReportBill => ({
  id: uuid(9600 + n),
  createdAt: `${written?.at.slice(0, 10) ?? "2026-10-09"}T08:00:00.000Z`,
  dueDate: "2026-10-20T00:00:00.000Z",
  amount: usdc,
  currency: "USDC",
  status: "pending",
  reviewedBy: null,
  paidAmount: null,
  discount: null,
  bill: written ? { amount: written.amount, currency: written.currency } : null,
  conversion: written ? { perUsd: written.perUsd, source, at: written.at } : null,
  payee: { id: uuid(9700 + n), name: payee, mirror: false, sample: false },
  ...over,
});

const HARBOR: Written = { currency: "SGD", amount: 1350, perUsd: 1.35, at: "2026-10-09T00:02:12.000Z" };
export const REPORT_BILLS: ReportBill[] = [
  bill(1, "Harbor Freight Pte", 1000, HARBOR, { status: "paid" }),
  bill(2, "Marina Cleaning", 503.76, { currency: "SGD", amount: 680, perUsd: 1.3498, at: "2026-10-11T00:02:40.000Z" }),
  bill(3, "Tokyo Print Co", 1005.15, { currency: "JPY", amount: 150_000, perUsd: 149.23, at: "2026-10-12T00:02:18.000Z" }),
  bill(4, "Seoul Sound Studio", 1086.88, { currency: "KRW", amount: 1_500_000, perUsd: 1380.1, at: "2026-10-02T00:02:05.000Z" }),
  bill(5, "Manila Dev Team", 880.1, { currency: "PHP", amount: 50_000, perUsd: 56.81, at: "2026-10-12T00:02:18.000Z" }, { status: "paid" }),
  bill(6, "KL Office Supplies", 268.39, { currency: "MYR", amount: 1200, perUsd: 4.471, at: "2026-10-12T00:02:18.000Z" }),
  bill(7, "Northwind Hosting", 120, null, { status: "paid" }),
];

export const REPORT_FACTS: ReportFacts = {
  network: "arc-testnet",
  sandbox: false,
  now: NOW,
  openedAt: "2026-10-01T00:00:00.000Z",
  shadow: { currency: "SGD", startedAt: "2026-10-01T00:00:00.000Z" },
  bills: REPORT_BILLS,
  decisions: [],
  personActions: [],
  verdicts: [],
  payments: [
    { invoiceId: REPORT_BILLS[0].id, amount: 1000, token: "USDC", txHash: `0x${"c".repeat(64)}`, at: "2026-10-12T15:04:00.000Z", simulated: false },
    { invoiceId: REPORT_BILLS[4].id, amount: 880.1, token: "USDC", txHash: `0x${"d".repeat(64)}`, at: "2026-10-13T08:40:00.000Z", simulated: false },
    { invoiceId: REPORT_BILLS[6].id, amount: 120, token: "USDC", txHash: `0x${"e".repeat(64)}`, at: "2026-10-10T10:00:00.000Z", simulated: false },
  ],
};

/** Harbor Freight's SGD 1,350.00 bill, converted at 1.3500 on Oct 9 and paid on Oct 12, when the rate was 1.3600. */
const harborPaymentRate = { ...ref("SGD", "1.36", "2026-10-12T00:02:20.000Z"), id: uuid(9801) };
const harborVariance = fxVariance({ paid: money(1_000_000_000, "USDC"), decision: ref("SGD", "1.35", HARBOR.at), payment: harborPaymentRate });
export const HARBOR_VARIANCE: RecordedVariance = {
  invoiceId: REPORT_BILLS[0].id,
  currency: "SGD",
  paid: money(1_000_000_000, "USDC"),
  paidAt: "2026-10-12T15:04:00.000Z",
  covered: harborVariance?.covered ?? money(135_000, "SGD"),
  decision: ref("SGD", "1.35", HARBOR.at),
  payment: harborPaymentRate,
  valueAtPayment: harborVariance?.valueAtPayment ?? money(0, "USDC"),
  variance: harborVariance?.variance ?? money(0, "USDC"),
  recordedAt: "2026-10-12T15:41:00.000Z",
};
/** Manila's payment came this morning; the PHP rate recorded is from today, published after the payment: not yet known. */
export const MANILA_UNKNOWN: UnknownVariance = {
  invoiceId: REPORT_BILLS[4].id,
  currency: "PHP",
  paidAt: "2026-10-13T08:40:00.000Z",
  reason: "No PHP rate was recorded in the 36 hours before the payment.",
};

const actual = (n: number, invoiceId: string, amount: number, currency: string): ActualRecord => ({
  id: uuid(9900 + n),
  invoiceId,
  outcome: "paid",
  paidOn: "2026-10-12",
  amount,
  currency,
  method: "bank_transfer",
  reference: null,
  note: null,
  reason: null,
  replaces: null,
  source: "form",
  recordedBy: null,
  recordedAt: "2026-10-12T16:00:00.000Z",
});

export const CURRENCY_REPORT = buildCurrencyReport(REPORT_FACTS, {
  reporting: "SGD",
  available: true,
  book: BOOK,
  sources: new Map([
    [REPORT_BILLS[0].id, "xero"],
    [REPORT_BILLS[1].id, "import"],
    [REPORT_BILLS[2].id, "email"],
    [REPORT_BILLS[3].id, "console"],
    [REPORT_BILLS[4].id, "import"],
    [REPORT_BILLS[5].id, "console"],
    [REPORT_BILLS[6].id, "console"],
  ]),
  actuals: [actual(1, REPORT_BILLS[0].id, 1350, "SGD"), actual(2, REPORT_BILLS[4].id, 50_000, "PHP")],
  variances: { available: true, recorded: [HARBOR_VARIANCE], unknown: [MANILA_UNKNOWN] },
  manualAdjustments: 2,
});

// ------------------------------------------------------------------ the paid bill's card

export const HARBOR_PARTY: CounterpartyRow = {
  id: REPORT_BILLS[0].payee.id,
  name: "Harbor Freight Pte",
  role: "vendor",
  address: `0x${"5eed".repeat(10)}`,
  chain: null,
  jurisdiction: "SG",
  risk_level: "clear",
  risk_notes: null,
  payment_limit: 5000,
  baseline_payment_limit: 5000,
  last_screened_at: "2026-10-01T08:00:00Z",
  performance_score: null,
  performance_inputs: null,
  address_changed_at: null,
  address_confirmed_at: null,
  sample: false,
  purchase_order_required: false,
};

export const HARBOR_INVOICE: InvoiceRow = {
  id: REPORT_BILLS[0].id,
  direction: "payable",
  counterparty_id: HARBOR_PARTY.id,
  counterparty_name: HARBOR_PARTY.name,
  amount: 1000,
  memo: "HF-2207 · Sea freight, October",
  po_reference: null,
  goods_received: true,
  due_date: "2026-10-20T00:00:00Z",
  status: "paid",
  agent_reasoning: "The bill matches the shipment received. Harbor Freight Pte is screened clear, and 1,000.00 USDC is within its 5,000.00 USDC limit. I would pay it now.",
  tx_ref: `0x${"c".repeat(64)}`,
  scheduled_for: null,
  early_pay_discount_pct: null,
  discount_due_date: null,
  paid_amount: null,
  currency: "USDC",
  created_by: "docs-sample-admin",
  original_currency: "SGD",
  original_amount: 1350,
  fx_rate: 1.35,
  fx_source: source,
  fx_at: HARBOR.at,
  settled_at: "2026-10-12T15:04:00.000Z",
};

export const HARBOR_ENTRY = {
  seq: 7310,
  id: "entry-7310",
  ts: "2026-10-12T15:03:00Z",
  actor: "agent",
  domain: "ap",
  action: "ap_pay",
  summary: "PAY invoice from Harbor Freight Pte for 1000 USDC",
  detail: {
    invoiceId: HARBOR_INVOICE.id,
    counterpartyId: HARBOR_PARTY.id,
    decisionMode: "llm",
    decision: { action: "pay", reasoning: HARBOR_INVOICE.agent_reasoning },
    guardrailBlocked: false,
    shadow: true,
    currency: "USDC",
    observed: { riskLevel: "clear", paymentLimit: 5000, goodsReceived: true, purchaseOrderRequired: false, operatingBalance: 12_400 },
    execution: { resultingStatus: "paid", chainMode: "live", txRef: HARBOR_INVOICE.tx_ref },
  },
  prevHash: "0".repeat(64),
  hash: "7310".padStart(64, "a"),
  bodyHash: "7310".padStart(64, "b"),
  signature: null,
  signingKeyId: null,
} as unknown as LedgerEntry;

// ------------------------------------------------------------------ a cash scenario with a rate typed

export const SCENARIO_HINTS: Record<string, RateHint> = {
  SGD: { currency: "SGD", perUsd: "1.3512", source, at: "2026-10-13T00:02:31.000Z", age: "8 hours old" },
  JPY: { currency: "JPY", perUsd: "149.235", source, at: "2026-10-13T00:02:31.000Z", age: "8 hours old" },
};

export const SAVED_SCENARIOS: SavedScenarioView[] = [
  {
    id: uuid(9951),
    scenarioId: uuid(9950),
    version: 2,
    name: "SGD weakens",
    levers: { horizon: 60, lateDays: 14, costPct: 0, costScope: "all", choices: {} },
    rates: [{ currency: "SGD", perUsd: "1.4", reference: { perUsd: "1.3512", source, at: "2026-10-13T00:02:31.000Z" } }],
    createdAt: "2026-10-13T08:55:00.000Z",
    createdBy: "olivia@northstar.example",
  },
  {
    id: uuid(9952),
    scenarioId: uuid(9950),
    version: 1,
    name: "SGD weakens",
    levers: { horizon: 60, lateDays: 14, costPct: 0, costScope: "all", choices: {} },
    rates: [{ currency: "SGD", perUsd: "1.38", reference: { perUsd: "1.3498", source, at: "2026-10-11T00:02:40.000Z" } }],
    createdAt: "2026-10-11T10:12:00.000Z",
    createdBy: "olivia@northstar.example",
  },
];
