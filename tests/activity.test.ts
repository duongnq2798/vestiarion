import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { resetActivityMemory, touchOrgActivity } from "@/lib/platform/activity";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `touchOrgActivity` against a real supabase-js client whose network is a
 * recorder, the same shape as `tests/cron.test.ts`: the module-level "last
 * refreshed" memory is the thing under test, so `resetActivityMemory()` runs
 * before every test.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-0000000ac71a";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

beforeEach(() => resetActivityMemory());
afterEach(() => vi.restoreAllMocks());

describe("touchOrgActivity", () => {
  it("sends the rpc with p_org_id on the first call", async () => {
    const fake = fakeSupabase();
    await runWith({ config, db: fake.client, fetch: fake.fetch }, () => touchOrgActivity(ORG, 1_000_000));

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].path).toBe("/rest/v1/rpc/touch_org_activity");
    expect(fake.requests[0].body).toEqual({ p_org_id: ORG });
  });

  it("sends nothing for a second call within the hour", async () => {
    const fake = fakeSupabase();
    await runWith({ config, db: fake.client, fetch: fake.fetch }, async () => {
      await touchOrgActivity(ORG, 1_000_000);
      await touchOrgActivity(ORG, 1_000_000 + 3_599_999);
    });

    expect(fake.requests).toHaveLength(1);
  });

  it("sends again once more than an hour has passed", async () => {
    const fake = fakeSupabase();
    await runWith({ config, db: fake.client, fetch: fake.fetch }, async () => {
      await touchOrgActivity(ORG, 1_000_000);
      await touchOrgActivity(ORG, 1_000_000 + 3_600_001);
    });

    expect(fake.requests).toHaveLength(2);
  });

  it("resolves without throwing, and warns with the org id and the error message, when the rpc fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeSupabase(() => ({ status: 500, body: { message: "boom" } }));

    await expect(
      runWith({ config, db: fake.client, fetch: fake.fetch }, () => touchOrgActivity(ORG, 1_000_000))
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith("could not record workspace activity", ORG, "boom");
  });
});
