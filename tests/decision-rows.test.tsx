import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readiness } from "@/components/CounterpartyRow";
import { DecisionRows } from "@/components/vx/DecisionRows";
import type { Decision } from "@/components/vx/types";

/**
 * Decisions as a list to scan (AP / AR layout): a row says who, what, the date that matters, the amount and the
 * outcome, closed by default; opening it shows the full decision card with its reasoning and actions. AP / AR
 * groups payables into what needs a person, what is upcoming and what is settled, and lists the latest settled.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const DECISION: Decision = {
  id: "inv-1",
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

  it("groups payables into Needs you, Upcoming, and Paid and closed, the latest ten of those until Show all", () => {
    const payables = page.slice(page.indexOf('title="Payables"'), page.indexOf('title="Receivables"'));
    const order = ['title="Needs you"', 'title="Upcoming"', 'title="Paid and closed"'].map((title) => payables.indexOf(title));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page).toContain("const HISTORY_SHOWN = 10;");
    expect(payables).toContain("settled.slice(0, HISTORY_SHOWN)");
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

  it("folds Add counterparty, open only for a workspace with none yet", () => {
    expect(page).toMatch(/<IntakeFold label="Add counterparty"[^>]*defaultOpen=\{counterparties\.length === 0\}>/);
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
