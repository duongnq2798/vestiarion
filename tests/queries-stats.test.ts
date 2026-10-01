import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { stats } from "@/lib/queries";
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
