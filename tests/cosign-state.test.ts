import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { TENANT_RPCS, TENANT_TABLES } from "@/lib/dal";
import { fakeSupabase, carriesOrg, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

const { chainModes } = vi.hoisted(() => ({
  chainModes: vi.fn((): { mode: "live" | "simulate"; earnMode: "live" | "simulate" } => ({ mode: "simulate", earnMode: "simulate" })),
}));

vi.mock("server-only", () => ({}));
// Whether payments are real is the workspace's configuration: simulated unless a test says live.
vi.mock("@/lib/circle", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/circle")>()), chainModes }));

afterEach(() => {
  chainModes.mockReset();
  chainModes.mockReturnValue({ mode: "simulate", earnMode: "simulate" });
});

import { COSIGN_BLOCKED, cosignState, readCosignStates, type CosignFacts, type CosignPayable } from "@/lib/cosign-state";
import { verdictHolds } from "@/lib/verdicts";

/**
 * Whether an accountant can co-sign a bill now (docs/superpowers/specs/2026-10-22-accountant-queue-design.md AQ1): the
 * rule the accountant console and the approval card share, so neither promises a co-sign `approveAndPay` would refuse,
 * and its read of many bills at once, in the workspace in scope only.
 */

const ACCOUNTANT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const OTHER_ACCOUNTANT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a3";
const APPROVER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a2";
const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a4";

const facts = (over: Partial<CosignFacts> = {}): CosignFacts => ({
  above: 500,
  payment: { amount: 1250, currency: "USDC" },
  sent: false,
  approvals: [],
  verdict: null,
  deciding: false,
  riskLevel: "low",
  noAddress: false,
  frozen: false,
  lock: null,
  ...over,
});

describe("cosignState", () => {
  it("offers a co-sign on a bill above the figure, saying how many others approved it", () => {
    expect(cosignState(facts(), ACCOUNTANT)).toEqual({ state: "can_cosign", above: 500, approvals: 0 });
    // An approver's approval stands: the co-sign lets that same approver's Approve and pay pay it.
    expect(cosignState(facts({ approvals: [{ by: APPROVER, cosign: false }] }), ACCOUNTANT)).toEqual({ state: "can_cosign", above: 500, approvals: 1 });
  });

  it("needs none below the figure, on the figure, with no figure, or once a transfer exists", () => {
    expect(cosignState(facts({ payment: { amount: 200, currency: "USDC" } }), ACCOUNTANT)).toEqual({ state: "not_needed" });
    expect(cosignState(facts({ payment: { amount: 500, currency: "USDC" } }), ACCOUNTANT)).toEqual({ state: "not_needed" });
    expect(cosignState(facts({ above: null }), ACCOUNTANT)).toEqual({ state: "not_needed" });
    expect(cosignState(facts({ sent: true }), ACCOUNTANT)).toEqual({ state: "not_needed" });
    expect(cosignState(facts({ sent: true, approvals: [{ by: ACCOUNTANT, cosign: true }] }), ACCOUNTANT)).toEqual({ state: "not_needed" });
  });

  it("needs none once the approvals that stand pay it: two of them, or another accountant's co-sign, since accountants fill one", () => {
    expect(cosignState(facts({ approvals: [{ by: APPROVER, cosign: false }, { by: OWNER, cosign: false }] }), ACCOUNTANT)).toEqual({ state: "not_needed" });
    expect(cosignState(facts({ approvals: [{ by: OTHER_ACCOUNTANT, cosign: true }] }), ACCOUNTANT)).toEqual({ state: "not_needed" });
  });

  it("says the viewer co-signed it while their co-sign stands", () => {
    expect(cosignState(facts({ approvals: [{ by: ACCOUNTANT, cosign: true }] }), ACCOUNTANT)).toEqual({ state: "cosigned" });
    expect(cosignState(facts({ approvals: [{ by: APPROVER, cosign: false }, { by: ACCOUNTANT, cosign: true }] }), ACCOUNTANT)).toEqual({ state: "cosigned" });
    // Held for a verdict since: what they gave still stands.
    expect(cosignState(facts({ approvals: [{ by: ACCOUNTANT, cosign: true }], verdict: "waiting" }), ACCOUNTANT)).toEqual({ state: "cosigned" });
  });

  it("weighs a EURC bill at its recorded USDC value, and one with none as above the figure", () => {
    expect(cosignState(facts({ payment: { amount: 10, currency: "EURC", usdcValue: null } }), ACCOUNTANT).state).toBe("can_cosign");
    expect(cosignState(facts({ payment: { amount: 10, currency: "EURC" } }), ACCOUNTANT).state).toBe("can_cosign");
    expect(cosignState(facts({ payment: { amount: 900, currency: "EURC", usdcValue: 450 } }), ACCOUNTANT).state).toBe("not_needed");
    expect(cosignState(facts({ payment: { amount: 900, currency: "EURC", usdcValue: 1040 } }), ACCOUNTANT).state).toBe("can_cosign");
  });

  it.each([
    [{ verdict: "waiting" as const }, "Waiting for a verdict in shadow mode"],
    [{ verdict: "disagreed" as const }, "Someone disagreed with it in shadow mode"],
    [{ deciding: true }, "Being decided right now"],
    [{ riskLevel: "high" }, "Screened high risk"],
    [{ noAddress: true }, "The payee has no payment address yet"],
    [{ frozen: true }, "The payee is frozen"],
    [{ lock: "unconfirmed" as const }, "Confirm the address first"],
    [{ lock: "cooling" as const }, "Waiting for the payee lock's wait to end"],
  ])("blocks a co-sign the server would refuse: %j says %j", (over, reason) => {
    expect(cosignState(facts(over), ACCOUNTANT)).toEqual({ state: "blocked", reason });
  });

  it("names the refusal Approve and pay meets first when several apply", () => {
    expect(cosignState(facts({ verdict: "waiting", riskLevel: "high", frozen: true }), ACCOUNTANT)).toEqual({ state: "blocked", reason: COSIGN_BLOCKED.verdict });
    expect(cosignState(facts({ riskLevel: "high", frozen: true, lock: "unconfirmed" }), ACCOUNTANT)).toEqual({ state: "blocked", reason: COSIGN_BLOCKED.high_risk });
    expect(cosignState(facts({ frozen: true, lock: "unconfirmed" }), ACCOUNTANT)).toEqual({ state: "blocked", reason: COSIGN_BLOCKED.frozen });
    // A payee with no address where payments are real: after high risk, before a frozen payee or the payee lock.
    expect(cosignState(facts({ riskLevel: "high", noAddress: true }), ACCOUNTANT)).toEqual({ state: "blocked", reason: COSIGN_BLOCKED.high_risk });
    expect(cosignState(facts({ noAddress: true, frozen: true, lock: "unconfirmed" }), ACCOUNTANT)).toEqual({ state: "blocked", reason: COSIGN_BLOCKED.no_address });
  });

  it("keeps the reasons in the order approveAndPay refuses them", () => {
    expect(Object.keys(COSIGN_BLOCKED)).toEqual(["verdict", "disagreed", "deciding", "high_risk", "no_address", "frozen", "unconfirmed", "cooling"]);
  });

  it("blocks nothing a co-sign is not needed for", () => {
    expect(cosignState(facts({ payment: { amount: 200, currency: "USDC" }, riskLevel: "high", frozen: true }), ACCOUNTANT)).toEqual({ state: "not_needed" });
  });
});

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c11";
const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const SHADOW = { currency: "USD", started_at: "2026-10-20T00:00:00Z", started_by: OWNER };

const bill = (n: number, over: Partial<CosignPayable> = {}): CosignPayable => ({
  id: `11111111-2222-4333-8444-00000000000${n}`,
  amount: 1250,
  currency: "USDC",
  status: "held",
  reviewedAt: null,
  counterpartyId: `22222222-2222-4333-8444-00000000000${n}`,
  riskLevel: "low",
  address: `0xabc000000000000000000000000000000000000${n}`,
  ...over,
});

const approval = (payable: CosignPayable, by: string, over: Record<string, unknown> = {}) => ({
  source_id: payable.id,
  id: `appr-${by.slice(-2)}-${payable.id.slice(-1)}`,
  approved_by: by,
  approved_at: "2026-10-22T08:00:00.000Z",
  amount: String(payable.amount),
  currency: payable.currency,
  address: payable.address,
  ...over,
});

/** A shadow-mode decision that held the bill for a person's verdict (shadow mode S2). */
const heldForVerdict = (seq: number, invoiceId: string) => ({
  seq,
  ts: "2026-10-21T10:00:00Z",
  detail: { invoiceId, decision: { action: "pay" }, guardrailBlocked: false, execution: { resultingStatus: "held", heldBecause: "shadow_verdict" } },
});

type World = {
  above?: number | null;
  lock?: { on: boolean; hours?: number };
  intents?: unknown[];
  approvals?: unknown[];
  /** Of the givers of an approval, the owners, admins and approvers; null answers as before migration 0138. */
  deciders?: string[] | null;
  frozen?: string[];
  counterparties?: unknown[];
  banked?: string[];
  shadow?: boolean;
  decisions?: unknown[];
  verdicts?: unknown[];
  ledger?: unknown[];
  policyFails?: boolean;
};

function world(over: World = {}) {
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/approval_policies") {
      if (over.policyFails) return { status: 500, body: { message: "down" } };
      return { body: over.above === null ? [] : [{ two_approvals_above: String(over.above ?? 500), payee_lock: over.lock?.on ?? false, payee_lock_cooling_hours: over.lock?.hours ?? 0 }] };
    }
    if (r.path === "/rest/v1/payment_intents") return { body: over.intents ?? [] };
    if (r.path === "/rest/v1/payment_approvals") return { body: over.approvals ?? [] };
    if (r.path === "/rest/v1/rpc/approvers_among") return { body: (r.body as { p_users: string[] }).p_users };
    if (r.path === "/rest/v1/rpc/approvers_besides") return { body: 2 };
    if (r.path === "/rest/v1/rpc/cosigners_besides") return { body: 1 };
    if (r.path === "/rest/v1/rpc/deciders_among") {
      if (over.deciders === null) return { status: 404, body: { code: "PGRST202", message: "function not found" } };
      const deciders = over.deciders ?? [APPROVER, OWNER];
      return { body: (r.body as { p_users: string[] }).p_users.filter((user) => deciders.includes(user)) };
    }
    if (r.path === "/rest/v1/rpc/ledger_entries_for_targets") return { body: over.ledger ?? [] };
    if (r.path === "/rest/v1/counterparties" && r.params.get("frozen_at")) return { body: (over.frozen ?? []).map((id) => ({ id })) };
    if (r.path === "/rest/v1/counterparties") return { body: over.counterparties ?? [] };
    if (r.path === "/rest/v1/counterparty_bank_accounts") {
      return {
        body: (over.banked ?? []).map((id) => ({ id: `bank-${id}`, counterparty_id: id, external_id: "ba_1", bank_code: "002", last4: "1234", beneficiary_name: "Payee", status: "approved", added_at: "2026-10-01T00:00:00Z" })),
      };
    }
    if (r.path === "/rest/v1/shadow_modes") return { body: over.shadow ? [SHADOW] : [] };
    if (r.path === "/rest/v1/ledger_entries") return { body: over.decisions ?? [] };
    if (r.path === "/rest/v1/decision_verdicts") return { body: over.verdicts ?? [] };
    return { body: [] };
  };
}

function reading(over: World = {}) {
  const fake = fakeSupabase(world(over));
  const read = (payables: CosignPayable[], viewer = ACCOUNTANT) =>
    runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: viewer }), () => readCosignStates(viewer, payables, NOW));
  return { fake, read };
}

const stateOf = (states: Map<string, unknown>, payable: CosignPayable) => states.get(payable.id);

describe("readCosignStates", () => {
  it("reads the figure and nothing more when two approvals are off", async () => {
    const { fake, read } = reading({ above: null });
    const states = await read([bill(1), bill(2)]);
    expect([...states.values()]).toEqual([{ state: "not_needed" }, { state: "not_needed" }]);
    expect(fake.requests.map((r) => r.path)).toEqual(["/rest/v1/approval_policies"]);
  });

  it("offers a bill above the figure, not one below it or one already sent, reading only in the workspace, never as the platform", async () => {
    const big = bill(1);
    const small = bill(2, { amount: 200 });
    const sent = bill(3);
    const { fake, read } = reading({ intents: [{ source_id: sent.id, status: "confirmed", provider_tx_id: "tx-1", last_error: null, provider_state: "COMPLETE" }] });
    const states = await read([big, small, sent]);
    expect(stateOf(states, big)).toEqual({ state: "can_cosign", above: 500, approvals: 0 });
    expect(stateOf(states, small)).toEqual({ state: "not_needed" });
    expect(stateOf(states, sent)).toEqual({ state: "not_needed" });

    for (const sent of fake.requests) {
      const name = sent.path.replace("/rest/v1/rpc/", "").replace("/rest/v1/", "");
      // Tenant tables and tenant functions only: nothing a service-role read could reach.
      const tenant = sent.path.startsWith("/rest/v1/rpc/") ? (TENANT_RPCS as readonly string[]).includes(name) : (TENANT_TABLES as readonly string[]).includes(name);
      expect(tenant, sent.path).toBe(true);
      expect(carriesOrg(sent, ORG), sent.path).toBe(true);
    }
    // Never a quote, a balance or Circle.
    expect(fake.requests.some((r) => /quote|balance|wallet/i.test(r.path))).toBe(false);
  });

  it("needs no co-sign where another accountant's co-sign stands, and offers one beside an approver's approval", async () => {
    const cosigned = bill(1);
    const approved = bill(2);
    const { fake, read } = reading({ approvals: [approval(cosigned, OTHER_ACCOUNTANT), approval(approved, APPROVER)] });
    const states = await read([cosigned, approved]);
    expect(stateOf(states, cosigned)).toEqual({ state: "not_needed" });
    expect(stateOf(states, approved)).toEqual({ state: "can_cosign", above: 500, approvals: 1 });
    // Which giver is an accountant is asked once, for both, of the workspace's own function.
    const asked = fake.requests.filter((r) => r.path === "/rest/v1/rpc/deciders_among");
    expect(asked).toHaveLength(1);
    expect(asked[0].body).toEqual({ p_users: [OTHER_ACCOUNTANT, APPROVER], p_org_id: ORG });
  });

  it("says the viewer co-signed it, and needs none once two approvals stand", async () => {
    const mine = bill(1);
    const two = bill(2);
    const { read } = reading({ approvals: [approval(mine, ACCOUNTANT), approval(two, APPROVER), approval(two, OWNER)] });
    const states = await read([mine, two]);
    expect(stateOf(states, mine)).toEqual({ state: "cosigned" });
    expect(stateOf(states, two)).toEqual({ state: "not_needed" });
  });

  it("counts an approval only while it agrees with the bill as it stands", async () => {
    const changed = bill(1);
    const { read } = reading({ approvals: [approval(changed, ACCOUNTANT, { amount: "1000" })] });
    expect(stateOf(await read([changed]), changed)).toEqual({ state: "can_cosign", above: 500, approvals: 0 });
  });

  it("before migration 0138 knows no co-sign, so a lone approval is a decider's", async () => {
    const approved = bill(1);
    const { read } = reading({ approvals: [approval(approved, OTHER_ACCOUNTANT)], deciders: null });
    expect(stateOf(await read([approved]), approved)).toEqual({ state: "can_cosign", above: 500, approvals: 1 });
  });

  it("blocks a frozen payee, and under the payee lock an address to confirm and one still in its wait, but not a payee paid to its bank", async () => {
    const frozen = bill(1);
    const unconfirmed = bill(2);
    const cooling = bill(3);
    const banked = bill(4);
    const clear = bill(5);
    const { fake, read } = reading({
      lock: { on: true, hours: 4 },
      frozen: [frozen.counterpartyId],
      banked: [banked.counterpartyId],
      counterparties: [
        { id: unconfirmed.counterpartyId, address_changed_at: "2026-10-22T09:00:00Z", address_confirmed_at: null },
        { id: cooling.counterpartyId, address_changed_at: "2026-10-22T10:00:00Z", address_confirmed_at: "2026-10-22T10:30:00Z" },
        { id: clear.counterpartyId, address_changed_at: "2026-10-01T10:00:00Z", address_confirmed_at: "2026-10-01T10:30:00Z" },
      ],
    });
    const states = await read([frozen, unconfirmed, cooling, banked, clear]);
    expect(stateOf(states, frozen)).toEqual({ state: "blocked", reason: "The payee is frozen" });
    expect(stateOf(states, unconfirmed)).toEqual({ state: "blocked", reason: "Confirm the address first" });
    expect(stateOf(states, cooling)).toEqual({ state: "blocked", reason: "Waiting for the payee lock's wait to end" });
    expect(stateOf(states, banked)).toEqual({ state: "can_cosign", above: 500, approvals: 0 });
    expect(stateOf(states, clear)).toEqual({ state: "can_cosign", above: 500, approvals: 0 });
    // The payees' address state in one request, not one per bill; the payee paid to its bank is not asked about.
    const addressReads = fake.requests.filter((r) => r.path === "/rest/v1/counterparties" && !r.params.get("frozen_at"));
    expect(addressReads).toHaveLength(1);
    expect(addressReads[0].params.get("id")).not.toContain(banked.counterpartyId);
  });

  it("reads no address state while the payee lock is off", async () => {
    const { fake, read } = reading({ counterparties: [{ id: bill(1).counterpartyId, address_changed_at: "2026-10-22T09:00:00Z", address_confirmed_at: null }] });
    expect(stateOf(await read([bill(1)]), bill(1))).toEqual({ state: "can_cosign", above: 500, approvals: 0 });
    expect(fake.requests.some((r) => r.path === "/rest/v1/counterparties" && !r.params.get("frozen_at"))).toBe(false);
    expect(fake.requests.some((r) => r.path === "/rest/v1/counterparty_bank_accounts")).toBe(false);

    // Nor a bank account where payments are real, while every payee has an address.
    chainModes.mockReturnValue({ mode: "live", earnMode: "simulate" });
    const live = reading();
    expect(stateOf(await live.read([bill(1)]), bill(1))).toEqual({ state: "can_cosign", above: 500, approvals: 0 });
    expect(live.fake.requests.some((r) => r.path === "/rest/v1/counterparty_bank_accounts")).toBe(false);
  });

  it("blocks a payee with no address where payments are real, as Approve and pay refuses it, unless it is paid to its bank", async () => {
    chainModes.mockReturnValue({ mode: "live", earnMode: "simulate" });
    const bare = bill(1, { address: null });
    const banked = bill(2, { address: null });
    const withAddress = bill(3);
    const { fake, read } = reading({ banked: [banked.counterpartyId] });
    const states = await read([bare, banked, withAddress]);
    expect(stateOf(states, bare)).toEqual({ state: "blocked", reason: "The payee has no payment address yet" });
    expect(stateOf(states, banked)).toEqual({ state: "can_cosign", above: 500, approvals: 0 });
    expect(stateOf(states, withAddress)).toEqual({ state: "can_cosign", above: 500, approvals: 0 });
    // The payees' bank accounts in one request; with the lock off, no address state.
    expect(fake.requests.filter((r) => r.path === "/rest/v1/counterparty_bank_accounts")).toHaveLength(1);
    expect(fake.requests.some((r) => r.path === "/rest/v1/counterparties" && !r.params.get("frozen_at"))).toBe(false);
  });

  it("takes no missing address against a co-sign where payments are simulated", async () => {
    const bare = bill(1, { address: null });
    const { fake, read } = reading();
    expect(stateOf(await read([bare]), bare)).toEqual({ state: "can_cosign", above: 500, approvals: 0 });
    expect(fake.requests.some((r) => r.path === "/rest/v1/counterparty_bank_accounts")).toBe(false);
  });

  it("names a verdict first where high risk or a claim in progress would refuse it too, and reads no payee for bills already blocked", async () => {
    const risky = bill(1, { riskLevel: "high" });
    const claimed = bill(2, { status: "processing", reviewedAt: "2026-10-22T11:58:00.000Z" });
    const { fake, read } = reading({
      shadow: true,
      decisions: [heldForVerdict(52, claimed.id), heldForVerdict(51, risky.id)],
      verdicts: [{ entry_seq: 52, verdict: "disagree" }],
    });
    const states = await read([risky, claimed]);
    expect(stateOf(states, risky)).toEqual({ state: "blocked", reason: "Waiting for a verdict in shadow mode" });
    expect(stateOf(states, claimed)).toEqual({ state: "blocked", reason: "Someone disagreed with it in shadow mode" });
    // Both were blocked before a payee could matter: no frozen payee, address state or bank account is read.
    expect(fake.requests.some((r) => r.path === "/rest/v1/counterparties")).toBe(false);
    expect(fake.requests.some((r) => r.path === "/rest/v1/counterparty_bank_accounts")).toBe(false);
  });

  it("blocks a bill held for a shadow-mode verdict, or one someone disagreed with, and one being decided right now", async () => {
    const waiting = bill(1);
    const disagreed = bill(2);
    const agreed = bill(3);
    const deciding = bill(4, { status: "processing", reviewedAt: "2026-10-22T11:58:00.000Z" });
    const unfinished = bill(5, { status: "processing", reviewedAt: "2026-10-22T10:00:00.000Z" });
    const { read } = reading({
      shadow: true,
      decisions: [heldForVerdict(43, agreed.id), heldForVerdict(42, disagreed.id), heldForVerdict(41, waiting.id)],
      verdicts: [
        { entry_seq: 42, verdict: "disagree" },
        { entry_seq: 43, verdict: "agree" },
      ],
    });
    const states = await read([waiting, disagreed, agreed, deciding, unfinished]);
    expect(stateOf(states, waiting)).toEqual({ state: "blocked", reason: "Waiting for a verdict in shadow mode" });
    expect(stateOf(states, disagreed)).toEqual({ state: "blocked", reason: "Someone disagreed with it in shadow mode" });
    expect(stateOf(states, agreed)).toEqual({ state: "can_cosign", above: 500, approvals: 0 });
    expect(stateOf(states, deciding)).toEqual({ state: "blocked", reason: "Being decided right now" });
    // A claim that did not finish may be retaken: nothing blocks it.
    expect(stateOf(states, unfinished)).toEqual({ state: "can_cosign", above: 500, approvals: 0 });
  });

  it("weighs a EURC bill at the USDC value its latest decision recorded, and one with none as above", async () => {
    const recordedBelow = bill(1, { currency: "EURC", amount: 900 });
    const unknown = bill(2, { currency: "EURC", amount: 100 });
    const { fake, read } = reading({
      ledger: [{ seq: 9, id: "e9", ts: "2026-10-21T10:00:00Z", actor: "agent", domain: "ap", action: "ap_hold", summary: "", detail: { invoiceId: recordedBelow.id, observed: {}, usdcValue: 450 }, body_hash: "", signature: "", prev_hash: null, hash: "" }],
    });
    const states = await read([recordedBelow, unknown, bill(3)]);
    expect(stateOf(states, recordedBelow)).toEqual({ state: "not_needed" });
    expect(stateOf(states, unknown)).toEqual({ state: "can_cosign", above: 500, approvals: 0 });
    // The ledger is asked about the EURC bills only.
    const asked = fake.requests.find((r) => r.path === "/rest/v1/rpc/ledger_entries_for_targets");
    expect((asked?.body as { p_invoice_ids: string[] }).p_invoice_ids).toEqual([recordedBelow.id, unknown.id]);
  });

  it("throws when the figure cannot be read, for the caller to name", async () => {
    const { read } = reading({ policyFails: true });
    await expect(read([bill(1)])).rejects.toThrow(/approval_policies not read/);
  });
});

describe("verdictHolds", () => {
  it("lists the bills waiting for a verdict apart from those someone disagreed with, in two reads", async () => {
    const fake = fakeSupabase(
      world({
        shadow: true,
        decisions: [heldForVerdict(42, bill(2).id), heldForVerdict(41, bill(1).id)],
        verdicts: [{ entry_seq: "42", verdict: "disagree" }],
      })
    );
    const holds = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => verdictHolds([bill(1).id, bill(2).id]));
    expect([...holds.waiting]).toEqual([bill(1).id]);
    expect([...holds.disagreed]).toEqual([bill(2).id]);
    expect(fake.requests.find((r) => r.path === "/rest/v1/decision_verdicts")?.params.get("select")).toBe("entry_seq,verdict");
  });

  it("holds nothing outside shadow mode", async () => {
    const fake = fakeSupabase(world({ shadow: false, decisions: [heldForVerdict(41, bill(1).id)] }));
    const holds = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => verdictHolds([bill(1).id]));
    expect(holds.waiting.size + holds.disagreed.size).toBe(0);
    expect(fake.requests.map((r) => r.path)).toEqual(["/rest/v1/shadow_modes"]);
  });
});
