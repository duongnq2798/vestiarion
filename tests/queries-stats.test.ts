import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { shellClock, stats } from "@/lib/queries";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * "Paid out to date" is what actually left the business. An invoice paid
 * with an early-payment discount carries `paid_amount` (migration 0038), the
 * transfer's amount; an invoice paid before that column existed, or without
 * a discount, has none, and its full amount is what left.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0b";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

describe("stats — paid out to date", () => {
  it("adds up USDC only, and still counts a EURC transfer as settled on chain (EURC design R3)", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/invoices" && request.params.get("status") === "eq.paid" && !request.headers.get("prefer")?.includes("count")) {
        return {
          body: [
            { amount: "10", paid_amount: null, tx_ref: "0xusdc", currency: "USDC" },
            { amount: "8", paid_amount: null, tx_ref: "0xeurc", currency: "EURC" },
          ],
        };
      }
      return { body: [] };
    });
    const result = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => stats());
    expect(result.totalPaidOut).toBe(10);
    expect(result.onchainTransfers).toBe(2);
    const [paid] = fake.requests.filter((r) => r.path === "/rest/v1/invoices" && r.params.get("status") === "eq.paid");
    expect(paid.params.get("select")).toContain("currency");
  });

  it("sums paid_amount where an invoice has one, and the invoice amount where it does not", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/invoices" && request.params.get("status") === "eq.paid" && !request.headers.get("prefer")?.includes("count")) {
        return {
          body: [
            { amount: "400", paid_amount: "392.000000", tx_ref: "0xabc" },
            { amount: "100", paid_amount: null, tx_ref: "sim_1" },
          ],
        };
      }
      if (request.path === "/rest/v1/milestones") return { body: [{ amount: "50", tx_ref: null }] };
      return { body: [] };
    });

    const result = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => stats());

    expect(result.totalPaidOut).toBe(542);
    const [paid] = fake.requests.filter((r) => r.path === "/rest/v1/invoices" && r.params.get("status") === "eq.paid");
    expect(paid.params.get("select")).toContain("paid_amount");
  });
});

describe("shellClock — the header's clock alone (close pack page speed CS4)", () => {
  it("reads the simulated day and the last cycle, and nothing stats() adds up or counts", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/sim_clock") return { body: [{ current_day: 12 }] };
      if (request.path === "/rest/v1/ledger_entries") return { body: [{ ts: "2026-10-26T08:00:00+00:00" }] };
      return { body: [] };
    });
    const clock = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => shellClock());
    expect(clock).toEqual({ day: 12, clockMode: expect.any(String), lastCycleAt: "2026-10-26T08:00:00+00:00" });
    expect(fake.requests.map((request) => request.path).sort()).toEqual(["/rest/v1/ledger_entries", "/rest/v1/sim_clock"]);
    const [cycle] = fake.requests.filter((request) => request.path === "/rest/v1/ledger_entries");
    expect(cycle.params.get("action")).toBe("eq.cycle_complete");
    expect(cycle.params.get("order")).toBe("seq.desc");
    expect(cycle.params.get("limit")).toBe("1");
  });

  it("reads day 0 and no cycle for a workspace that has never run one, as stats() does", async () => {
    const fake = fakeSupabase(() => ({ body: [] }));
    const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
    const clock = await run(() => shellClock());
    expect(clock).toMatchObject({ day: 0, lastCycleAt: null });
    const all = await run(() => stats());
    expect({ day: all.day, clockMode: all.clockMode, lastCycleAt: all.lastCycleAt }).toEqual(clock);
  });
});
