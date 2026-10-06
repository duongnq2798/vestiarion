import { describe, expect, it, vi } from "vitest";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import { orgConfig } from "@/lib/dal/org-config";
import { offerSampleData } from "@/lib/sample-data-offer";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

vi.mock("server-only", () => ({}));

import { listWaitingPayables } from "@/lib/agent/approvals";
import { heldMilestonesTwoApprovals } from "@/lib/agent/milestone-decisions";

/**
 * A workspace on Arc mainnet's own pages read while it is held (final review I2): right after it is created, with no
 * Circle account connected, and while the deployment has Arc mainnet switched off. The Treasury and Approvals pages
 * list waiting payables, and Contractors weighs held milestones against two approvals; none of them may need a
 * provider, which such a workspace does not have. Scopes are built by the real `orgConfig`.
 */

const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "6a1f0c2e-8c1b-4f7a-9e6d-00000000ab02";
const COUNTERPARTY = "6a1f0c2e-8c1b-4f7a-9e6d-00000000cc01";

const WAITING = {
  id: "6a1f0c2e-8c1b-4f7a-9e6d-00000000ee01",
  amount: "5",
  due_date: "2026-10-08",
  status: "held",
  currency: "USDC",
  reasoning: "Held for a person.",
  decided_at: null,
  created_by: null,
  reviewed_at: null,
  counterparty_id: COUNTERPARTY,
  counterparties: { name: "Acme", risk_level: "clear", address: "0x" + "ab".repeat(20), chain: "ARC" },
};

function scope(platform: VestiarionConfig, mode: "sandbox" | "live") {
  const row = { id: ORG, slug: "acme-main", name: "Acme Mainnet", mode, ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null, wallet_host: null, network: "arc-mainnet" as const };
  const { config } = orgConfig(platform, row, null);
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path === "/rest/v1/invoices" && request.method === "GET") return { body: [WAITING] };
    if (request.path === "/rest/v1/approval_policies") return { body: [{ two_approvals_above: "100" }] };
    if (request.path === "/rest/v1/rpc/approvers_besides") return { body: 2 };
    return { body: [] };
  });
  return <T>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
}

const states: Array<[string, VestiarionConfig, "sandbox" | "live"]> = [
  ["on, with no Circle account connected yet", { ...base, mainnetEnabled: true }, "sandbox"],
  ["switched off, after going live", { ...base, mainnetEnabled: false }, "live"],
];

describe.each(states)("a workspace on Arc mainnet %s", (_label, platform, mode) => {
  it("lists its waiting payables without a provider", async () => {
    const run = scope(platform, mode);
    const rows = await run(() => listWaitingPayables());
    expect(rows.map((row) => row.id)).toEqual([WAITING.id]);
  });

  it("weighs its held milestones against two approvals without a provider", async () => {
    const run = scope(platform, mode);
    const held = [{ id: "m-1", amount: 250, created_by: null, contractor_id: COUNTERPARTY }];
    await expect(
      run(() => heldMilestonesTwoApprovals(held, new Map([[COUNTERPARTY, { address: "0x" + "ab".repeat(20) }]]), new Map()))
    ).resolves.toBeInstanceOf(Map);
  });
});

describe("the console's sample data offer (final review I2)", () => {
  it("is never made to a workspace on Arc mainnet, which never simulates", () => {
    const input = { canWrite: true, mode: "sandbox" as const, chainMode: "simulate" as const, counterpartyCount: 0 };
    expect(offerSampleData({ ...input, network: "arc-testnet" })).toBe(true);
    expect(offerSampleData({ ...input, network: "arc-mainnet" })).toBe(false);
  });
});
