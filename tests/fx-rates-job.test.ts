import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { recordRatesForWorkspaces } from "@/lib/fx/rates-job";
import { FxRateError, type UsdRate } from "@/lib/fx/usd-rates";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The hourly rates job (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M5, M6): in each workspace that
 * reports or plans in another currency it stores the day's reference rates, then records the FX variance its paid bills
 * now allow. A workspace that needs no rate is left alone; one that fails is counted, never named; nothing it touches
 * decides or pays.
 */

const A = "5d0f3a2e-8c1b-4f7a-9e6d-00000000f150";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const feed = vi.fn(async (currency: string): Promise<UsdRate> => ({ currency, perUsd: currency === "SGD" ? 1.36 : 4.47, source: "ExchangeRate-API", at: "2026-10-12T00:02:00.000Z" }));

function workspace(tables: Record<string, (request: RecordedRequest) => FakeReply>) {
  return fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs" && request.params.get("select") === "id") return { body: [{ id: A }] };
    if (request.path === "/rest/v1/orgs") {
      return { body: { id: A, slug: "rates-co", name: "Rates Co", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
    }
    const table = request.path.replace("/rest/v1/", "");
    return tables[table]?.(request) ?? { body: [] };
  });
}

const run = (fake: ReturnType<typeof fakeSupabase>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => recordRatesForWorkspaces({ rate: feed }));

describe("recordRatesForWorkspaces", () => {
  it("stores the rates a workspace reports and pays bills in, then records the variances they allow", async () => {
    feed.mockClear();
    const fake = workspace({
      reporting_currencies: () => ({ body: [{ currency: "MYR", set_by: null, set_at: "2026-10-01T00:00:00Z" }] }),
      shadow_modes: () => ({ body: [{ currency: "SGD", started_at: "2026-10-01T00:00:00Z", started_by: null }] }),
      invoices: (request) => (request.params.get("select") === "original_currency" ? { body: [{ original_currency: "SGD" }, { original_currency: "USD" }] } : { body: [] }),
      fx_rates: (request) => (request.method === "POST" ? { status: 201, body: [] } : { body: [] }),
    });
    expect(await run(fake)).toEqual({ workspaces: 1, rates: 2, variances: 0, failed: 0, skipped: 0 });
    expect(feed.mock.calls.map(([currency]) => currency)).toEqual(["MYR", "SGD"]);
    const stored = fake.requests.find((request) => request.path === "/rest/v1/fx_rates" && request.method === "POST");
    expect((stored?.body as Array<{ quote: string }>).map((row) => row.quote)).toEqual(["MYR", "SGD"]);
    // It reads the paid bills for their variances, and writes nothing but rates and variances.
    expect(fake.requests.filter((request) => request.method !== "GET").map((request) => request.path)).toEqual(["/rest/v1/fx_rates"]);
  });

  it("leaves a workspace alone that needs no rate, or where 0113 has not run", async () => {
    feed.mockClear();
    const none = workspace({ reporting_currencies: () => ({ body: [] }), shadow_modes: () => ({ body: [] }), invoices: () => ({ body: [] }) });
    expect(await run(none)).toEqual({ workspaces: 0, rates: 0, variances: 0, failed: 0, skipped: 0 });
    const before = workspace({ reporting_currencies: () => ({ status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.reporting_currencies' in the schema cache" } }) });
    expect(await run(before)).toEqual({ workspaces: 0, rates: 0, variances: 0, failed: 0, skipped: 0 });
    expect(feed).not.toHaveBeenCalled();
  });

  it("counts a workspace that failed, and logs it by id alone", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = workspace({
      reporting_currencies: () => ({ body: [{ currency: "SGD", set_by: null, set_at: "2026-10-01T00:00:00Z" }] }),
      shadow_modes: () => ({ status: 500, body: { code: "XX000", message: "boom" } }),
    });
    expect(await run(failing)).toMatchObject({ workspaces: 0, failed: 1 });
    expect(logged.mock.calls.flat().join(" ")).not.toMatch(/rates-co|Rates Co/);
    logged.mockRestore();
  });

  it("asks a feed that is down once a run, never again for each workspace, and still records every workspace's variances", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const ids = Array.from({ length: 30 }, (_, index) => `5d0f3a2e-8c1b-4f7a-9e6d-${String(index).padStart(12, "0")}`);
    // Each read of a feed that does not answer waits out its 10-second timeout.
    let clock = 0;
    const down = vi.fn(async (): Promise<UsdRate> => {
      clock += 10_000;
      throw new FxRateError("The day's rate could not be read. Try again in a moment.");
    });
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs" && request.params.get("select") === "id") return { body: ids.map((id) => ({ id })) };
      if (request.path === "/rest/v1/orgs") {
        const id = (request.params.get("id") ?? "").replace("eq.", "");
        return { body: { id, slug: `w-${id.slice(-2)}`, name: "W", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
      }
      if (request.path === "/rest/v1/reporting_currencies") return { body: [{ currency: "MYR", set_by: null, set_at: "2026-10-01T00:00:00Z" }] };
      if (request.path === "/rest/v1/shadow_modes") return { body: [{ currency: "SGD", started_at: "2026-10-01T00:00:00Z", started_by: null }] };
      return { body: [] };
    });
    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => recordRatesForWorkspaces({ rate: down, now: () => clock, budgetMs: 240_000 }));
    expect(down).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ workspaces: 30, rates: 0, variances: 0, failed: 0, skipped: 0 });
    // Each workspace still looked for the variances its stored rates allow.
    expect(fake.requests.filter((request) => request.path === "/rest/v1/fx_variances").length).toBe(30);
    logged.mockRestore();
  });

  it("keeps asking for the other currencies when the feed lists no rate for one", async () => {
    const partial = vi.fn(async (currency: string): Promise<UsdRate> => {
      if (currency === "MYR") throw new FxRateError("There is no rate for MYR. Choose another currency.");
      return { currency, perUsd: 1.36, source: "ExchangeRate-API", at: "2026-10-12T00:02:00.000Z" };
    });
    const fake = workspace({
      reporting_currencies: () => ({ body: [{ currency: "MYR", set_by: null, set_at: "2026-10-01T00:00:00Z" }] }),
      shadow_modes: () => ({ body: [{ currency: "SGD", started_at: "2026-10-01T00:00:00Z", started_by: null }] }),
      fx_rates: (request) => (request.method === "POST" ? { status: 201, body: [] } : { body: [] }),
    });
    expect(await runWith({ config, db: fake.client, fetch: fake.fetch }, () => recordRatesForWorkspaces({ rate: partial }))).toMatchObject({ workspaces: 1, rates: 1, failed: 0 });
    expect(partial.mock.calls.map(([currency]) => currency)).toEqual(["MYR", "SGD"]);
  });

  it("records a rate for every currency the report converts: what the business paid in, and the euro for EURC", async () => {
    const read = vi.fn(async (currency: string): Promise<UsdRate> => ({ currency, perUsd: 2, source: "ExchangeRate-API", at: "2026-10-12T00:02:00.000Z" }));
    const fake = workspace({
      reporting_currencies: () => ({ body: [{ currency: "SGD", set_by: null, set_at: "2026-10-01T00:00:00Z" }] }),
      shadow_modes: () => ({ body: [] }),
      invoices: (request) => (request.params.get("select") === "currency" ? { body: [{ currency: "EURC" }] } : { body: [] }),
      payment_actuals: () => ({ body: [{ currency: "PHP" }, { currency: "USDC" }, { currency: "USD" }] }),
      fx_rates: (request) => (request.method === "POST" ? { status: 201, body: [] } : { body: [] }),
    });
    expect(await runWith({ config, db: fake.client, fetch: fake.fetch }, () => recordRatesForWorkspaces({ rate: read }))).toMatchObject({ workspaces: 1, rates: 3, failed: 0 });
    expect(read.mock.calls.map(([currency]) => currency)).toEqual(["EUR", "PHP", "SGD"]);
  });
});
