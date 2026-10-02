import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
    expect(page).toContain("defaultOpen={invoices.length === 0}");
    expect(page.indexOf("New invoice")).toBeGreaterThan(page.indexOf("<Disclosure"));
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
