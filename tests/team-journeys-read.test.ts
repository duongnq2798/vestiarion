import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), scope: vi.fn(), keys: vi.fn(), org: vi.fn(), tenant: vi.fn() }));
vi.mock("@/lib/dal", () => ({ platformDb: () => ({ rpc: mocks.rpc, from: mocks.org }), db: () => ({ from: mocks.tenant }) }));
vi.mock("@/lib/dal/scope", () => ({ withOrg: mocks.scope }));
vi.mock("@/lib/ledger", () => ({ ledgerPublicKeyPems: mocks.keys }));

const orgId = "b5d3ab42-2902-4b21-8662-d2bd99bb9766";
const row = { orgId, amount: 1, currency: "USDC", network: "arc-mainnet", status: "paid", received: null, check: null, hold: null, approval: null, record: null,
  observed: { hasPurchaseOrder: null, goodsReceived: null, purchaseOrderRequired: null, riskLevel: null }, rule: null,
  payment: { route: "direct", confirmationRecordedAt: null, txHash: `0x${"ab".repeat(32)}`, mintTxHash: null, destinationChain: "ARC", feeUsdc: null } };

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: { direct: row, base: null }, error: null });
  mocks.scope.mockImplementation(async (_id, callback) => callback());
  mocks.keys.mockReturnValue({ public: "PEM" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("readTeamJourneys", () => {
  it("reads only the whitelisted RPC, obtains keys in scope, strips private identity and caches for a minute", async () => {
    const { readTeamJourneys } = await import("@/lib/platform/team-journeys");
    const first = await readTeamJourneys(0);
    expect(mocks.rpc).toHaveBeenCalledWith("landing_team_journeys");
    expect(mocks.scope).toHaveBeenCalledWith(orgId, expect.any(Function));
    expect(first?.direct?.publicKeys).toEqual({ public: "PEM" });
    expect(JSON.stringify(first)).not.toContain(orgId);
    await readTeamJourneys(60_000); expect(mocks.rpc).toHaveBeenCalledTimes(1);
    await readTeamJourneys(60_001); expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("distinguishes an empty successful read from unavailable data and discards a failed cached promise", async () => {
    const { readTeamJourneys } = await import("@/lib/platform/team-journeys");
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "private database failure" } });
    expect(await readTeamJourneys(0)).toBeNull();
    mocks.rpc.mockResolvedValueOnce({ data: { direct: null, base: null }, error: null });
    expect(await readTeamJourneys(1)).toEqual({ direct: null, base: null });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private database failure");
  });

  it("does not publish a malformed payment and preserves the independent valid slot", async () => {
    const { readTeamJourneys } = await import("@/lib/platform/team-journeys");
    mocks.rpc.mockResolvedValue({ data: { direct: { ...row, amount: null }, base: { ...row, payment: { ...row.payment, route: "cctp", destinationChain: "BASE", mintTxHash: `0x${"cd".repeat(32)}` } } }, error: null });
    const shown = await readTeamJourneys(0);
    expect(shown?.direct).toBeNull(); expect(shown?.base?.payment.destination.chain).toBe("BASE");
  });

  it("uses only the existing team selector's scope when the new RPC is not deployed, with real mint evidence", async () => {
    const { readTeamJourneys } = await import("@/lib/platform/team-journeys");
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202" } }).mockResolvedValueOnce({ data: { orgId, network: "arc-mainnet" }, error: null });
    const builder = (data: unknown) => { const chain: Record<string, unknown> = {}; for (const name of ["select", "eq", "order"]) chain[name] = () => chain; chain.limit = async () => ({ data, error: null }); chain.maybeSingle = async () => ({ data, error: null }); return chain; };
    mocks.org.mockReturnValue(builder({ mode: "live", network: "arc-mainnet" }));
    mocks.tenant.mockImplementation((table) => builder(table === "payment_intents" ? [{ source_id: "private-source", amount: 1, token: "USDC", chain: "ARC", network: "arc-mainnet", status: "confirmed", provider: "circle", provider_mode: "live", destination_chain: "BASE", tx_hash: `0x${"ab".repeat(32)}`, mint_tx_hash: `0x${"cd".repeat(32)}`, confirmed_at: null, bridge_fee: null, payout_route: null }] : table === "invoices" ? { direction: "payable", status: "paid", counterparties: { sample: false } } : []));
    const shown = await readTeamJourneys(0);
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual(["landing_team_journeys", "latest_team_decision"]);
    expect(mocks.scope).toHaveBeenCalledWith(orgId, expect.any(Function));
    expect(shown?.direct).toBeNull(); expect(shown?.base?.payment.destination.chain).toBe("BASE");
    expect(JSON.stringify(shown)).not.toMatch(/private-source|orgId/);
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202" } }).mockResolvedValueOnce({ data: { orgId, network: "arc-mainnet" }, error: null });
    mocks.tenant.mockImplementation((table) => builder(table === "payment_intents" ? [{ source_id: "private-sample", amount: 1, token: "USDC", chain: "ARC", network: "arc-mainnet", status: "confirmed", provider: "circle", provider_mode: "live", destination_chain: "BASE", tx_hash: `0x${"ab".repeat(32)}`, mint_tx_hash: `0x${"cd".repeat(32)}`, confirmed_at: null, bridge_fee: null, payout_route: null }] : { direction: "payable", status: "paid", counterparties: { sample: true } }));
    expect(await readTeamJourneys(60_001)).toEqual({ direct: null, base: null });
  });

  it("never falls back on other errors, or into a testnet or no-longer-live selector scope", async () => {
    const { readTeamJourneys } = await import("@/lib/platform/team-journeys");
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501" } });
    expect(await readTeamJourneys(0)).toBeNull(); expect(mocks.rpc).toHaveBeenCalledTimes(1);
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202" } }).mockResolvedValueOnce({ data: { orgId, network: "arc-testnet" }, error: null });
    expect(await readTeamJourneys(1)).toEqual({ direct: null, base: null }); expect(mocks.scope).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202" } }).mockResolvedValueOnce({ data: { orgId, network: "arc-mainnet" }, error: null });
    mocks.org.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { mode: "sandbox", network: "arc-mainnet" }, error: null }) }) }) });
    expect(await readTeamJourneys(60_002)).toEqual({ direct: null, base: null }); expect(mocks.scope).not.toHaveBeenCalled();
  });
});
