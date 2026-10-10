import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/recurring", () => ({ createRecurringPayableAction: vi.fn(), stopRecurringPayableAction: vi.fn() }));
import { readiness } from "@/components/CounterpartyRow";
import { DecisionRows } from "@/components/vx/DecisionRows";
import { payableSignals, stoppedWhy } from "@/components/vx/decision-signals";
import { RecurringSummary } from "@/components/vx/RecurringSummary";
import type { Decision } from "@/components/vx/types";

/**
 * Decisions as a list to scan (AP / AR layout): a row says who, what, the date that matters, the amount and the
 * outcome, closed by default; opening it shows the full decision card with its reasoning and actions. AP / AR
 * groups payables into what needs a person, what is upcoming and what is settled, and lists the latest settled.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const DECISION: Decision = {
  id: "inv-1",
  network: "arc-testnet",
  domain: "ap",
  action: "Pay",
  subject: "API Service",
  memo: "PO-API-120",
  amount: 0.1,
  token: "USDC",
  outcome: "scheduled",
  outcomeLabel: "Scheduled for Oct 5",
  reasoning: "Three-way match complete, within the limit; scheduled for its due date.",
  evidence: [],
  at: "2026-10-02T07:16:50Z",
};

describe("DecisionRows", () => {
  it("shows each decision as one closed row: who, what, the date, the amount and the outcome, with its card inside", () => {
    const markup = renderToStaticMarkup(<DecisionRows orgSlug="testnet-2" items={[{ decision: DECISION, date: { label: "Pays Oct 5, 2026" }, footerAction: <span>Share receipt</span> }]} />);
    expect(markup).toMatch(/^<div[^>]*>\s*<ul/);
    expect(markup).toMatch(/<details(?![^>]*\sopen)/);
    const summary = text(markup.slice(markup.indexOf("<summary"), markup.indexOf("</summary>")));
    expect(summary).toContain("API Service");
    expect(summary).toContain("PO-API-120");
    expect(summary).toContain("Pays Oct 5, 2026");
    expect(summary).toContain("0.10");
    expect(summary).toContain("Scheduled for Oct 5");
    const card = text(markup.slice(markup.indexOf("</summary>")));
    expect(card).toContain("Three-way match complete");
    expect(card).toContain("Share receipt");
  });

  it("says under the title what a row waits for, and puts what a person decides above its card", () => {
    const markup = renderToStaticMarkup(
      <DecisionRows orgSlug="testnet-2" items={[{ decision: DECISION, hint: "Circle did not send it", before: <p>Pay now or close it</p> }]} />
    );
    const summary = markup.slice(markup.indexOf("<summary"), markup.indexOf("</summary>"));
    expect(summary).toMatch(/text-held">Circle did not send it</);
    const opened = text(markup.slice(markup.indexOf("</summary>")));
    expect(opened.indexOf("Pay now or close it")).toBeLessThan(opened.indexOf("Three-way match complete"));
  });

  it("shows what the agent checked under the title, each marked passed, in the way, or noted, before the row opens", () => {
    const signals = [
      { label: "PO on file", state: "ok" as const },
      { label: "Not received", state: "missing" as const },
      { label: "Medium risk", state: "neutral" as const },
    ];
    const markup = renderToStaticMarkup(<DecisionRows orgSlug="testnet-2" items={[{ decision: DECISION, signals }]} />);
    const summary = markup.slice(markup.indexOf("<summary"), markup.indexOf("</summary>"));
    expect(summary).toContain('aria-label="What the agent checked"');
    expect(text(summary)).toContain("PO on file , passed Not received , in the way Medium risk , noted");
    expect(summary).toMatch(/text-proof[\s\S]*PO on file/);
    expect(summary).toMatch(/text-held[\s\S]*Not received/);
  });

  it("says under the title why a row waits for a person", () => {
    const markup = renderToStaticMarkup(<DecisionRows orgSlug="testnet-2" items={[{ decision: DECISION, why: "Code stopped it: the payout fee is above 10% of the invoice." }]} />);
    const summary = text(markup.slice(markup.indexOf("<summary"), markup.indexOf("</summary>")));
    expect(summary).toContain("Why · Code stopped it: the payout fee is above 10% of the invoice.");
  });

  it("opens a row from the start when asked, with its card in view", () => {
    const markup = renderToStaticMarkup(<DecisionRows orgSlug="testnet-2" items={[{ decision: DECISION, open: true }]} />);
    expect(markup).toMatch(/<details[^>]*\sopen/);
  });

  it("marks a date past due", () => {
    const markup = renderToStaticMarkup(<DecisionRows orgSlug="testnet-2" items={[{ decision: DECISION, date: { label: "Overdue Sep 30, 2026", tone: "held" } }]} />);
    expect(markup).toMatch(/text-held[^"]*">Overdue Sep 30, 2026/);
  });
});

describe("the AP / AR page", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "invoices", "page.tsx"), "utf8");

  it("leads with what needs a person, what is due within 7 days, what is overdue and what is still to pay", () => {
    for (const label of ["Needs you", "Due within 7 days", "Overdue", "Open payables"]) expect(page).toContain(`label="${label}"`);
  });

  it("folds New invoice, open only for a workspace with no invoice yet", () => {
    expect(page).toMatch(/<IntakeFold label="New invoice"[^>]*defaultOpen=\{invoices\.length === 0\}>/);
  });

  it("groups payables into Needs you, Upcoming, and Paid and closed, the latest five of those until Show all", () => {
    const payables = page.slice(page.indexOf('title="Payables"'), page.indexOf('title="Receivables"'));
    const order = ['title="Needs you"', 'title="Upcoming"', 'title="Paid and closed"'].map((title) => payables.indexOf(title));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page).toContain("const HISTORY_SHOWN = 5;");
    expect(payables).toContain("settled.slice(0, HISTORY_SHOWN)");
  });

  it("keeps the rows that need a person closed, each with what the agent checked and why it waits", () => {
    const needsYou = page.slice(page.indexOf('title="Needs you"'), page.indexOf('title="Upcoming"'));
    expect(needsYou).not.toMatch(/open: /);
    expect(needsYou).toContain("{ signals: payableSignals(decision), why: stoppedWhy(decision) }");
    // A row whose hint says what it needs needs no why line besides.
    expect(page).toContain("why: hint ? undefined : extra.why");
    expect(page).toContain("row(decision, withVerdict(receiptFor), { signals: payableSignals(decision) })");
  });

  it("folds the recurring schedules to one line under the payables they create", () => {
    expect(page.indexOf("<RecurringSummary")).toBeGreaterThan(page.indexOf('title="Payables"'));
    expect(page.indexOf("<RecurringSummary")).toBeLessThan(page.indexOf('title="Receivables"'));
  });
});

describe("the Contractors page", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "contractors", "page.tsx"), "utf8");

  it("puts both ways to pay under one folded New payment, open only for a workspace with no milestone yet", () => {
    const fold = page.slice(page.indexOf("<IntakeFold"), page.indexOf("</IntakeFold>"));
    expect(fold).toMatch(/<IntakeFold label="New payment"[^>]*defaultOpen=\{milestones\.length === 0\}>/);
    expect(fold).toContain("<PayFreelancerForm");
    expect(fold).toContain("<MilestoneIntake");
  });

  it("groups milestones into Needs you, In progress, and Paid and closed, and shows verification and escrow only inside an opened row", () => {
    const list = page.slice(page.indexOf('title="Milestones"'));
    const order = ['title="Needs you"', 'title="In progress"', 'title="Paid and closed"'].map((title) => list.indexOf(title));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page).toContain("after: controls(milestone)");
    expect(list).not.toContain("<MilestoneVerification");
  });

  it("says on each held row what it waits for, with Pay now and Close without paying once it is opened", () => {
    expect(page).toContain('if (milestone.status !== "held") return item;');
    expect(page).toContain("hint: reason.hint,");
    expect(page).toContain("<HeldMilestoneActions");
  });

  it("puts a verified milestone whose address no one has confirmed under Needs you, with where to confirm it", () => {
    expect(page).toContain("statusOf(decision) === \"held\" || confirming(decision)");
    expect(page).toContain('hint: "Address to confirm"');
    expect(page).toContain('<Link href={orgHref(slug, "/counterparties")}>Open Counterparties</Link>');
  });
});

describe("the Counterparties page", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "counterparties", "page.tsx"), "utf8");

  it("folds Add counterparty, open only for a workspace with none yet, or when a link asks for it", () => {
    expect(page).toMatch(/<IntakeFold label="Add counterparty"[^>]*defaultOpen=\{counterparties\.length === 0 \|\| adding\}>/);
  });

  it("lists each counterparty as a row with what it needs, the ones that need someone first", () => {
    const base = { risk_level: "clear", risk_notes: null, address: "0x840de234Bfc3F66fA380888A0a8204D9487D60d4", address_changed_at: null, address_confirmed_at: null, role: "vendor" };
    const cases = [
      { ...base, risk_level: "medium", risk_notes: "Matched a politically exposed person" },
      { ...base, address_changed_at: "2026-10-02T09:00:00Z" },
      { ...base, address: null },
      base,
      { ...base, role: "client", address: null },
    ];
    expect(cases.map((counterparty) => [readiness(counterparty).label, readiness(counterparty).rank])).toEqual([
      ["Review match", 0],
      ["Confirm address", 1],
      ["Address needed", 2],
      ["Ready to pay", 3],
      ["Client", 4],
    ]);
    expect(page).toContain("readiness(a).rank - readiness(b).rank || a.name.localeCompare(b.name)");
    expect(page).toContain("{ordered.map((counterparty) => (");
  });
});

describe("what the agent checked on a payable", () => {
  const evidence = (po: string, poState: "ok" | "missing" | "neutral", goods: boolean, risk: string, limit: string, limitState: "neutral" | "missing") => [
    { label: "PO", value: po, state: poState },
    { label: "Goods received", value: goods ? "yes" : "no", state: goods ? ("ok" as const) : ("missing" as const) },
    { label: "Risk", value: risk, state: risk === "high" ? ("missing" as const) : ("neutral" as const) },
    { label: "Limit", value: limit, state: limitState },
    { label: "Due", value: "10/8/2026", state: "neutral" as const },
  ];

  it("reads the card's own evidence: the match, the screening and the limit", () => {
    const signals = payableSignals({ ...DECISION, evidence: evidence("PO-1", "ok", true, "clear", "2.00 USDC", "neutral") });
    expect(signals).toEqual([
      { label: "PO on file", state: "ok" },
      { label: "Goods received", state: "ok" },
      { label: "Screened clear", state: "ok" },
      { label: "Within its limit", state: "ok" },
    ]);
  });

  it("names what stands in the way, and leaves out a limit that is not set", () => {
    const signals = payableSignals({ ...DECISION, evidence: evidence("none", "missing", false, "unscreened", "none", "neutral") });
    expect(signals).toEqual([
      { label: "No PO", state: "missing" },
      { label: "Not received", state: "missing" },
      { label: "Not screened", state: "missing" },
    ]);
    expect(payableSignals({ ...DECISION, evidence: evidence("not needed", "neutral", true, "high", "1.00 USDC", "missing") })).toEqual([
      { label: "No PO needed", state: "neutral" },
      { label: "Goods received", state: "ok" },
      { label: "High risk", state: "missing" },
      { label: "Over its limit", state: "missing" },
    ]);
  });

  it("says why a payable waits: the rule, when code stopped it, else the agent's own first sentence", () => {
    const guarded = { ...DECISION, outcome: "refused" as const, guardrail: { rule: "bridge.fee_above_cap", attempted: 0.75 } };
    expect(stoppedWhy(guarded)).toBe("Code stopped it: the payout fee is above 10% of the invoice.");
    const held = { ...DECISION, outcome: "held" as const, reasoning: "The three-way match is incomplete: no purchase order is on file. Ask for it before paying." };
    expect(stoppedWhy(held)).toBe("The three-way match is incomplete: no purchase order is on file.");
    // A rule with no words of its own gives way to the reasoning.
    expect(stoppedWhy({ ...held, guardrail: { rule: "some.new_rule", attempted: 1 } })).toBe("The three-way match is incomplete: no purchase order is on file.");
    expect(stoppedWhy({ ...held, reasoning: `${"a".repeat(200)}.` })?.length).toBe(160);
    expect(stoppedWhy({ ...held, domain: "ar" })).toBeNull();
  });

  it("says a payment held for a verdict in shadow mode waits for one, not that code stopped it (2026-10-08)", () => {
    const shadowHeld = { ...DECISION, outcome: "held" as const, heldForVerdict: true };
    expect(stoppedWhy(shadowHeld)).toBe("Shadow mode: it waits for a person to agree.");
    // A payment the agent decided in shadow mode that code held still says code stopped it.
    const codeHeld = { ...shadowHeld, guardrail: { rule: "bridge.fee_above_cap", attempted: 0.75 } };
    expect(stoppedWhy(codeHeld)).toBe("Code stopped it: the payout fee is above 10% of the invoice.");
  });

  it("says nothing for a receivable", () => {
    expect(payableSignals({ ...DECISION, domain: "ar", evidence: evidence("PO-1", "ok", true, "clear", "2.00 USDC", "neutral") })).toEqual([]);
  });
});

describe("the recurring schedules on AP / AR", () => {
  const schedule = (id: string, name: string, nextDueOn: string | null, status: "active" | "stopped" | "ended", amount = 0.5) => ({
    id,
    counterpartyName: name,
    amount,
    currency: "USDC" as const,
    memo: "Daily retainer",
    cadence: "every day",
    nextDueOn,
    endsOn: null,
    status,
  });

  it("folds them to one line: how many run, and the period that falls due next", () => {
    const markup = renderToStaticMarkup(
      <RecurringSummary
        orgSlug="testnet-2"
        canWrite={false}
        schedules={[schedule("a", "Jiren", "2026-10-10", "active", 0.75), schedule("b", "Gozo", "2026-10-08", "active"), schedule("c", "Old Co", null, "stopped")]}
      />
    );
    expect(markup).toMatch(/<details(?![^>]*\sopen)/);
    const summary = text(markup.slice(markup.indexOf("<summary"), markup.indexOf("</summary>")));
    expect(summary).toContain("Recurring payments 2 active · next: Gozo, Oct 8, 2026, 0.50 USDC");
    // Each schedule is still listed once it is opened.
    expect(text(markup.slice(markup.indexOf("</summary>")))).toContain("Old Co");
  });
});
