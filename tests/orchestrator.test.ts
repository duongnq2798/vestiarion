import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { runAgentCycle } from "@/lib/agent/orchestrator";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `runAgentCycle()` moves real money. These tests cover only its two guarded
 * failure paths — an organization whose Circle credentials cannot be read
 * (R12), and a `sim_clock` read that failed outright — and check that each
 * rejects before anything is written. A full happy-path run touches a couple
 * of dozen tables plus the LLM decision path and belongs to an end-to-end
 * check against a real database, not a unit test.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

describe("runAgentCycle — refuses before touching the database (R12)", () => {
  it("rejects when the organization's Circle credentials are stored but unreadable, before any request", async () => {
    const reason = "could not decrypt circle_api_key_enc of organization x: wrong master key, or the ciphertext was altered or moved";
    const unreadable = { ...config, chain: { ...config.chain, credentialsUnreadable: reason } };
    const fake = fakeSupabase();

    await expect(
      runWith({ config: unreadable, db: fake.client, orgId: ORG }, () => runAgentCycle())
    ).rejects.toThrow(/refusing to fall back to simulated payments/);
    expect(fake.requests).toEqual([]);
  });
});

describe("runAgentCycle — the real-clock sim_clock read", () => {
  const realClockConfig = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    CYCLE_CLOCK_MODE: "real",
  });

  it("rejects with the read's own error, and never inserts a cycle_runs row", async () => {
    const fake = fakeSupabase((request) =>
      request.path === "/rest/v1/sim_clock"
        ? { status: 500, body: { message: "sim_clock read failed: connection reset" } }
        : { body: [] }
    );

    await expect(
      runWith({ config: realClockConfig, db: fake.client, orgId: ORG }, () => runAgentCycle())
    ).rejects.toThrow("sim_clock read failed: connection reset");

    expect(fake.requests.some((request) => request.path === "/rest/v1/sim_clock")).toBe(true);
    expect(fake.requests.some((request) => request.path === "/rest/v1/cycle_runs")).toBe(false);
  });

  // A missing row (no organization has run a simulated cycle yet) is the
  // normal case realClockDay() defaults to day 0 for, but proving that
  // through a full runAgentCycle() would mean faking every table the rest of
  // the cycle touches — accounts, invoices, milestones, the ledger RPC, a
  // resolvable signing key, compliance, forecasts, the closing snapshot —
  // for a single `?? 0` default already covered by the identical
  // `.maybeSingle()` pattern in queries.ts's stats(), which
  // tenant-scope-lib.test.ts already exercises end to end. Kept to the error
  // case here, per the reviewed scope of this fix.
});
