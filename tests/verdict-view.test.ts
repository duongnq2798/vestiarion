import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "@/lib/ledger";
import { verdictView, type VerdictFacts } from "@/lib/verdict-view";

/**
 * What a card shows of a person's verdict on the agent's decision (docs/superpowers/specs/2026-10-07-shadow-mode-design.md
 * S3–S5): the agent's newest decision about the payable, the verdict given on it, or whether one can be given now.
 */

const INVOICE = "inv-1";
const entry = (seq: number, action: string, actor: "agent" | "human", detail: Record<string, unknown> = { invoiceId: INVOICE }, ts = "2026-10-07T10:00:00.000Z"): LedgerEntry => ({
  seq, id: `e${seq}`, ts, actor, domain: "ap", action, summary: action, detail, bodyHash: "00", signature: "00", prevHash: "00", hash: "00", signingKeyId: null,
});
const facts = (over: Partial<VerdictFacts> = {}): VerdictFacts => ({ shadow: { startedAt: "2026-10-07T00:00:00.000Z" }, given: new Map(), canGive: true, ...over });

describe("verdictView", () => {
  it("offers a verdict on the agent's newest decision about the payable, made in shadow mode", () => {
    const entries = [entry(44, "approval_paid", "human"), entry(43, "ap_reconcile", "agent"), entry(42, "ap_pay", "agent"), entry(40, "ap_schedule", "agent")];
    expect(verdictView(INVOICE, entries, facts(), true)).toEqual({ entrySeq: 42, agentAction: "ap_pay", given: null, open: true, heldForVerdict: true });
  });

  it("shows the verdict given on it, and offers no other", () => {
    const given = new Map([[42, { verdict: "disagree" as const, reason: "Paid on the due date" }]]);
    expect(verdictView(INVOICE, [entry(42, "ap_schedule", "agent")], facts({ given }), false)).toEqual({
      entrySeq: 42,
      agentAction: "ap_schedule",
      given: { verdict: "disagree", reason: "Paid on the due date" },
      open: false,
      heldForVerdict: false,
    });
  });

  it("still shows a verdict once shadow mode is off", () => {
    const given = new Map([[42, { verdict: "agree" as const, reason: null }]]);
    expect(verdictView(INVOICE, [entry(42, "ap_pay", "agent")], facts({ shadow: null, given }), false)?.given).toEqual({ verdict: "agree", reason: null });
  });

  it("offers nothing outside shadow mode, or on a decision made before it started", () => {
    expect(verdictView(INVOICE, [entry(42, "ap_pay", "agent")], facts({ shadow: null }), false)).toBeUndefined();
    expect(verdictView(INVOICE, [entry(42, "ap_pay", "agent", { invoiceId: INVOICE }, "2026-10-06T23:00:00.000Z")], facts(), false)).toBeUndefined();
    expect(verdictView(INVOICE, [entry(42, "approval_paid", "human")], facts(), false)).toBeUndefined();
    expect(verdictView(INVOICE, [entry(42, "ap_pay", "agent", { invoiceId: "inv-2" })], facts(), false)).toBeUndefined();
  });

  it("shows someone who may not decide payments that it waits, and offers them nothing", () => {
    expect(verdictView(INVOICE, [entry(42, "ap_pay", "agent")], facts({ canGive: false }), true)).toMatchObject({ given: null, open: false });
  });

  it("carries whether the workspace simulates its payments, so Agree and pay can say so", () => {
    expect(verdictView(INVOICE, [entry(42, "ap_pay", "agent")], facts({ simulated: true }), true)?.simulated).toBe(true);
    expect(verdictView(INVOICE, [entry(42, "ap_pay", "agent")], facts(), true)).not.toHaveProperty("simulated");
  });
});
