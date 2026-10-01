import { beforeEach, describe, expect, it, vi } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import { escrowStepKey } from "@/lib/circle/escrow-setup";
import { EscrowHoldError, HOLDS_SELECTOR, holdId, lockMilestone, readHold, type EscrowHoldClient } from "@/lib/circle/escrow-holds";
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

function database(milestone: Record<string, unknown> = {}, operating: Record<string, unknown> = {}) {
  let row: Record<string, unknown> = {
    id: MILESTONE, status: "pending", amount: "2", escrow_state: null,
    counterparties: { address: PAYEE, chain: "ARC-TESTNET", name: "Centronex" }, ...milestone,
  };
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    const wantsObject = request.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
    if (request.path === "/rest/v1/accounts") {
      const account = { id: "acct-op", circle_wallet_id: "wallet-op", address: "0x97F85033bBD83870a841cF7153F35b387746B6b6", balance: "10", ...operating };
      return { body: wantsObject ? account : [account] };
    }
    if (request.path === "/rest/v1/escrow_contracts") {
      const contract = { id: "esc-1", address: ESCROW };
      return { body: wantsObject ? contract : [contract] };
    }
    if (request.path === "/rest/v1/milestones") {
      if (request.method === "GET") return { body: wantsObject ? row : [row] };
      if (request.method === "PATCH") {
        row = { ...row, ...(request.body as Record<string, unknown>) };
        return { body: [] };
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
    expect(db.milestone()).toMatchObject({ escrow_state: "funded", escrow_amount: 2, escrow_refund_after: "2026-10-31T00:00:00.000Z" });
    expect(String(db.milestone().escrow_fund_tx_hash)).toMatch(/^0x2a/);
    expect(appendLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "contractor",
        action: "escrow_funded",
        detail: expect.objectContaining({ by: USER, milestoneId: MILESTONE, contract: ESCROW, payee: PAYEE, amountUsdc: 2, refundAfter: "2026-10-31T00:00:00.000Z" }),
      })
    );
  });

  it("records a hold the chain already has, and sends nothing: a fund whose answer was lost", async () => {
    const db = database();
    const c = circle();
    await lock(db, c, chain(1));
    expect(c.calls).toEqual([]);
    expect(db.milestone()).toMatchObject({ escrow_state: "funded", escrow_amount: 2 });
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
    ["a paid milestone", { status: "paid" }, {}, REFUND, "Only a milestone that is not paid yet can be locked in escrow."],
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
