import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { recordReferenceRates, reportingRateBook } from "@/lib/fx/rates-store";
import { FxRateError, type UsdRate } from "@/lib/fx/usd-rates";
import { recordFxVariances } from "@/lib/fx/variances";
import { formatMoney } from "@/lib/money";
import { setReportingCurrency } from "@/lib/reporting-currency";
import { saveScenarioVersion } from "@/lib/scenario-versions";
import { carriesOrg, fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The reads and writes of currency provenance (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M4-M7,
 * M11), against the requests supabase-js builds: the reporting currency set and signed, reference rates stored once
 * per publication and read back with their age, the FX variance recorded only from a rate recorded for the payment
 * day, scenario versions numbered and never written over, and each part as not set up before migration 0113 runs.
 */

const { appendBestEffort, canSign } = vi.hoisted(() => ({ appendBestEffort: vi.fn(async () => undefined), canSign: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), assertLedgerCanSign: canSign }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: appendBestEffort }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f15";
const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000f1";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const missing = (table: string): FakeReply => ({ status: 404, body: { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` } });

function database(reply: (request: RecordedRequest) => FakeReply) {
  const fake = fakeSupabase(reply);
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: OWNER }), fn);
  return { fake, run };
}
const object = (request: RecordedRequest, row: Record<string, unknown>): FakeReply =>
  request.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ? { status: 201, body: row } : { status: 201, body: [row] };

beforeEach(() => {
  appendBestEffort.mockClear();
  canSign.mockReset();
});

describe("setReportingCurrency", () => {
  it("adds the first setting with who set it, signs it, and keeps every request in the workspace", async () => {
    const { fake, run } = database((request) =>
      request.method === "GET" ? { body: [] } : object(request, { currency: "SGD", set_by: OWNER, set_at: "2026-10-13T09:00:00.000Z" })
    );
    const setting = await run(() => setReportingCurrency({ actorId: OWNER, currency: " sgd " }));
    expect(setting).toEqual({ currency: "SGD", setBy: OWNER, setAt: "2026-10-13T09:00:00.000Z" });
    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /rest/v1/reporting_currencies", "POST /rest/v1/reporting_currencies"]);
    expect(fake.requests[1].body).toMatchObject({ org_id: ORG, currency: "SGD", set_by: OWNER });
    expect(fake.requests.every((request) => carriesOrg(request, ORG))).toBe(true);
    expect(appendBestEffort).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "system",
      action: "reporting_currency_changed",
      summary: "Set the reporting currency to SGD",
      detail: { by: OWNER, from: null, to: "SGD" },
    });
    expect(canSign).toHaveBeenCalled();
  });

  it("changes a setting in place, and says what it was", async () => {
    const { fake, run } = database((request) =>
      request.method === "GET"
        ? { body: [{ currency: "SGD", set_by: OWNER, set_at: "2026-10-01T00:00:00.000Z" }] }
        : object(request, { currency: "JPY", set_by: OWNER, set_at: "2026-10-13T09:00:00.000Z" })
    );
    await run(() => setReportingCurrency({ actorId: OWNER, currency: "JPY" }));
    expect(fake.requests[1].method).toBe("PATCH");
    expect(fake.requests[1].params.get("org_id")).toBe(`eq.${ORG}`);
    expect(appendBestEffort.mock.calls[0]).toMatchObject([ORG, { summary: "Changed the reporting currency from SGD to JPY", detail: { from: "SGD", to: "JPY" } }]);
  });

  it.each([["USDC"], ["EURC"], ["VND"], ["GBP"], [""]])("refuses %s before anything is read", async (currency) => {
    const { fake, run } = database(() => ({ body: [] }));
    await expect(run(() => setReportingCurrency({ actorId: OWNER, currency }))).rejects.toMatchObject({ code: "currency" });
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses the same currency again, and says it is not set up before 0113", async () => {
    const same = database(() => ({ body: [{ currency: "USD", set_by: null, set_at: "2026-10-01T00:00:00.000Z" }] }));
    await expect(same.run(() => setReportingCurrency({ actorId: OWNER, currency: "USD" }))).rejects.toMatchObject({ code: "unchanged" });
    const before = database(() => missing("reporting_currencies"));
    await expect(before.run(() => setReportingCurrency({ actorId: OWNER, currency: "USD" }))).rejects.toMatchObject({ code: "not_ready" });
    expect(appendBestEffort).not.toHaveBeenCalled();
  });
});

const feed = (rates: Record<string, number>, at = "2026-10-13T00:02:31.000Z") =>
  vi.fn(async (currency: string): Promise<UsdRate> => {
    if (!(currency in rates)) throw new FxRateError(`There is no rate for ${currency}. Choose another currency.`);
    return { currency, perUsd: rates[currency], source: "ExchangeRate-API", at };
  });

describe("recordReferenceRates", () => {
  it("stores each rate the feed gave once per publication, and says which it could not read", async () => {
    const { fake, run } = database((request) =>
      request.method === "POST"
        ? { status: 201, body: [] }
        : { body: [{ id: "rate-sgd", base: "USD", quote: "SGD", rate: 1.3512, kind: "reference", source: "ExchangeRate-API", published_at: "2026-10-13T00:02:31+00:00" }] }
    );
    const read = feed({ SGD: 1.3512 });
    const recorded = await run(() => recordReferenceRates(db(), ["sgd", "XXX", "USD", "USDC"], { rate: read }));
    expect(read.mock.calls.map(([currency]) => currency)).toEqual(["SGD", "XXX"]);
    const write = fake.requests.find((request) => request.method === "POST");
    expect(write?.params.get("on_conflict")).toBe("org_id,kind,source,base,quote,published_at");
    expect(write?.headers.get("prefer")).toContain("resolution=ignore-duplicates");
    expect(write?.body).toEqual([
      { org_id: ORG, base: "USD", quote: "SGD", rate: "1.3512", kind: "reference", source: "ExchangeRate-API", published_at: "2026-10-13T00:02:31.000Z" },
    ]);
    expect(recorded.stored).toBe(true);
    expect(recorded.rates).toEqual([
      { id: "rate-sgd", from: "USD", to: "SGD", value: "1.3512", kind: "reference", source: "ExchangeRate-API", at: "2026-10-13T00:02:31.000Z" },
    ]);
    expect(recorded.failed).toEqual({ XXX: "There is no rate for XXX. Choose another currency." });
  });

  it("before 0113 runs, still answers the rates read, stored nowhere", async () => {
    const { run } = database(() => missing("fx_rates"));
    const recorded = await run(() => recordReferenceRates(db(), ["SGD"], { rate: feed({ SGD: 1.35 }) }));
    expect(recorded).toMatchObject({ stored: false, rates: [{ to: "SGD", value: "1.35" }] });
  });
});

describe("reportingRateBook", () => {
  const NOW = new Date("2026-10-13T12:00:00.000Z");
  const stored = (quote: string, rate: number, published: string) => ({ id: `rate-${quote}-${published}`, base: "USD", quote, rate, kind: "reference", source: "ExchangeRate-API", published_at: published });

  it("uses a stored rate under a day old without reading the feed", async () => {
    const { run } = database(() => ({ body: [stored("SGD", 1.35, "2026-10-13T00:02:00+00:00")] }));
    const read = feed({ SGD: 9 });
    const book = await run(() => reportingRateBook(db(), ["SGD"], NOW, { rate: read }));
    expect(read).not.toHaveBeenCalled();
    expect(book.rates.get("SGD")?.value).toBe("1.35");
  });

  it("reads the feed for a rate missing or a day old, and says unknown, with why, where none is usable", async () => {
    const { run } = database((request) => (request.method === "POST" ? { status: 201, body: [] } : { body: [stored("KRW", 1380, "2026-10-05T00:02:00+00:00")] }));
    const book = await run(() => reportingRateBook(db(), ["KRW", "MYR"], NOW, { rate: feed({}) }));
    expect(book.rates.size).toBe(0);
    expect(book.missing.get("KRW")).toBe("The last KRW rate recorded was published 5 Oct 2026, 00:02 UTC, too old to report with.");
    expect(book.missing.get("MYR")).toBe("No MYR rate was recorded: There is no rate for MYR. Choose another currency.");
  });
});

describe("recordFxVariances", () => {
  const BILL = { id: "bill-1", amount: 1000, paid_amount: null, currency: "USDC", original_currency: "SGD", original_amount: 1350, fx_rate: 1.35, fx_source: "ExchangeRate-API", fx_at: "2026-10-10T00:02:00+00:00" };
  const INTENT = { source_id: "bill-1", amount: 1000, token: "USDC", confirmed_at: "2026-10-12T15:00:00+00:00", executed_at: null, updated_at: "2026-10-12T15:00:05+00:00" };
  const RATE = { id: "rate-1", base: "USD", quote: "SGD", rate: 1.36, kind: "reference", source: "ExchangeRate-API", published_at: "2026-10-12T00:02:00+00:00" };

  function reply(over: { rates?: unknown[]; variances?: unknown[] } = {}) {
    let written: unknown[] = [];
    return (request: RecordedRequest): FakeReply => {
      if (request.path === "/rest/v1/fx_variances") {
        if (request.method === "POST") {
          written = request.body as unknown[];
          return { status: 201, body: [] };
        }
        return { body: [...(over.variances ?? []), ...written.map((row) => ({ ...(row as object), recorded_at: "2026-10-13T00:00:00.000Z" }))] };
      }
      if (request.path === "/rest/v1/invoices") return { body: [BILL] };
      if (request.path === "/rest/v1/payment_intents") return { body: [INTENT] };
      if (request.path === "/rest/v1/fx_rates") return { body: over.rates ?? [RATE] };
      return { body: [] };
    };
  }

  it("records the variance of a paid converted bill from the rate in force on its payment day, exactly", async () => {
    const { fake, run } = database(reply());
    const read = await run(() => recordFxVariances(db()));
    const write = fake.requests.find((request) => request.method === "POST" && request.path === "/rest/v1/fx_variances");
    expect(write?.params.get("on_conflict")).toBe("org_id,invoice_id");
    expect(write?.body).toEqual([
      {
        org_id: ORG,
        invoice_id: "bill-1",
        currency: "SGD",
        paid_currency: "USDC",
        paid_amount: "1000.000000",
        paid_at: "2026-10-12T15:00:00.000Z",
        covered_amount: "1350.00",
        decision_rate: "1.35",
        decision_source: "ExchangeRate-API",
        decision_at: "2026-10-10T00:02:00.000Z",
        payment_rate_id: "rate-1",
        payment_rate: "1.36",
        payment_source: "ExchangeRate-API",
        payment_rate_at: "2026-10-12T00:02:00.000Z",
        value_at_payment: "992.650000",
        variance: "7.350000",
      },
    ]);
    // Only the rates of the bill's currency, from 36 hours before the payment up to it.
    const rates = fake.requests.find((request) => request.path === "/rest/v1/fx_rates");
    expect(rates?.params.getAll("published_at")).toEqual(["gte.2026-10-11T03:00:00.000Z", "lte.2026-10-12T15:00:00.000Z"]);
    expect(read.available && read.recorded.map((row) => formatMoney(row.variance, { sign: true }))).toEqual(["+7.35 USDC"]);
    expect(fake.requests.every((request) => carriesOrg(request, ORG))).toBe(true);
  });

  it("says unknown, writes nothing, when no rate was recorded for the payment day", async () => {
    const { fake, run } = database(reply({ rates: [{ ...RATE, published_at: "2026-10-10T00:02:00+00:00" }] }));
    const read = await run(() => recordFxVariances(db()));
    expect(fake.requests.some((request) => request.method === "POST")).toBe(false);
    expect(read).toEqual({
      available: true,
      recorded: [],
      unknown: [{ invoiceId: "bill-1", currency: "SGD", paidAt: "2026-10-12T15:00:00.000Z", reason: "No SGD rate was recorded in the 36 hours before the payment." }],
    });
  });

  it("never records a bill twice, and is not set up before 0113", async () => {
    const recorded = {
      invoice_id: "bill-1",
      currency: "SGD",
      paid_amount: 1000,
      paid_at: "2026-10-12T15:00:00+00:00",
      covered_amount: 1350,
      decision_rate: 1.35,
      decision_source: "ExchangeRate-API",
      decision_at: "2026-10-10T00:02:00+00:00",
      payment_rate_id: "rate-1",
      payment_rate: 1.36,
      payment_source: "ExchangeRate-API",
      payment_rate_at: "2026-10-12T00:02:00+00:00",
      value_at_payment: 992.65,
      variance: 7.35,
      recorded_at: "2026-10-13T00:00:00+00:00",
    };
    const once = database(reply({ variances: [recorded] }));
    const read = await once.run(() => recordFxVariances(db()));
    expect(once.fake.requests.some((request) => request.method === "POST")).toBe(false);
    expect(read.available && read.recorded[0].covered).toEqual({ minor: BigInt(135_000), currency: "SGD" });
    const before = database(() => missing("fx_variances"));
    expect(await before.run(() => recordFxVariances(db()))).toEqual({ available: false });
  });
});

describe("saveScenarioVersion", () => {
  const LEVERS = { horizon: 60, lateDays: 14, costPct: 0, costScope: "all", choices: {} };
  const RATES = [{ currency: "SGD", perUsd: "1.40", reference: { perUsd: "1.3512", source: "ExchangeRate-API", at: "2026-10-13T00:02:31.000Z" } }];

  function versions(last: number | null, insert: (request: RecordedRequest) => FakeReply = (request) => object(request, { id: "version-1", created_at: "2026-10-13T09:00:00.000Z", ...(request.body as object) })) {
    return (request: RecordedRequest): FakeReply => {
      if (request.path === "/rest/v1/cash_scenario_versions" && request.method === "GET") return { body: last === null ? [] : [{ version: last }] };
      if (request.path === "/rest/v1/cash_scenario_versions") return insert(request);
      return { status: 201, body: [] };
    };
  }

  it("saves version 1 of a new scenario, each typed rate as a manual FX adjustment, and signs it", async () => {
    const { fake, run } = database(versions(null));
    const saved = await run(() => saveScenarioVersion({ actorId: OWNER, scenarioId: null, name: "SGD weakens", levers: LEVERS, rates: RATES, reportingCurrency: "SGD", newId: () => "scenario-1" }));
    expect(saved).toMatchObject({ id: "version-1", scenarioId: "scenario-1", version: 1, name: "SGD weakens", rates: [{ currency: "SGD", perUsd: "1.4" }] });
    const inserted = fake.requests.find((request) => request.method === "POST" && request.path === "/rest/v1/cash_scenario_versions");
    expect(inserted?.body).toMatchObject({ org_id: ORG, scenario_id: "scenario-1", version: 1, reporting_currency: "SGD", created_by: OWNER });
    const rate = fake.requests.find((request) => request.path === "/rest/v1/fx_rates");
    expect(rate?.body).toEqual([
      { org_id: ORG, base: "USD", quote: "SGD", rate: "1.4", kind: "manual", source: "Cash scenario", published_at: "2026-10-13T09:00:00.000Z", recorded_by: OWNER, scenario_version_id: "version-1" },
    ]);
    expect(appendBestEffort.mock.calls[0]).toMatchObject([
      ORG,
      { actor: "human", domain: "treasury", action: "cash_scenario_saved", summary: 'Saved version 1 of the cash scenario "SGD weakens", with a rate typed', detail: { version: 1, scenarioId: "scenario-1", rates: [{ currency: "SGD", perUsd: "1.4" }] } },
    ]);
  });

  it("saves the next version of a scenario, never over one", async () => {
    const next = database(versions(2));
    const saved = await next.run(() => saveScenarioVersion({ actorId: OWNER, scenarioId: "scenario-1", name: "SGD weakens", levers: LEVERS, rates: [], reportingCurrency: null }));
    expect(saved.version).toBe(3);
    const raced = database(versions(2, () => ({ status: 409, body: { code: "23505", message: "duplicate key value violates unique constraint \"cash_scenario_versions_version_key\"" } })));
    await expect(raced.run(() => saveScenarioVersion({ actorId: OWNER, scenarioId: "scenario-1", name: "n", levers: LEVERS, rates: [], reportingCurrency: null }))).rejects.toMatchObject({ code: "changed" });
    const unknown = database(versions(null));
    await expect(unknown.run(() => saveScenarioVersion({ actorId: OWNER, scenarioId: "scenario-x", name: "n", levers: LEVERS, rates: [], reportingCurrency: null }))).rejects.toMatchObject({ code: "unknown_scenario" });
  });

  it("is not set up before 0113", async () => {
    const { run } = database(() => missing("cash_scenario_versions"));
    await expect(run(() => saveScenarioVersion({ actorId: OWNER, scenarioId: null, name: "n", levers: LEVERS, rates: [], reportingCurrency: null }))).rejects.toMatchObject({ code: "not_ready" });
  });
});
