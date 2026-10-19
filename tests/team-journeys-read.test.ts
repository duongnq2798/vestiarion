import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), scope: vi.fn(), keys: vi.fn(), org: vi.fn(), tenant: vi.fn() }));
vi.mock("@/lib/dal", () => ({ platformDb: () => ({ rpc: mocks.rpc, from: mocks.org }), db: () => ({ from: mocks.tenant }) }));
vi.mock("@/lib/dal/scope", () => ({ withOrg: mocks.scope }));
vi.mock("@/lib/ledger", () => ({ ledgerPublicKeyPems: mocks.keys }));

const orgId = "b5d3ab42-2902-4b21-8662-d2bd99bb9766";
const row = { orgId, amount: 1, currency: "USDC", network: "arc-mainnet", status: "paid", received: null, check: null, hold: null, approval: null, record: null,
  observed: { hasPurchaseOrder: null, goodsReceived: null, purchaseOrderRequired: null, riskLevel: null }, rule: null,
  payment: { route: "direct", confirmationRecordedAt: null, txHash: `0x${"ab".repeat(32)}`, mintTxHash: null, destinationChain: "ARC", feeUsdc: null } };
const scheduledCheck = { seq: 21, recordedAt: "2027-01-01T09:00:00Z", action: "ap_schedule",
  link: { body_hash: "a".repeat(64), signature: "b".repeat(128), prev_hash: "c".repeat(64), hash: "d".repeat(64), signing_key_id: null } };
const scheduleDetail = { decision: { action: "schedule", payOn: "2027-01-03", reasoning: "PRIVATE-REASONING" },
  timing: { today: "2027-01-01", dueOn: "2027-01-03", targetOn: "2027-01-03", amountDueAtTarget: 1, discountValue: null, shortfall: false,
    reason: "No early-payment discount; paying on the due date, Jan 3, 2027, keeps 1 USDC available until then." },
  terms: { name: "PRIVATE-NAME" } };

function entryRead(data: unknown, error: unknown = null) {
  const filters: Record<string, unknown> = {};
  const chain = { select: () => chain, eq: (key: string, value: unknown) => { filters[key] = value; return chain; }, maybeSingle: async () => ({ data, error }) };
  return { chain, filters };
}

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

  it("derives a public schedule summary from only the selected signed entry inside its team scope", async () => {
    const { readTeamJourneys } = await import("@/lib/platform/team-journeys");
    mocks.rpc.mockResolvedValue({ data: { direct: { ...row, check: scheduledCheck }, base: null }, error: null });
    const entry = entryRead({ seq: 21, actor: "agent", action: "ap_schedule", body_hash: scheduledCheck.link.body_hash, detail: scheduleDetail });
    let inScope = false;
    mocks.scope.mockImplementation(async (id, callback) => { inScope = id === orgId; try { return await callback(); } finally { inScope = false; } });
    mocks.tenant.mockImplementation((table) => { expect(inScope).toBe(true); expect(table).toBe("ledger_entries"); return entry.chain; });
    const shown = await readTeamJourneys(0);
    expect(shown?.direct?.decision).toEqual({ payOn: "2027-01-03", reason: "no_early_payment_discount" });
    expect(entry.filters).toMatchObject({ seq: 21, action: "ap_schedule", body_hash: scheduledCheck.link.body_hash, actor: "agent" });
    expect(JSON.stringify(shown)).not.toMatch(/PRIVATE-|reasoning|terms|orgId/);
  });

  it("keeps confirmed payment evidence when optional decision detail is unavailable or does not match the signed selection", async () => {
    const { readTeamJourneys } = await import("@/lib/platform/team-journeys");
    mocks.rpc.mockResolvedValue({ data: { direct: { ...row, check: scheduledCheck }, base: null }, error: null });
    let now = 0;
    for (const response of [
      entryRead(null, { message: "PRIVATE-FAILURE" }),
      entryRead({ seq: 22, actor: "agent", action: "ap_schedule", body_hash: scheduledCheck.link.body_hash, detail: scheduleDetail }),
      entryRead({ seq: 21, actor: "agent", action: "ap_schedule", body_hash: "e".repeat(64), detail: scheduleDetail }),
    ]) {
      mocks.tenant.mockReturnValue(response.chain);
      const shown = await readTeamJourneys(now);
      now += 60_001;
      expect(shown?.direct?.payment.source.hash).toBe(`0x${"ab".repeat(32)}`);
      expect(shown?.direct?.decision).toBeNull();
    }
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("PRIVATE-FAILURE");
  });

  it("leaves unsupported or inconsistent timing explanations unknown and never assumes the October example's date", async () => {
    const { readTeamJourneys } = await import("@/lib/platform/team-journeys");
    mocks.rpc.mockResolvedValue({ data: { direct: { ...row, check: scheduledCheck }, base: null }, error: null });
    let now = 0;
    for (const timing of [
      { ...scheduleDetail.timing, reason: "PRIVATE-NAME says there was no discount" },
      { ...scheduleDetail.timing, discountValue: 0.1 },
      { ...scheduleDetail.timing, shortfall: true },
      { ...scheduleDetail.timing, dueOn: "2027-01-04" },
      { ...scheduleDetail.timing, targetOn: "2027-01-02" },
    ]) {
      mocks.tenant.mockReturnValue(entryRead({ seq: 21, actor: "agent", action: "ap_schedule", body_hash: scheduledCheck.link.body_hash, detail: { ...scheduleDetail, timing } }).chain);
      expect((await readTeamJourneys(now))?.direct?.decision).toEqual({ payOn: "2027-01-03", reason: null });
      now += 60_001;
    }
    mocks.tenant.mockReturnValue(entryRead({ seq: 21, actor: "agent", action: "ap_schedule", body_hash: scheduledCheck.link.body_hash,
      detail: { ...scheduleDetail, decision: { action: "schedule", payOn: "2027-02-30" } } }).chain);
    expect((await readTeamJourneys(now))?.direct?.decision).toBeNull();
  });

  it("uses the same safe summary in the fallback and never promotes a schedule recorded after the transfer", async () => {
    const { readTeamJourneys } = await import("@/lib/platform/team-journeys");
    const builder = (data: unknown) => { const chain: Record<string, unknown> = {}; for (const name of ["select", "eq", "order"]) chain[name] = () => chain; chain.limit = async () => ({ data, error: null }); chain.maybeSingle = async () => ({ data, error: null }); return chain; };
    mocks.org.mockReturnValue(builder({ mode: "live", network: "arc-mainnet" }));
    const before = { ...scheduledCheck.link, seq: 21, ts: scheduledCheck.recordedAt, actor: "agent", action: "ap_schedule", detail: { invoiceId: "private-source", ...scheduleDetail } };
    const record = { ...scheduledCheck.link, seq: 23, ts: "2027-01-01T09:21:00Z", actor: "human", action: "approval_paid", detail: { invoiceId: "private-source", txRef: `0x${"ab".repeat(32)}` } };
    const after = { ...before, seq: 24, ts: "2027-01-01T09:22:00Z", detail: { ...before.detail, decision: { action: "schedule", payOn: "2027-01-04" } } };
    for (const [index, entries] of [[before, record, after], [record, after]].entries()) {
      mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202" } }).mockResolvedValueOnce({ data: { orgId, network: "arc-mainnet" }, error: null });
      mocks.tenant.mockImplementation((table) => builder(table === "payment_intents" ? [{ source_id: "private-source", amount: 1, token: "USDC", chain: "ARC", network: "arc-mainnet", status: "confirmed", provider: "circle", provider_mode: "live", destination_chain: "BASE", tx_hash: `0x${"ab".repeat(32)}`, mint_tx_hash: `0x${"cd".repeat(32)}`, confirmed_at: "2027-01-01T09:20:00Z", bridge_fee: 0.055026, payout_route: null }] : table === "invoices" ? { direction: "payable", status: "paid", counterparties: { sample: false } } : entries));
      const shown = await readTeamJourneys(index * 60_001);
      expect(shown?.base?.decision).toEqual(index === 0 ? { payOn: "2027-01-03", reason: "no_early_payment_discount" } : null);
      expect(shown?.base?.payment.feeUsdc).toBe(0.055026);
      expect(JSON.stringify(shown)).not.toMatch(/PRIVATE-|private-source|reasoning|terms/);
    }
  });
});
