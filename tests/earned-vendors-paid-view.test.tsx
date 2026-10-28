import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { billNextStep } from "@/components/vx/bill-next-step";
import { earnedPaidWhy, stoppedWhy } from "@/components/vx/decision-signals";
import { invoiceDecision } from "@/components/vx/map";
import type { Decision } from "@/components/vx/types";
import { statusRows, type PageStatus, type PlatformStatus } from "@/components/vx/workspace-status";
import { autonomyLadder } from "@/lib/autonomy-ladder";
import { capabilityOf, paymentSentence } from "@/lib/capability";
import { earnedVendors, type EarnedFacts, type EarnedVendorsView } from "@/lib/earned-vendors";
import type { LedgerEntry } from "@/lib/ledger";
import type { InvoiceRow } from "@/lib/queries";
import { buildReport, type ReadinessStep, type ReportFacts } from "@/lib/workspace-report";

/**
 * Where people read that the agent paid an earned vendor on its own in shadow mode
 * (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL22, AL27-AL29): the bill's row says so and asks for the
 * verdict after; the report's Earned vendors says what the switch does and how many payments wait, and the ladder points
 * to it once a rule is set; the shadow mode sentences in Settings and the workspace status name the exception while the
 * switch is on, and only then; and the report counts a payment made on the agent's own decision as the agent's, even
 * after a person agreed with it.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/actions/live-slice", () => ({ startLiveSliceAction: vi.fn() }));
vi.mock("@/app/actions/shadow-mode", () => ({ setShadowModeAction: vi.fn() }));

const { ReportReadiness } = await import("@/components/vx/WorkspaceReport");
const { default: ShadowModePanel } = await import("@/components/ShadowModePanel");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const entry = (seq: number, action: string, detail: Record<string, unknown>): LedgerEntry => ({
  seq, id: `e${seq}`, ts: "2026-10-28T09:00:00.000Z", actor: "agent", domain: "ap", action, summary: action, detail,
  bodyHash: "00", signature: "00", prevHash: "00", hash: "00", signingKeyId: null,
});

function invoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "inv-1", direction: "payable", counterparty_id: "cp-1", counterparty_name: "Northwind Packaging", amount: 400, memo: "Packaging", po_reference: "PO-9",
    goods_received: true, due_date: "2026-10-30T12:00:00.000Z", status: "paid", agent_reasoning: "Matched and due today.", tx_ref: "0xabc", scheduled_for: null,
    early_pay_discount_pct: null, discount_due_date: null, paid_amount: 400, ...overrides,
  };
}

/** The agent's `ap_pay` on the bill, carried out on its own for an earned vendor, or held for a verdict. */
const onItsOwn = entry(41, "ap_pay", {
  invoiceId: "inv-1",
  shadow: true,
  earned: { recordSeq: 7000, streak: 5, agreed: 6 },
  decision: { action: "pay", reasoning: "Matched and due today.", confidence: 0.9 },
  observed: { amount: 400, riskLevel: "clear" },
  guardrailBlocked: false,
  guardrailRule: null,
  execution: { resultingStatus: "paid" },
});

const verdicts = { shadow: { startedAt: "2026-10-01T00:00:00.000Z" }, given: new Map(), canGive: true };

describe("a bill the agent paid on its own (AL22, AL27)", () => {
  it("is marked earned on its card, says so on its row, and asks for the verdict after", () => {
    const decision = invoiceDecision(invoice(), undefined, [onItsOwn], { network: "arc-testnet", verdicts });
    expect(decision.earned).toBe(true);
    expect(decision.heldForVerdict).toBeUndefined();
    expect(earnedPaidWhy(decision)).toBe("An earned vendor: paid without waiting for your verdict.");
    expect(billNextStep(decision, { status: "paid", waiting: undefined, rule: null, canWrite: true, canDecide: true, counterparty: { id: "cp-1", name: "Northwind Packaging" } })).toEqual({
      text: "Give your verdict",
      tone: "agent",
      opens: "detail",
    });
  });

  it("asks nothing once a verdict is given, or of a viewer who cannot give one", () => {
    const given = invoiceDecision(invoice(), undefined, [onItsOwn], { network: "arc-testnet", verdicts: { ...verdicts, given: new Map([[41, { verdict: "agree", reason: null }]]) } });
    expect(billNextStep(given, { status: "paid", waiting: undefined, rule: null, canWrite: true, canDecide: true, counterparty: { id: "cp-1", name: "N" } })).toBeNull();
    const viewer = invoiceDecision(invoice(), undefined, [onItsOwn], { network: "arc-testnet", verdicts: { ...verdicts, canGive: false } });
    expect(billNextStep(viewer, { status: "paid", waiting: undefined, rule: null, canWrite: false, canDecide: false, counterparty: { id: "cp-1", name: "N" } })).toBeNull();
  });

  it("is not marked for a payment a person agreed to, nor for one still held", () => {
    const agreed = { ...onItsOwn, detail: { ...onItsOwn.detail, earned: undefined } };
    expect(invoiceDecision(invoice(), undefined, [agreed], { network: "arc-testnet" }).earned).toBeUndefined();
    const held = invoiceDecision(invoice({ status: "held", tx_ref: null }), undefined, [onItsOwn], { network: "arc-testnet" });
    expect(held.earned).toBeUndefined();
    expect(earnedPaidWhy({ ...held, earned: undefined } as Decision)).toBeNull();
    // A shadow-mode hold still says why it waits.
    expect(stoppedWhy({ ...held, heldForVerdict: true, guardrail: null } as Decision)).toBe("Shadow mode: it waits for a person to agree.");
  });
});

const STEPS: ReadinessStep[] = [
  { key: "verdicts", done: true, given: 8, target: 5 },
  { key: "waiting", done: true, waiting: 0 },
  { key: "addresses", done: true, mirrorPayees: 0 },
  { key: "mainnet", done: null },
];

/** Cobalt: five agreed payments, then three it paid on its own with no verdict yet. */
function facts(): EarnedFacts {
  const payee = { id: "cp-cobalt", name: "Cobalt Cloud", sample: false, role: "vendor", paymentLimit: 500 };
  const at = (day: number) => new Date(Date.parse("2026-10-19T09:00:00.000Z") + day * 86_400_000).toISOString();
  const bills = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: `inv-${n}`, amount: 400, currency: "USDC", payee }));
  const decisions = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    seq: 10 + n, ts: at(n), action: "ap_pay", invoiceId: `inv-${n}`, guardrailBlocked: false, guardrailRule: null, resultingStatus: n > 5 ? "paid" : "held", ...(n > 5 ? { onItsOwn: true } : {}),
  }));
  const given = [1, 2, 3, 4, 5].map((n) => ({ entrySeq: 10 + n, verdict: "agree" as const, decidedAt: at(n) }));
  return { bills, decisions, verdicts: given };
}

const view = (payments: boolean): EarnedVendorsView => ({ streak: 5, payments, statuses: earnedVendors(facts(), 5), recorded: new Set(["cp-cobalt"]) });
const LADDER = autonomyLadder([]);

describe("the report's Earned vendors (AL18, AL26, AL28)", () => {
  it("says the agent pays an earned vendor on its own while the switch is on, and how many of its payments wait", () => {
    const words = text(renderToStaticMarkup(<ReportReadiness steps={STEPS} ladder={LADDER} earned={view(true)} />));
    expect(words).toContain("starts the count again. The agent pays an earned vendor on its own, and you give your verdict after.");
    expect(words).toContain("3 of its payments made on its own wait for your verdict, so its next waits for you.");
  });

  it("says earning changes nothing until an owner lets it pay while the switch is off", () => {
    const words = text(renderToStaticMarkup(<ReportReadiness steps={STEPS} ladder={LADDER} earned={view(false)} />));
    expect(words).toContain("starts the count again. Earning changes nothing the agent may do unless an owner lets it pay earned vendors on its own, in Settings.");
    expect(words).not.toContain("made on its own wait for your verdict");
  });

  it("points the ladder to Earned vendors once a rule is set, and keeps its sentence where none is", () => {
    const ruled = text(renderToStaticMarkup(<ReportReadiness steps={STEPS} ladder={LADDER} earned={view(true)} />));
    expect(ruled).toContain("It only measures. What earning changes is under Earned vendors.");
    expect(ruled).not.toContain("nothing here changes what the agent may do");
    for (const earned of [null, { streak: null, statuses: [], recorded: new Set<string>() }]) {
      expect(text(renderToStaticMarkup(<ReportReadiness steps={STEPS} ladder={LADDER} earned={earned} />))).toContain("It only measures: nothing here changes what the agent may do.");
    }
  });
});

describe("the shadow mode sentences (AL28)", () => {
  it("in Settings, name the exception only while the switch is on", () => {
    const mode = { currency: "USD", startedAt: "2026-10-01T09:00:00.000Z", startedBy: null };
    const off = text(renderToStaticMarkup(<ShadowModePanel orgSlug="pinecrest" mode={mode} network="arc-testnet" canChange={false} />));
    expect(off).toContain("for bills in USD: the agent pays nothing until a person agrees.");
    const on = text(renderToStaticMarkup(<ShadowModePanel orgSlug="pinecrest" mode={mode} network="arc-testnet" canChange={false} earnedPayments />));
    expect(on).toContain("for bills in USD: the agent pays nothing until a person agrees, except vendors that earned it under your rule, which it pays on its own and you review after.");
  });

  it("in the workspace status, name the exception only while the switch is on", () => {
    const shadow = capabilityOf({ network: "arc-testnet", payments: { state: "on" }, hold: null, chainMode: "live", shadow: true });
    expect(paymentSentence(shadow)).toBe("Nothing is paid until a person agrees with the agent. A payment you agree to is sent in test USDC on Arc testnet.");
    const earned = capabilityOf({ network: "arc-testnet", payments: { state: "on" }, hold: null, chainMode: "live", shadow: true, earnedPayments: true });
    expect(paymentSentence(earned)).toBe(
      "Nothing is paid until a person agrees with the agent, except vendors that earned it under the owner's rule, which the agent pays on its own. A payment you agree to is sent in test USDC on Arc testnet."
    );
    // Off shadow mode the switch says nothing: the agent pays what passes its checks.
    expect(capabilityOf({ network: "arc-testnet", payments: { state: "on" }, hold: null, chainMode: "live", shadow: false, earnedPayments: true })).not.toHaveProperty("earnedPayments");

    const platform: PlatformStatus = { network: "arc-testnet", mode: "live", mainnetEnabled: false, paymentsOff: null, pause: null };
    const page = (earnedPayments?: boolean): PageStatus => ({
      chain: { mode: "live", earnMode: "simulate", held: false },
      shadow: true,
      ...(earnedPayments ? { earnedPayments } : {}),
      screening: { live: false, source: "bundled list" },
      clock: { mode: "real", day: 1 },
    });
    const row = (earnedPayments?: boolean) => statusRows(platform, page(earnedPayments)).find((one) => one.key === "shadow")?.detail;
    expect(row()).toBe("The agent decides each bill, and each decision waits for a person's verdict.");
    expect(row(true)).toBe("The agent decides each bill, and each decision waits for a person's verdict, except payments to vendors that earned it under the owner's rule.");
    expect(statusRows(platform, page(true)).find((one) => one.key === "payments")?.detail).toContain("except vendors that earned it under the owner's rule");
  });
});

describe("who paid, in the report (AL29)", () => {
  const reportFacts = (decision: Partial<ReportFacts["decisions"][number]>): ReportFacts => ({
    network: "arc-testnet",
    sandbox: false,
    now: "2026-10-28T12:00:00.000Z",
    openedAt: "2026-10-01T00:00:00.000Z",
    shadow: { currency: "USD", startedAt: "2026-10-01T00:00:00.000Z" },
    bills: [
      { id: "inv-1", createdAt: "2026-10-27T10:00:00.000Z", dueDate: null, amount: 400, currency: "USDC", status: "paid", reviewedBy: null, paidAmount: 400, discount: null, bill: null, payee: { id: "cp-1", name: "Northwind Packaging", mirror: false, sample: false } },
    ],
    decisions: [
      { seq: 41, ts: "2026-10-28T09:00:00.000Z", action: "ap_pay", invoiceId: "inv-1", guardrailBlocked: false, guardrailRule: null, heldBecause: null, resultingStatus: "paid", shadow: true, reasoning: null, ...decision },
    ],
    personActions: [],
    verdicts: [{ entrySeq: 41, verdict: "agree", decidedAt: "2026-10-28T11:00:00.000Z" }],
    payments: [{ invoiceId: "inv-1", amount: 400, token: "USDC", txHash: "0xabc", at: "2026-10-28T09:00:05.000Z", simulated: false }],
  });

  it("is the agent for a payment it made on its own, even after a person agreed with it", () => {
    expect(buildReport(reportFacts({ onItsOwn: true })).paymentList[0].decidedBy).toBe("agent");
  });

  it("is the verdict for a payment a person's Agree paid", () => {
    expect(buildReport(reportFacts({ resultingStatus: "held", heldBecause: "shadow_verdict" })).paymentList[0].decidedBy).toBe("verdict");
  });
});
