import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { giveVerdict, readShadowSummary, readVerdicts, VerdictError, verdictFacts } from "@/lib/verdicts";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * A person's verdict on each decision of the agent's in shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-design.md
 * S3–S5): one per decision entry, only on the agent's decisions about a payable since shadow mode started, a reason for
 * every disagreement. Agreeing to a payment held for it pays it; disagreeing returns or rejects it when asked.
 */

const { ledgerMock } = vi.hoisted(() => ({ ledgerMock: vi.fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f0f";
const PERSON = "a1b2c3d4-0000-4000-8000-0000000000f1";
const INVOICE = "018f8ce0-1557-7b54-a931-4d777f6bf001";
const SHADOW = { currency: "VND", started_at: "2026-10-07T00:00:00Z", started_by: PERSON };

type Entry = { seq: number; ts: string; actor: string; action: string; summary: string; detail: Record<string, unknown> };
const decision = (seq: number, over: Partial<Entry> & { held?: boolean } = {}): Entry => ({
  seq,
  ts: "2026-10-07T10:00:00Z",
  actor: "agent",
  action: "ap_pay",
  summary: "Held Northwind 300 USDC for a person to agree",
  detail: {
    invoiceId: INVOICE,
    decision: { action: "pay", reasoning: "Matched and within the limit; paying now." },
    guardrailBlocked: false,
    execution: over.held === false ? { resultingStatus: "paid" } : { resultingStatus: "held", heldBecause: "shadow_verdict" },
  },
  ...over,
});

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: PERSON }), fn);

function workspace(over: { shadow?: boolean; entries?: Entry[]; verdicts?: unknown[]; insert?: FakeReply; invoice?: { status: string } } = {}) {
  const entries = over.entries ?? [decision(41)];
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/shadow_modes") return { body: over.shadow === false ? [] : [SHADOW] };
    if (r.path === "/rest/v1/ledger_entries" && r.method === "GET") {
      const seq = r.params.get("seq")?.replace(/^eq\./, "");
      if (seq) return { body: entries.filter((entry) => String(entry.seq) === seq) };
      return { body: [...entries].sort((a, b) => b.seq - a.seq) };
    }
    if (r.path === "/rest/v1/decision_verdicts" && r.method === "POST") return over.insert ?? { status: 201, body: null };
    if (r.path === "/rest/v1/decision_verdicts" && r.method === "GET") return { body: over.verdicts ?? [] };
    if (r.path === "/rest/v1/invoices") return { body: [over.invoice ?? { status: "held" }] };
    return { body: [] };
  };
}

const actions = () => ({
  approve: vi.fn(async () => ({ ok: true, message: "Paid." })),
  reject: vi.fn(async () => ({ ok: true, message: "Rejected." })),
  returnToAgent: vi.fn(async () => ({ ok: true, message: "Returned to the agent." })),
});
const inserted = () => fake.requests.filter((r) => r.path === "/rest/v1/decision_verdicts" && r.method === "POST");

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
});

describe("giveVerdict", () => {
  it("records an agreement once, as a row and a signed entry", async () => {
    fake = fakeSupabase(workspace());
    const result = await run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "agree" }, actions()));
    expect(result).toEqual({ given: { verdict: "agree", reason: null }, already: false, recorded: true });
    expect(inserted()[0].body).toMatchObject({ entry_seq: 41, subject: "invoice", subject_id: INVOICE, agent_action: "ap_pay", verdict: "agree", reason: null, decided_by: PERSON });
    expect(ledgerMock).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        actor: "human",
        domain: "ap",
        action: "decision_verdict",
        detail: { by: PERSON, entrySeq: 41, subject: "invoice", subjectId: INVOICE, agentAction: "ap_pay", verdict: "agree", reason: null },
      })
    );
  });

  it("answers a second verdict on the same decision with the one given, and does nothing else", async () => {
    const acts = actions();
    fake = fakeSupabase(
      workspace({ insert: { status: 409, body: { code: "23505", message: "duplicate key" } }, verdicts: [{ entry_seq: 41, verdict: "disagree", reason: "Paid on the due date", decided_by: PERSON, decided_at: "2026-10-07T11:00:00Z" }] })
    );
    const result = await run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "agree", then: "pay" }, acts));
    expect(result).toEqual({ given: { verdict: "disagree", reason: "Paid on the due date" }, already: true, recorded: false });
    expect(acts.approve).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("needs a reason to disagree, of at most 280 characters", async () => {
    fake = fakeSupabase(workspace());
    await expect(run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "disagree", reason: "  " }, actions()))).rejects.toMatchObject({ code: "reason_required" });
    await expect(run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "disagree", reason: "x".repeat(281) }, actions()))).rejects.toMatchObject({ code: "reason_too_long" });
    await expect(run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "agree", reason: "x".repeat(281) }, actions()))).rejects.toMatchObject({ code: "reason_too_long" });
    expect(inserted()).toHaveLength(0);
  });

  it("is only for a workspace in shadow mode", async () => {
    fake = fakeSupabase(workspace({ shadow: false }));
    await expect(run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "agree" }, actions()))).rejects.toMatchObject({ code: "not_in_shadow" });
  });

  it("is only for a decision of the agent's about a payable, since shadow mode started", async () => {
    const refused: Entry[] = [
      decision(41, { actor: "human", action: "approval_paid" }),
      decision(41, { action: "ap_reconcile" }),
      decision(41, { detail: { milestoneId: "m-1" } }),
    ];
    for (const entry of refused) {
      fake = fakeSupabase(workspace({ entries: [entry] }));
      await expect(run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "agree" }, actions()))).rejects.toMatchObject({ code: "not_a_decision" });
    }
    fake = fakeSupabase(workspace({ entries: [] }));
    await expect(run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "agree" }, actions()))).rejects.toMatchObject({ code: "not_a_decision" });
    fake = fakeSupabase(workspace({ entries: [decision(41, { ts: "2026-10-06T23:59:59Z" })] }));
    await expect(run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "agree" }, actions()))).rejects.toMatchObject({ code: "before_shadow" });
    expect(inserted()).toHaveLength(0);
  });

  it("pays a payment held for this verdict once the person agrees, to the address the card showed, then records the agreement", async () => {
    const acts = actions();
    acts.approve.mockImplementation(async () => {
      // Paid first: an agreement whose payment is refused is not kept (shadow mode review I2).
      expect(inserted()).toHaveLength(0);
      return { ok: true, message: "Paid." };
    });
    fake = fakeSupabase(workspace());
    const result = await run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "agree", then: "pay", shownAddress: "0xA11CE" }, acts));
    expect(acts.approve).toHaveBeenCalledWith(INVOICE, "0xA11CE");
    expect(result).toEqual({ given: { verdict: "agree", reason: null }, already: false, recorded: true, after: { ok: true, message: "Paid." } });
    expect(inserted()).toHaveLength(1);
  });

  it("records nothing when the payment is refused, so it can be agreed to and paid again", async () => {
    const acts = actions();
    acts.approve.mockResolvedValue({ ok: false, message: "The payee's address changed since this card was shown. Reload and check it." });
    fake = fakeSupabase(workspace());
    const result = await run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "agree", then: "pay", shownAddress: "0xOLD" }, acts));
    expect(result).toEqual({
      given: { verdict: "agree", reason: null },
      already: false,
      recorded: false,
      after: { ok: false, message: "The payee's address changed since this card was shown. Reload and check it." },
    });
    expect(inserted()).toHaveLength(0);
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("records the agreement and pays nothing when the payment is no longer held for it", async () => {
    for (const world of [
      workspace({ invoice: { status: "paid" } }),
      workspace({ entries: [decision(41, { held: false })] }),
      workspace({ entries: [decision(41), decision(57)] }),
    ]) {
      const acts = actions();
      fake = fakeSupabase(world);
      const result = await run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "agree", then: "pay" }, acts));
      expect(acts.approve).not.toHaveBeenCalled();
      expect(result.after).toEqual({ ok: false, message: "It no longer waits for your verdict, so nothing was paid." });
      expect(inserted()).toHaveLength(1);
    }
  });

  it("returns or rejects the payable when the person disagrees and asks for it, with their reason", async () => {
    const back = actions();
    fake = fakeSupabase(workspace());
    await run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "disagree", reason: "We pay it on its due date", then: "return" }, back));
    expect(back.returnToAgent).toHaveBeenCalledWith(INVOICE);
    expect(inserted()).toHaveLength(1);

    const no = actions();
    fake = fakeSupabase(workspace());
    await run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "disagree", reason: "The bill is wrong", then: "reject" }, no));
    expect(no.reject).toHaveBeenCalledWith(INVOICE, "The bill is wrong");
  });

  it("pays through an agreement a payment whose earlier Agree and pay did not finish, but not one someone is paying now (review minor 3)", async () => {
    fake = fakeSupabase(workspace({ invoice: { status: "processing", reviewed_at: "2026-10-07T10:05:00Z" } as { status: string } }));
    const unfinished = actions();
    const result = await run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "agree", then: "pay" }, unfinished));
    expect(unfinished.approve).toHaveBeenCalledTimes(1);
    expect(result.recorded).toBe(true);

    fake = fakeSupabase(workspace({ invoice: { status: "processing", reviewed_at: new Date().toISOString() } as { status: string } }));
    const deciding = actions();
    const now = await run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "agree", then: "pay" }, deciding));
    expect(deciding.approve).not.toHaveBeenCalled();
    expect(now.after).toEqual({ ok: false, message: "It no longer waits for your verdict, so nothing was paid." });
  });

  it("records a disagreement and leaves the payable as it is when it no longer waits for that verdict (shadow mode review M2)", async () => {
    const acts = actions();
    fake = fakeSupabase(workspace({ entries: [decision(41), decision(57)] }));
    const result = await run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "disagree", reason: "The bill is wrong", then: "reject" }, acts));
    expect(acts.reject).not.toHaveBeenCalled();
    expect(result.after).toEqual({ ok: false, message: "It no longer waits for your verdict, so it was left as it is." });
    expect(result.recorded).toBe(true);
    expect(inserted()).toHaveLength(1);
  });

  it("pays only on an agreement, and returns or rejects only on a disagreement", async () => {
    fake = fakeSupabase(workspace());
    await expect(run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "disagree", reason: "No", then: "pay" }, actions()))).rejects.toMatchObject({ code: "pay_needs_agreement" });
    await expect(run(() => giveVerdict({ actorId: PERSON, entrySeq: 41, verdict: "agree", then: "reject" }, actions()))).rejects.toMatchObject({ code: "settle_needs_disagreement" });
    expect(inserted()).toHaveLength(0);
  });

  it("says each refusal in words a person reads", () => {
    expect(new VerdictError("reason_required").message).toBe("Say why you disagree, in a few words.");
  });
});

describe("readVerdicts and readShadowSummary", () => {
  it("reads the verdicts on the decisions named", async () => {
    fake = fakeSupabase(workspace({ verdicts: [{ entry_seq: "41", verdict: "agree", reason: null, decided_by: PERSON, decided_at: "2026-10-07T11:00:00Z" }] }));
    const verdicts = await run(() => readVerdicts(db(), [41, 57]));
    expect(verdicts.get(41)).toEqual({ verdict: "agree", reason: null, by: PERSON, at: "2026-10-07T11:00:00Z" });
    expect(verdicts.has(57)).toBe(false);
  });

  it("counts agreements and disagreements, and each payable whose newest decision waits for a verdict", async () => {
    const OTHER = "018f8ce0-1557-7b54-a931-4d777f6bf002";
    const THIRD = "018f8ce0-1557-7b54-a931-4d777f6bf003";
    fake = fakeSupabase(
      workspace({
        entries: [
          decision(41),
          decision(45, { action: "ap_schedule", detail: { invoiceId: OTHER, decision: { action: "schedule" } } }),
          decision(50, { detail: { invoiceId: OTHER, decision: { action: "pay" }, execution: { heldBecause: "shadow_verdict" } } }),
          decision(52, { detail: { invoiceId: THIRD, decision: { action: "hold" } }, action: "ap_hold" }),
        ],
        verdicts: [
          { entry_seq: 41, verdict: "agree", reason: null, decided_by: PERSON, decided_at: "2026-10-07T11:00:00Z" },
          { entry_seq: 45, verdict: "disagree", reason: "Pay it now", decided_by: PERSON, decided_at: "2026-10-07T11:00:00Z" },
        ],
      })
    );
    const summary = await run(() => readShadowSummary(db(), { currency: "VND", startedAt: "2026-10-07T00:00:00Z", startedBy: PERSON }));
    // Northwind's decision has its verdict; the other payable's newest decision (50) and the third's (52) wait.
    expect(summary).toEqual({ agreed: 1, disagreed: 1, waiting: 2 });
  });
});

describe("verdictFacts", () => {
  const ledgerEntry = (seq: number, actor: "agent" | "human", action: string) =>
    ({ seq, id: `e${seq}`, ts: "2026-10-07T10:00:00Z", actor, domain: "ap", action, summary: action, detail: { invoiceId: INVOICE }, bodyHash: "00", signature: "00", prevHash: "00", hash: "00", signingKeyId: null }) as const;

  it("reads shadow mode and the verdicts on the agent's decisions shown, for the cards", async () => {
    fake = fakeSupabase(workspace({ verdicts: [{ entry_seq: 41, verdict: "agree", reason: null, decided_by: PERSON, decided_at: "2026-10-07T11:00:00Z" }] }));
    const facts = await run(() => verdictFacts(db(), [ledgerEntry(44, "human", "approval_paid"), ledgerEntry(41, "agent", "ap_pay")], true));
    expect(facts.shadow).toEqual({ startedAt: "2026-10-07T00:00:00Z", currency: "VND" });
    expect(facts.given.get(41)).toEqual({ verdict: "agree", reason: null });
    expect(facts.canGive).toBe(true);
    // No Circle account of its own: its payments, a verdict's included, are simulated, and Agree and pay says so.
    expect(facts.simulated).toBe(true);
    const asked = fake.requests.find((r) => r.path === "/rest/v1/decision_verdicts" && r.method === "GET");
    expect(asked?.params.get("entry_seq")).toBe("in.(41)");
  });

  it("shows no verdict at all when they cannot be read, rather than offering one twice", async () => {
    fake = fakeSupabase((r) => (r.path === "/rest/v1/shadow_modes" ? { status: 500, body: { message: "boom" } } : { body: [] }));
    const facts = await run(() => verdictFacts(db(), [ledgerEntry(41, "agent", "ap_pay")], true));
    expect(facts).toEqual({ shadow: null, given: new Map(), canGive: false });
  });
});
