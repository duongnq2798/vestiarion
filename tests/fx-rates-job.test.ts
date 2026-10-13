import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { recordRatesForWorkspaces } from "@/lib/fx/rates-job";
import type { UsdRate } from "@/lib/fx/usd-rates";
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
});
