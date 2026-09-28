import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { SANDBOX_DAILY_CYCLES, sandboxCyclesUsedToday } from "@/lib/agent/sandbox-cap";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000cafe";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

function orgRow() {
  return { id: ORG, slug: "sandbox-co", name: "Sandbox Co", mode: "sandbox" as const, ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
}

describe("sandboxCyclesUsedToday", () => {
  it("issues a HEAD count on cycle_runs since UTC midnight, for the organization in scope", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow() };
      if (request.path === "/rest/v1/cycle_runs") return { body: [], headers: { "content-range": "*/7" } };
      return { body: [] };
    });

    const count = await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () => sandboxCyclesUsedToday(new Date("2026-09-28T15:00:00Z")))
    );

    expect(count).toBe(7);
    const cycleRuns = fake.requests.find((request: RecordedRequest) => request.path === "/rest/v1/cycle_runs")!;
    expect(cycleRuns.method).toBe("HEAD");
    expect(cycleRuns.params.get("started_at")).toBe("gte.2026-09-28T00:00:00.000Z");
    expect(cycleRuns.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("SANDBOX_DAILY_CYCLES is 20", () => {
    expect(SANDBOX_DAILY_CYCLES).toBe(20);
  });
});
