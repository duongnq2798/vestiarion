import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { readCurrencyReport } from "@/lib/currency-report-read";
import { db } from "@/lib/dal";
import { readPlanningRates } from "@/lib/fx/planning-rates";
import type { ReportFacts } from "@/lib/workspace-report";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * A page that shows rates or variances never waits on the rate feed and never writes while it renders
 * (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M5, M6): the report, Bills & receivables and
 * Treasury read what the hourly rates job stored, each rate with its time and age, or say unknown. Only the job reads
 * the feed and records rates and variances.
 */

const { feedRead } = vi.hoisted(() => ({ feedRead: vi.fn() }));
vi.mock("@/lib/fx/usd-rates", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/fx/usd-rates")>()), usdRate: feedRead }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f16";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ROOT = process.cwd();

const BILL = { id: "bill-1", amount: 1000, paid_amount: null, currency: "USDC", original_currency: "SGD", original_amount: 1350, fx_rate: 1.35, fx_source: "ExchangeRate-API", fx_at: "2026-10-10T00:02:00+00:00" };
const INTENT = { source_id: "bill-1", amount: 1000, token: "USDC", confirmed_at: "2026-10-12T15:00:00+00:00", executed_at: null, updated_at: "2026-10-12T15:00:05+00:00" };
// Stored by the job: the rate in force at the payment, and the newest, published 2 days before the page is read.
const RATES = [
  { id: "rate-2", base: "USD", quote: "SGD", rate: 1.37, kind: "reference", source: "ExchangeRate-API", published_at: "2026-10-13T00:02:00+00:00" },
  { id: "rate-1", base: "USD", quote: "SGD", rate: 1.36, kind: "reference", source: "ExchangeRate-API", published_at: "2026-10-12T00:02:00+00:00" },
];

function database() {
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.method !== "GET" && request.method !== "HEAD") return { status: 201, body: [] };
    if (request.path === "/rest/v1/reporting_currencies") return { body: [{ currency: "USD", set_by: null, set_at: "2026-10-01T00:00:00Z" }] };
    if (request.path === "/rest/v1/invoices") return { body: [BILL] };
    if (request.path === "/rest/v1/payment_intents") return { body: [INTENT] };
    if (request.path === "/rest/v1/fx_rates") return { body: RATES, headers: { "content-range": "0-0/0" } };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  return { fake, run };
}

const FACTS: ReportFacts = {
  network: "arc-testnet",
  sandbox: false,
  now: "2026-10-15T00:30:00.000Z",
  openedAt: "2026-10-01T00:00:00.000Z",
  shadow: { currency: "SGD", startedAt: "2026-10-01T00:00:00.000Z" },
  bills: [
    {
      id: "bill-1",
      createdAt: "2026-10-10T10:00:00.000Z",
      dueDate: "2026-10-20T00:00:00.000Z",
      amount: 1000,
      currency: "USDC",
      status: "paid",
      reviewedBy: null,
      paidAmount: null,
      discount: null,
      bill: { amount: 1350, currency: "SGD" },
      conversion: { perUsd: 1.35, source: "ExchangeRate-API", at: "2026-10-10T00:02:00.000Z" },
      payee: { id: "payee-1", name: "Lion City Prints", mirror: false, sample: false },
    },
  ],
  decisions: [],
  personActions: [],
  verdicts: [],
  payments: [{ invoiceId: "bill-1", amount: 1000, token: "USDC", txHash: `0x${"b".repeat(64)}`, at: "2026-10-12T15:00:00.000Z", simulated: false }],
};

beforeEach(() => feedRead.mockReset());

describe("the report's Currencies and rates", () => {
  it("reads only what the job stored: no read of the feed, no write, and an unrecorded variance said as unknown", async () => {
    const { fake, run } = database();
    const report = await run(() => readCurrencyReport(db(), FACTS, null, new Date(FACTS.now)));
    expect(feedRead).not.toHaveBeenCalled();
    expect(fake.requests.filter((request) => request.method !== "GET" && request.method !== "HEAD")).toEqual([]);
    // The stored rate, as stored, a day and a half old.
    expect(report.rates.find((rate) => rate.kind === "reference" && rate.at === "2026-10-13T00:02:00.000Z")?.value).toBe("1.37");
    expect(report.variance.rows).toEqual([]);
    expect(report.variance.unknown.map((row) => row.reason)).toEqual(["Not recorded yet: the hourly rates job records it from the SGD rate in force at the payment."]);
  });
});

describe("Treasury's exchange rates", () => {
  it("offers the newest stored rate with its age, never reading the feed or writing", async () => {
    const { fake, run } = database();
    const planning = await run(() => readPlanningRates(db(), ["SGD"], new Date(FACTS.now)));
    expect(feedRead).not.toHaveBeenCalled();
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
    expect(planning.rateHints.SGD).toEqual({ currency: "SGD", perUsd: "1.37", source: "ExchangeRate-API", at: "2026-10-13T00:02:00.000Z", age: "2 days old" });
    expect(planning.reporting).toMatchObject({ currency: "USD", asOf: FACTS.now });
  });
});

describe("the pages that show rates and variances", () => {
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
  const RENDER_PATH = [
    "src/app/o/[slug]/report/page.tsx",
    "src/app/o/[slug]/invoices/page.tsx",
    "src/app/o/[slug]/console/page.tsx",
    "src/lib/currency-report-read.ts",
    "src/lib/fx/planning-rates.ts",
  ];

  it.each(RENDER_PATH)("%s never reads the feed or records a rate or a variance", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/\b(?:recordFxVariances|recordReferenceRates|recordRatesForWorkspaces|usdRate)\b/);
    expect(source).not.toMatch(/fx\/usd-rates|fx\/rates-job/);
  });

  it("leaves the recording to the hourly job, which Supabase Cron calls", () => {
    expect(read("src/lib/fx/rates-job.ts")).toMatch(/recordReferenceRates\(orgDb, currencies, \{ rate \}\)[\s\S]*recordFxVariances\(orgDb\)/);
    expect(read("src/app/api/platform/fx-rates/route.ts")).toContain("recordRatesForWorkspaces()");
    expect(read("supabase/cron/watches.sql")).toContain("select cron.schedule('vestiarion-fx-rates', '41 * * * *'");
  });
});
