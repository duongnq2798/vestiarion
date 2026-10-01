import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { openMilestoneAmounts } from "@/lib/agent/orchestrator";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * Milestones the treasury and the payment timing count as owed (milestone escrow, review I2): a milestone whose
 * hold is funded already left the operating wallet, so it is not owed from it again. Before 0047 there are no
 * escrow columns, and every open milestone counts, as it always did.
 */

const ORG = "1c8e7a3d-9b2f-4e5c-8a1d-000000000e5d";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

function read(answer: (request: RecordedRequest) => { status?: number; body: unknown }, filter: { statuses: string[]; verifiedOnly?: boolean }) {
  const fake = fakeSupabase(answer);
  return { fake, amounts: runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => openMilestoneAmounts(db(), filter)) };
}

describe("openMilestoneAmounts", () => {
  it("leaves out a milestone whose hold is funded, and keeps every other open one", async () => {
    const { fake, amounts } = read(
      () => ({ body: [{ amount: "50", escrow_state: "funded" }, { amount: "5", escrow_state: null }, { amount: "3", escrow_state: "refunded" }, { amount: "2", escrow_state: "funding" }] }),
      { statuses: ["pending", "verified"] }
    );
    expect(await amounts).toEqual([5, 3, 2]);
    expect(fake.requests[0].params.get("status")).toBe("in.(pending,verified)");
  });

  it("asks only for verified milestones when told to", async () => {
    const { fake, amounts } = read(() => ({ body: [{ amount: "4", escrow_state: null }] }), { statuses: ["verified"], verifiedOnly: true });
    expect(await amounts).toEqual([4]);
    expect(fake.requests[0].params.get("verified")).toBe("eq.true");
    expect(fake.requests[0].params.get("status")).toBe("eq.verified");
  });

  it("counts every open milestone before 0047, when there are no escrow columns", async () => {
    let calls = 0;
    const { amounts } = read(
      () => {
        calls += 1;
        return calls === 1 ? { status: 400, body: { code: "42703", message: "column milestones.escrow_state does not exist" } } : { body: [{ amount: "50" }, { amount: "5" }] };
      },
      { statuses: ["pending", "verified"] }
    );
    expect(await amounts).toEqual([50, 5]);
  });
});
