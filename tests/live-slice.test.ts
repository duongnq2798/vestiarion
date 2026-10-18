import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Start the live slice (docs/superpowers/specs/2026-10-18-live-slice-design.md L2-L6): from a shadow workspace on Arc
 * testnet, a workspace on Arc mainnet is made by the usual `createWorkspace`, the chosen vendors are carried through
 * `createCounterparty` (an own address waiting for a person, a mirror address never), and the shadow workspace signs
 * `live_slice_started`. Refused outside shadow mode, on Arc mainnet, twice, with no vendor or too many, at the limit.
 */

const { createWorkspaceMock, createCounterpartyMock, shadowMock } = vi.hoisted(() => ({
  createWorkspaceMock: vi.fn(),
  createCounterpartyMock: vi.fn(),
  shadowMock: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/platform/workspace", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/platform/workspace")>()), createWorkspace: createWorkspaceMock }));
vi.mock("@/lib/counterparties/create", () => ({ createCounterparty: createCounterpartyMock }));
vi.mock("@/lib/shadow-mode", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/shadow-mode")>()), readShadowMode: shadowMock }));

import { readLiveSlice, sliceVendors, startLiveSlice, SLICE_MAX_VENDORS } from "@/lib/live-slice";
import { WorkspaceLimitError } from "@/lib/platform/workspace";

const SHADOW = "0b6c1c9e-4a4f-4a7e-9b1e-0000000005a0";
const LIVE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000005a1";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000005e1";
const OWN = "0b6c1c9e-4a4f-4a7e-9b1e-0000000005c1";
const MIRRORED = "0b6c1c9e-4a4f-4a7e-9b1e-0000000005c2";
const NONE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000005c3";
const NO_LIMIT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000005c4";
const ADDRESS = "0x97f85033BBd83870A841cF7153f35B387746b6B6";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

const vendor = (id: string, name: string, fields: Record<string, unknown> = {}) => ({
  id,
  name,
  role: "vendor",
  address: null,
  mirror_wallet_id: null,
  baseline_payment_limit: "200",
  notice_email: null,
  jurisdiction: null,
  purchase_order_required: true,
  sample: false,
  ...fields,
});
const VENDORS = [
  vendor(OWN, "Cobalt Cloud", { address: ADDRESS, notice_email: "billing@cobalt.example", purchase_order_required: false }),
  vendor(MIRRORED, "Lumen Print Co.", { address: "0x1111111111111111111111111111111111111111", mirror_wallet_id: "wallet-1", baseline_payment_limit: "50" }),
  vendor(NONE, "Northwind Referrals"),
  vendor(NO_LIMIT, "Taller Norte", { baseline_payment_limit: null }),
];

function workspace(start: { network?: string; slice?: boolean; vendors?: unknown[] } = {}) {
  const fake = fakeSupabase((sent: RecordedRequest): FakeReply => {
    if (sent.path === "/rest/v1/orgs") {
      const id = sent.params.get("id")?.replace(/^eq\./, "");
      if (sent.params.get("select")?.includes("mode") && id === LIVE) return { body: [{ id: LIVE, slug: "pinecrest-studio-live", name: "Pinecrest Studio live slice", mode: "sandbox" }] };
      if (sent.params.get("select") === "name") return { body: [{ name: "Pinecrest Studio" }] };
      return { body: orgs.orgRow(id ?? SHADOW, start.network ? { network: start.network } : {}) };
    }
    if (sent.path === "/rest/v1/ledger_entries") {
      return { body: start.slice ? [{ ts: "2026-10-18T09:30:00Z", detail: { liveOrgId: LIVE, liveSlug: "pinecrest-studio-live", vendors: [{}, {}] } }] : [] };
    }
    if (sent.path === "/rest/v1/counterparties") {
      const ids = sent.params.get("id")?.replace(/^in\.\(|\)$/g, "").split(",") ?? null;
      const rows = (start.vendors ?? VENDORS) as Array<{ id: string }>;
      return { body: ids ? rows.filter((row) => ids.includes(row.id)) : rows };
    }
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(SHADOW, fn, { userId: USER }));
  return { fake, run };
}

const ledgerOf = (requests: RecordedRequest[], action: string) =>
  requests.filter((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry").map((sent) => sent.body as { p_action: string; p_detail: Record<string, unknown> }).find((body) => body.p_action === action);

beforeEach(() => {
  createWorkspaceMock.mockReset().mockResolvedValue({ orgId: LIVE, slug: "pinecrest-studio-live" });
  createCounterpartyMock.mockReset().mockResolvedValue({ id: "new", name: "x", screening: { riskLevel: "clear" } });
  shadowMock.mockReset().mockResolvedValue({ currency: "USDC", startedAt: "2026-10-08T00:00:00Z", startedBy: USER });
});

describe("startLiveSlice", () => {
  it("opens a workspace on Arc mainnet and carries the chosen vendors, an own address waiting for a person and a mirror never", async () => {
    const { fake, run } = workspace();
    const started = await run(() => startLiveSlice({ userId: USER, vendorIds: [OWN, MIRRORED, NONE, NO_LIMIT] }));

    expect(createWorkspaceMock).toHaveBeenCalledWith({ userId: USER, name: "Pinecrest Studio live slice", network: "arc-mainnet" });
    expect(started).toMatchObject({ slug: "pinecrest-studio-live", skipped: 1 });
    expect(started.carried.map((carried) => [carried.name, carried.address])).toEqual([
      ["Cobalt Cloud", "own"],
      ["Lumen Print Co.", "mirror"],
      ["Northwind Referrals", "none"],
    ]);

    const calls = createCounterpartyMock.mock.calls.map((call) => call[0] as Record<string, unknown> & { counterparty: Record<string, unknown> });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      actorId: USER,
      via: "live_slice",
      liveSlice: { fromOrgId: SHADOW, fromCounterpartyId: OWN },
      purchaseOrderRequired: false,
      counterparty: { name: "Cobalt Cloud", role: "vendor", address: ADDRESS, paymentLimit: "200", noticeEmail: "billing@cobalt.example" },
    });
    // The mirror address is a wallet of the shadow workspace's on Arc testnet: never carried.
    expect(calls[1].counterparty).toMatchObject({ name: "Lumen Print Co.", address: null, paymentLimit: "50" });
    expect(calls[2].counterparty).toMatchObject({ name: "Northwind Referrals", address: null });

    expect(ledgerOf(fake.requests, "live_slice_started")?.p_detail).toEqual({
      by: USER,
      liveOrgId: LIVE,
      liveSlug: "pinecrest-studio-live",
      vendors: [
        { counterpartyId: OWN, name: "Cobalt Cloud", address: "own" },
        { counterpartyId: MIRRORED, name: "Lumen Print Co.", address: "mirror" },
        { counterpartyId: NONE, name: "Northwind Referrals", address: "none" },
      ],
      skipped: 1,
    });
  });

  it("is refused outside shadow mode, on Arc mainnet, and when a slice was opened already, before anything is made", async () => {
    shadowMock.mockResolvedValueOnce(null);
    await expect(workspace().run(() => startLiveSlice({ userId: USER, vendorIds: [OWN] }))).rejects.toMatchObject({ code: "not_shadow" });
    await expect(workspace({ network: "arc-mainnet" }).run(() => startLiveSlice({ userId: USER, vendorIds: [OWN] }))).rejects.toMatchObject({ code: "mainnet_workspace" });
    await expect(workspace({ slice: true }).run(() => startLiveSlice({ userId: USER, vendorIds: [OWN] }))).rejects.toMatchObject({ code: "already" });
    expect(createWorkspaceMock).not.toHaveBeenCalled();
  });

  it("is refused with no vendor that can go, too many, or at the workspace limit", async () => {
    await expect(workspace().run(() => startLiveSlice({ userId: USER, vendorIds: [] }))).rejects.toMatchObject({ code: "no_vendors" });
    await expect(workspace().run(() => startLiveSlice({ userId: USER, vendorIds: [NO_LIMIT] }))).rejects.toMatchObject({ code: "no_vendors" });
    const many = Array.from({ length: SLICE_MAX_VENDORS + 1 }, (_, index) => `0b6c1c9e-4a4f-4a7e-9b1e-${String(index).padStart(12, "0")}`);
    await expect(workspace().run(() => startLiveSlice({ userId: USER, vendorIds: many }))).rejects.toMatchObject({ code: "too_many" });
    expect(createWorkspaceMock).not.toHaveBeenCalled();
    createWorkspaceMock.mockRejectedValueOnce(new WorkspaceLimitError("arc-mainnet"));
    await expect(workspace().run(() => startLiveSlice({ userId: USER, vendorIds: [OWN] }))).rejects.toMatchObject({ code: "limit" });
  });
});

describe("sliceVendors and readLiveSlice", () => {
  it("lists the vendors with how each address would go, never sample data", async () => {
    const { run } = workspace({ vendors: [...VENDORS, vendor("0b6c1c9e-4a4f-4a7e-9b1e-0000000005c9", "Sample Co", { sample: true })] });
    const listed = await run(() => sliceVendors(db()));
    expect(listed.map((row) => [row.name, row.address, row.paymentLimit])).toEqual([
      ["Cobalt Cloud", "own", 200],
      ["Lumen Print Co.", "mirror", 50],
      ["Northwind Referrals", "none", 200],
      ["Taller Norte", "none", null],
    ]);
  });

  it("reads the slice opened from here, and whether its workspace is live", async () => {
    expect(await workspace().run(() => readLiveSlice(db()))).toBeNull();
    expect(await workspace({ slice: true }).run(() => readLiveSlice(db()))).toEqual({
      orgId: LIVE,
      slug: "pinecrest-studio-live",
      name: "Pinecrest Studio live slice",
      live: false,
      startedAt: "2026-10-18T09:30:00Z",
      vendors: 2,
    });
  });
});
