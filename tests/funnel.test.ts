import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { funnelRows, readFunnel } from "@/lib/platform/funnel";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * The activation funnel (docs/superpowers/specs/2026-10-09-activation-funnel-design.md): read from `open_funnel`
 * (migration 0089) for one network and a period, validated, and laid out as rows for `npm run numbers`.
 */

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const side = (values: number[]) => ({
  opened: values[0], withRealBill: values[1], withDecision: values[2], withPayment: values[3], paidOnTwoDays: values[4], withVerdict: values[5], withTwoPeople: values[6],
});
const SIDES = { customers: side([6, 4, 4, 3, 0, 1, 0]), ours: side([9, 8, 8, 7, 5, 2, 2]), total: side([15, 12, 12, 10, 5, 3, 2]) };

describe("readFunnel", () => {
  it("asks open_funnel for one network and the period, and reads its counts as numbers", async () => {
    const fake = fakeSupabase(() => ({ body: { sides: { ...SIDES, customers: { ...SIDES.customers, opened: "6" } } } }));
    const sides = await runWith({ config, db: fake.client }, () => readFunnel(new Date("2026-09-27T00:00:00Z"), "arc-testnet"));
    expect(sides.customers).toEqual(SIDES.customers);
    expect(fake.requests[0].path).toBe("/rest/v1/rpc/open_funnel");
    expect(fake.requests[0].body).toEqual({ p_since: "2026-09-27T00:00:00.000Z", p_network: "arc-testnet" });
  });

  it("refuses a document it does not recognise rather than printing a wrong count", async () => {
    const fake = fakeSupabase(() => ({ body: { sides: { customers: { opened: 1 } } } }));
    await expect(runWith({ config, db: fake.client }, () => readFunnel(null, "arc-testnet"))).rejects.toThrow();
  });
});

describe("funnelRows", () => {
  it("lays out each step with the customers lost since the step before, where the steps nest", () => {
    const rows = funnelRows(SIDES);
    expect(rows.map((row) => [row.step, row.customers, row.customersLost])).toEqual([
      ["Workspaces opened", 6, null],
      ["with a real bill (not sample data)", 4, 2],
      ["with the agent's decision on one", 4, 0],
      ["with a confirmed payment", 3, 1],
      ["with payments on two days or more", 0, null],
      ["with a verdict in shadow mode", 1, null],
      ["with two people or more", 0, null],
    ]);
    expect(rows[0]).toMatchObject({ ours: 9, total: 15 });
  });

  it("shows no drop where a later step counts more than the one before", () => {
    const rows = funnelRows({ ...SIDES, customers: side([2, 1, 0, 1, 0, 0, 0]) });
    expect(rows[3].customersLost).toBeNull();
  });
});
