import { beforeEach, describe, expect, it, vi } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import { escrowStepKey } from "@/lib/circle/escrow-setup";
import { EscrowHoldError, HOLDS_SELECTOR, holdId, lockMilestone, readHold, refundMilestone, type EscrowHoldClient } from "@/lib/circle/escrow-holds";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Locking a milestone in escrow (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md E3): approve, then
 * fund, from the operating wallet under the request's keys; the hold's id is the milestone's. The chain is read
 * first and after a failure, so a hold whose answer was lost is recorded, never funded twice.
 */

const { appendLedgerEntry } = vi.hoisted(() => ({ appendLedgerEntry: vi.fn(async () => ({})) }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e5c";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const MILESTONE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001aa";
const REQUEST = "0b6c1c9e-4a4f-4a7e-9b1e-00000000f00d";
const ESCROW = "0xE5c0000000000000000000000000000000000E5c";
const PAYEE = "0x67C8000000000000000000000000000000000504";
const USDC = "0x3600000000000000000000000000000000000000";
const NOW = new Date("2026-10-01T12:00:00Z");
const REFUND = "2026-10-31";
const REFUND_UNIX = String(Date.parse("2026-10-31T00:00:00Z") / 1000);
const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const config: VestiarionConfig = { ...base, chain: { ...base.chain, circleApiKey: "TEST_API_KEY:k:s", circleEntitySecret: "5eed".repeat(16) } };

function database(milestone: Record<string, unknown> = {}, operating: Record<string, unknown> = {}, intents: Array<Record<string, unknown>> = []) {
  let row: Record<string, unknown> = {
    id: MILESTONE, status: "pending", amount: "2", escrow_state: null,
    counterparties: { address: PAYEE, chain: "ARC-TESTNET", name: "Centronex", address_changed_at: null, address_confirmed_at: null }, ...milestone,
  };
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    const wantsObject = request.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
    if (request.path === "/rest/v1/accounts") {
      const account = { id: "acct-op", circle_wallet_id: "wallet-op", address: "0x97F85033bBD83870a841cF7153F35b387746B6b6", balance: "10", ...operating };
      return { body: wantsObject ? account : [account] };
    }
    if (request.path === "/rest/v1/payment_intents") return { body: intents };
    if (request.path === "/rest/v1/escrow_contracts") {
      const contract = { id: "esc-1", address: ESCROW };
      return { body: wantsObject ? contract : [contract] };
    }
    if (request.path === "/rest/v1/milestones") {
      if (request.method === "GET") return { body: wantsObject ? row : [row] };
      if (request.method === "PATCH") {
        // The lock's claim matches only a pending milestone with no hold, or one whose lock was interrupted.
        const claiming = (request.body as Record<string, unknown>).escrow_state === "funding";
        if (claiming && (row.status !== "pending" || (row.escrow_state !== null && row.escrow_state !== "funding"))) return { body: [] };
        row = { ...row, ...(request.body as Record<string, unknown>) };
        return { body: [{ id: MILESTONE }] };
      }
    }
    throw new Error(`unexpected request ${request.method} ${request.path}`);
  });
  const run = <T>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
  return { fake, run, milestone: () => row };
}

function circle(options: { failFund?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  const states = new Map<string, string>();
  const client = {
    createContractExecutionTransaction: vi.fn(async (input: Record<string, unknown>) => {
      calls.push(input);
      n += 1;
      states.set(`tx-${n}`, options.failFund && input.abiFunctionSignature === "fund(bytes32,address,uint256,uint64)" ? "FAILED" : "COMPLETE");
      return { data: { id: `tx-${n}` } };
    }),
    getTransaction: vi.fn(async ({ id }: { id: string }) => ({ data: { transaction: { id, state: states.get(id) ?? "COMPLETE", txHash: `0x${id.replace("tx-", "")}`.padEnd(66, "a"), blockchain: "ARC-TESTNET" } } })),
  };
  return { client: client as unknown as EscrowHoldClient, calls };
}

/** An Arc RPC answering eth_call for holds(id): the hold's state, in order of calls. */
function chain(...states: number[]) {
  const answers = [...states];
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { params: [{ to: string; data: string }] };
    expect(body.params[0].data.slice(0, 10)).toBe(HOLDS_SELECTOR);
    const state = answers.length > 1 ? answers.shift()! : answers[0];
    const words = [PAYEE.slice(2).toLowerCase().padStart(64, "0"), REFUND_UNIX && BigInt(REFUND_UNIX).toString(16).padStart(64, "0"), state.toString(16).padStart(64, "0"), (2_000_000).toString(16).padStart(64, "0")];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${words.join("")}` }), { status: 200 });
  });
}

const lock = (db: ReturnType<typeof database>, c: ReturnType<typeof circle>, rpc: ReturnType<typeof chain>, refundAfter = REFUND) =>
  db.run(() => lockMilestone({ actorId: USER, milestoneId: MILESTONE, refundAfter, requestId: REQUEST, now: NOW }, { client: () => c.client, fetch: rpc as unknown as typeof fetch, rpcUrl: "https://rpc.example" }));

beforeEach(() => appendLedgerEntry.mockClear());

describe("holdId", () => {
  it("is the milestone's id as bytes32, and the selector is holds(bytes32)'s", () => {
    expect(holdId(MILESTONE)).toBe(`0x${"0b6c1c9e4a4f4a7e9b1e0000000001aa".padEnd(64, "0")}`);
    expect(HOLDS_SELECTOR).toBe(`0x${Buffer.from(keccak_256(new TextEncoder().encode("holds(bytes32)"))).toString("hex").slice(0, 8)}`);
  });
});

describe("lockMilestone", () => {
  it("approves the escrow for the amount and funds the hold for the contractor until the refund date, then records it", async () => {
    const db = database();
    const c = circle();
    await lock(db, c, chain(0));
    expect(c.calls.map((call) => [call.walletId, call.contractAddress, call.abiFunctionSignature, call.abiParameters, call.idempotencyKey])).toEqual([
      ["wallet-op", USDC, "approve(address,uint256)", [ESCROW, "2000000"], escrowStepKey(`${ORG}/hold/${MILESTONE}/${REQUEST}/approve`)],
      ["wallet-op", ESCROW, "fund(bytes32,address,uint256,uint64)", [holdId(MILESTONE), PAYEE, "2000000", REFUND_UNIX], escrowStepKey(`${ORG}/hold/${MILESTONE}/${REQUEST}/fund`)],
    ]);
    expect(db.milestone()).toMatchObject({ escrow_state: "funded", escrow_amount: 2, escrow_refund_after: "2026-10-31T00:00:00.000Z", escrow_payee: PAYEE });
    // Claimed before anything was sent, so the agent never pays it while it is being locked (review I1).
    const claim = db.fake.requests.find((r) => r.path === "/rest/v1/milestones" && r.method === "PATCH");
    expect(claim?.body).toEqual({ escrow_state: "funding" });
    expect(String(db.milestone().escrow_fund_tx_hash)).toMatch(/^0x2a/);
    expect(appendLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "contractor",
        action: "escrow_funded",
        detail: expect.objectContaining({ by: USER, milestoneId: MILESTONE, contract: ESCROW, payee: PAYEE, amountUsdc: 2, refundAfter: "2026-10-31T00:00:00.000Z" }),
      })
    );
  });

  it("records a hold the chain already has, as the chain has it, and sends nothing: a fund whose answer was lost (review M1)", async () => {
    const db = database();
    const c = circle();
    await lock(db, c, chain(1), "2026-11-15");
    expect(c.calls).toEqual([]);
    // The chain's refund date and payee, not the form's.
    expect(db.milestone()).toMatchObject({ escrow_state: "funded", escrow_amount: 2, escrow_refund_after: "2026-10-31T00:00:00.000Z", escrow_payee: PAYEE.toLowerCase() });
  });

  it("lets go of its claim when Circle failed a step, so the milestone can be locked again or paid", async () => {
    const db = database();
    await expect(lock(db, circle({ failFund: true }), chain(0, 0))).rejects.toBeInstanceOf(EscrowHoldError);
    expect(db.milestone().escrow_state).toBeNull();
  });

  it("checks the chain after a fund Circle failed: funded means recorded, not funded means try again", async () => {
    const funded = database();
    await lock(funded, circle({ failFund: true }), chain(0, 1));
    expect(funded.milestone()).toMatchObject({ escrow_state: "funded" });

    const notFunded = database();
    await expect(lock(notFunded, circle({ failFund: true }), chain(0, 0))).rejects.toEqual(
      new EscrowHoldError("Circle did not complete the fund (FAILED). Nothing is locked; try again.", true)
    );
    expect(notFunded.milestone().escrow_state).toBeNull();
  });

  it.each([
    ["a milestone already locked", { escrow_state: "funded" }, {}, REFUND, "This milestone is already locked in escrow."],
    ["a paid milestone", { status: "paid" }, {}, REFUND, "Only a milestone not yet verified can be locked in escrow."],
    ["a verified milestone, which the agent may be paying (review I1)", { status: "verified" }, {}, REFUND, "Only a milestone not yet verified can be locked in escrow."],
    [
      "a contractor whose changed address no one has confirmed (review C1)",
      { counterparties: { address: PAYEE, chain: "ARC-TESTNET", name: "Centronex", address_changed_at: "2026-10-01T10:00:00Z", address_confirmed_at: null } },
      {},
      REFUND,
      "Centronex's address changed and no one has confirmed it. Confirm it on Counterparties before locking a milestone for it.",
    ],
    ["a contractor with no Arc testnet address", { counterparties: { address: null, chain: "ARC-TESTNET", name: "Centronex" } }, {}, REFUND, "Centronex has no Arc testnet address to lock this milestone for."],
    ["a contractor paid on another chain", { counterparties: { address: PAYEE, chain: "BASE-SEPOLIA", name: "Centronex" } }, {}, REFUND, "Escrow pays on Arc testnet; Centronex is paid on another chain."],
    ["a refund date in the past", {}, {}, "2026-09-30", "Choose a refund date after today, and within a year."],
    ["a refund date over a year away", {}, {}, "2027-12-31", "Choose a refund date after today, and within a year."],
    ["more than the operating wallet holds", {}, { balance: "1.5" }, REFUND, "The operating wallet holds 1.5 USDC, less than the 2 USDC to lock."],
  ])("refuses %s, before calling Circle", async (_what, milestone, operating, refundAfter, message) => {
    const c = circle();
    await expect(lock(database(milestone, operating), c, chain(0), refundAfter)).rejects.toEqual(new EscrowHoldError(message));
    expect(c.calls).toEqual([]);
  });
});

describe("a milestone whose payment has started", () => {
  it("is never locked in escrow: a transfer and a hold would both commit its amount (review focus 1)", async () => {
    const c = circle();
    await expect(lock(database({}, {}, [{ id: "intent-1" }]), c, chain(0))).rejects.toEqual(
      new EscrowHoldError("This milestone's payment has already started, so it cannot be locked in escrow.")
    );
    expect(c.calls).toEqual([]);
  });
});

describe("refundMilestone", () => {
  const funded = { escrow_state: "funded", escrow_amount: "2", escrow_refund_after: "2026-10-31T00:00:00Z" };
  const refund = (db: ReturnType<typeof database>, c: ReturnType<typeof circle>, rpc: ReturnType<typeof chain>, now: Date) =>
    db.run(() => refundMilestone({ actorId: USER, milestoneId: MILESTONE, requestId: REQUEST, now }, { client: () => c.client, fetch: rpc as unknown as typeof fetch, rpcUrl: "https://rpc.example" }));

  it("refunds a hold to the workspace from its refund date, under the request's key, and records it", async () => {
    const db = database(funded);
    const c = circle();
    await refund(db, c, chain(1), new Date("2026-10-31T00:00:00Z"));
    expect(c.calls.map((call) => [call.walletId, call.contractAddress, call.abiFunctionSignature, call.abiParameters, call.idempotencyKey])).toEqual([
      ["wallet-op", ESCROW, "refund(bytes32)", [holdId(MILESTONE)], escrowStepKey(`${ORG}/refund/${MILESTONE}/${REQUEST}`)],
    ]);
    expect(db.milestone()).toMatchObject({ escrow_state: "refunded" });
    expect(String(db.milestone().escrow_refund_tx_hash)).toMatch(/^0x1a/);
    expect(appendLedgerEntry).toHaveBeenCalledWith(expect.objectContaining({ domain: "contractor", action: "escrow_refunded", detail: expect.objectContaining({ by: USER, milestoneId: MILESTONE, contract: ESCROW, amountUsdc: 2 }) }));
  });

  it("refuses before the refund date, and for a milestone with no hold or a paid one, before calling Circle", async () => {
    const c = circle();
    await expect(refund(database(funded), c, chain(1), new Date("2026-10-30T23:59:59Z"))).rejects.toEqual(new EscrowHoldError("This hold can be refunded from 31 Oct 2026."));
    await expect(refund(database(), c, chain(1), new Date("2026-11-01T00:00:00Z"))).rejects.toEqual(new EscrowHoldError("This milestone has no hold in escrow to refund."));
    expect(c.calls).toEqual([]);
  });

  it("records what the chain says when the hold is no longer funded there, and sends nothing", async () => {
    const released = database(funded);
    const c = circle();
    await expect(refund(released, c, chain(2), new Date("2026-11-01T00:00:00Z"))).rejects.toEqual(new EscrowHoldError("This hold was released to the contractor."));
    expect(released.milestone()).toMatchObject({ escrow_state: "released" });
    const refunded = database(funded);
    await refund(refunded, c, chain(3), new Date("2026-11-01T00:00:00Z"));
    expect(refunded.milestone()).toMatchObject({ escrow_state: "refunded", escrow_refund_tx_hash: null });
    expect(c.calls).toEqual([]);
    // Money moved back to the workspace is in the ledger, however it was found (review I3).
    expect(appendLedgerEntry).toHaveBeenCalledWith(expect.objectContaining({ action: "escrow_refunded", detail: expect.objectContaining({ milestoneId: MILESTONE, refundTxHash: null }) }));
  });

  it("refunds a hold the chain still holds whatever the milestone's status says, from its date (review I1)", async () => {
    const db = database({ ...funded, status: "paid" });
    const c = circle();
    await refund(db, c, chain(1), new Date("2026-11-01T00:00:00Z"));
    expect(c.calls.map((call) => call.abiFunctionSignature)).toEqual(["refund(bytes32)"]);
  });
});

describe("readHold", () => {
  it("reads a hold's payee, refund date, state and amount from the contract", async () => {
    expect(await readHold(ESCROW, holdId(MILESTONE), { fetch: chain(1) as unknown as typeof fetch, rpcUrl: "https://rpc.example" })).toEqual({
      payee: PAYEE.toLowerCase(),
      refundAfter: Number(REFUND_UNIX),
      state: "funded",
      amountUnits: BigInt(2_000_000),
    });
  });
});
