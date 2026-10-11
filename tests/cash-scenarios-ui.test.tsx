import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CashScenarios, CoverageList, ScenarioCases, ScenarioFindings, ScenarioOutcome } from "@/components/vx/CashScenarios";
import { cashScenario, DEFAULT_LEVERS, type ScenarioBasis, type ScenarioLevers } from "@/lib/cash-scenarios";

/**
 * Treasury's What if section (docs/superpowers/specs/2026-10-11-cash-scenarios-design.md): its levers, the two cases,
 * the bills a short day touches, advice in words, what moves it most and what it is built from; never an instruction
 * to borrow or invest, and never read by anything that pays.
 */

const ROOT = process.cwd();
// Tags become spaces, so the space a tag leaves before a comma or a full stop is taken out again.
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .replace(/ ([,.;])/g, "$1")
    .trim();

const BASIS: ScenarioBasis = {
  today: "2026-10-02",
  cash: 60,
  reserve: 40,
  outflows: [
    { id: "nw", kind: "bill", label: "Northwind", amount: 60, day: 6, note: "scheduled", foreign: false, dueDay: 25 },
    { id: "hb", kind: "bill", label: "Harbor", amount: 80, day: 12, note: "due", foreign: false },
    { id: "rec-1:2026-10-24", kind: "recurring", label: "Linh Design", amount: 25, day: 22, note: "recurring, not billed yet", foreign: false },
    { id: "m1", kind: "milestone", label: "Linh: Logo", amount: 5, day: 0, note: "verified", foreign: false },
  ],
  receivables: [{ id: "acme", label: "Acme", amount: 70, day: 10, overdue: false, client: "client-acme" }],
  clients: { "client-acme": { paidOnTime: 2, paidLate: 1, averageDaysLate: 9 } },
  eurc: [{ kind: "bill", amount: 12, day: 4 }],
  recurringRead: true,
};
const levers = (over: Partial<ScenarioLevers> = {}): ScenarioLevers => ({ ...DEFAULT_LEVERS, horizon: 30, ...over });

describe("ScenarioOutcome", () => {
  const short = text(renderToStaticMarkup(<ScenarioOutcome result={cashScenario(BASIS, levers())} />));

  it("sets the scenario beside things as they stand, with the day it runs short and its lowest", () => {
    expect(short).toContain("As things stand");
    expect(short).toContain("Never short in the next 30 days");
    expect(short).toContain("In this scenario");
    expect(short).toContain("Runs short on Oct 14, 2026");
    expect(short).toMatch(/Lowest: − 70\.00 USDC on Oct 24, 2026/);
    expect(short).toContain("1 receivable 14 days late");
  });

  it("keeps cash, bank money, receivables and deals not invoiced apart", () => {
    expect(short).toMatch(/Cash today: 100\.00 USDC, in the operating wallet and the USYC reserve\. No bank balance is counted\./);
    expect(short).toContain("counted only on the day they arrive");
    expect(short).toContain("Deals not invoiced yet are not counted.");
    // Without a reserve, cash is the wallet alone.
    const walletOnly = text(renderToStaticMarkup(<ScenarioOutcome result={cashScenario({ ...BASIS, reserve: 0 }, levers())} />));
    expect(walletOnly).toMatch(/Cash today: 60\.00 USDC, in the operating wallet\. No bank balance is counted\./);
  });

  it("lists what falls due while the balance is short", () => {
    expect(short).toContain("Due while the balance is short");
    expect(short).toMatch(/Oct 14, 2026 Harbor due − 80\.00 USDC/);
    expect(short).toMatch(/Oct 24, 2026 Linh Design recurring, not billed yet − 25\.00 USDC/);
  });

  it("gives advice in words, said to be advice", () => {
    expect(short).toContain("What could help advice only: nothing here changes a payment");
    expect(short).toMatch(/To pay every bill on its day in this scenario, the wallet needs 70\.00 USDC more by Oct 14, 2026\./);
    expect(short).toContain("Northwind is scheduled for Oct 8, 2026, before its due day, Oct 27, 2026.");
    expect(short).toContain("any early-payment discount it was scheduled for is lost");
    expect(short).toMatch(/Acme's 70\.00 USDC, due Oct 12, 2026, arrives on Oct 26, 2026 in this scenario\. Of the receivables, it is the one that matters most for Oct 14, 2026\./);
  });

  it("names what moves it most, by the short day", () => {
    expect(short).toContain("What moves it most by Oct 14, 2026");
    expect(short).toMatch(/Harbor: 80\.00 USDC out, 1 bill/);
    expect(short).toMatch(/Acme: 70\.00 USDC in a receivable that arrives on Oct 26, 2026/);
    expect(short).toMatch(/Northwind: 60\.00 USDC out, 1 bill/);
  });

  it("says what it is built from, how far bills are known, and what it leaves out", () => {
    expect(short).toContain("What this is built from");
    expect(short).toContain("Bills known for 13 of 30 days");
    expect(short).toMatch(/Bills: 2, 140\.00 USDC, the latest due Oct 14, 2026\./);
    expect(short).toMatch(/Recurring payments not billed yet: 1, 25\.00 USDC, from 1 schedule, counted on their due days\./);
    expect(short).toMatch(/Open milestones: 1, 5\.00 USDC, with no payment day, so counted today\./);
    expect(short).toMatch(/Receivables: 1, 70\.00 USDC; 1 from clients who have paid before\./);
    expect(short).toContain("Acme paid 3 receivables before: 2 on time, 1 late, 9 days late on average.");
    expect(short).toMatch(/Left out, paid from and into the EURC balance: 12\.00 EURC in bills, 0\.00 EURC in receivables\./);
    expect(short).toContain("Bills not added yet are not counted, so the days after Oct 14, 2026 may look better than they will be.");
    expect(short).toContain("Client records are counts, not a prediction.");
  });

  it("says it is a what-if that reaches no payment, with a day-by-day table and a chart that says the same", () => {
    expect(short).toContain("A what-if from the bills and receivables on record, not a forecast.");
    expect(short).toContain("Nothing here is saved, changes a payment or reaches the agent");
    expect(short).toContain("Day by day");
    const markup = renderToStaticMarkup(<ScenarioOutcome result={cashScenario(BASIS, levers())} />);
    expect(markup).toMatch(/role="img" aria-label="The balance over the next 30 days\. As things stand, it never runs short\. In this scenario, it runs short on Oct 14, 2026\."/);
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-label="Balance day by day"');
  });

  it("offers no advice when the scenario never runs short", () => {
    const fine = text(renderToStaticMarkup(<ScenarioOutcome result={cashScenario(BASIS, levers({ lateDays: 0 }))} />));
    expect(fine).toContain("Never short in the next 30 days");
    expect(fine).not.toContain("What could help");
    expect(fine).not.toContain("Due while the balance is short");
    expect(fine).toContain("Nothing changed yet: set a lever above.");
  });

  it("says when recurring payments could not be read, and when no bill is known", () => {
    const empty = text(renderToStaticMarkup(<ScenarioOutcome result={cashScenario({ ...BASIS, outflows: [], receivables: [], eurc: [], recurringRead: false }, levers())} />));
    expect(empty).toContain("Recurring payments could not be read, so none is counted.");
    expect(empty).toContain("No bill is due in the next 30 days.");
    expect(empty).toContain("No receivable is due in the next 30 days.");
    expect(empty).toContain("No bill is known for these days yet, so the balance may look better than it will be.");
  });
});

describe("CashScenarios", () => {
  const markup = renderToStaticMarkup(<CashScenarios basis={BASIS} />);
  const shown = text(markup);

  it("is folded under its own anchor, its title a heading", () => {
    expect(markup).toMatch(/^<section id="cash-scenarios"/);
    expect(markup).toMatch(/<details(?![^>]*\sopen)/);
    expect(markup).toMatch(/<h2 id="[^"]+-title"[^>]*>What if clients pay late\?<\/h2>/);
    expect(shown).toContain("Late or missing receivables and changed bill costs, 30 to 90 days ahead. Nothing here is saved or paid.");
  });

  it("offers 30, 60 or 90 days, 60 first, as pressed buttons in a labelled group", () => {
    expect(markup).toMatch(/role="group" aria-labelledby="[^"]+-horizon"/);
    expect(shown).toContain("Look ahead");
    for (const days of [30, 90]) expect(markup).toMatch(new RegExp(`aria-pressed="false"[^>]*>${days} days<`));
    expect(markup).toMatch(/aria-pressed="true"[^>]*>60 days</);
  });

  it("labels each lever, and each receivable's choice, late by default", () => {
    expect(shown).toContain("Clients pay late by (days)");
    expect(markup).toMatch(/value="14"/);
    expect(shown).toContain("Change in bill costs (%)");
    expect(shown).toContain("The change applies to");
    expect(shown).toContain("Receivables due in the next 60 days");
    expect(markup).toContain('aria-label="When Acme pays"');
    expect(shown).toMatch(/Acme 70\.00 USDC due Oct 12, 2026/);
  });

  it("works out the outcome inside the section, and draws the levers alone when asked, for the guide's picture", () => {
    expect(shown).toContain("As things stand");
    expect(shown).toContain("What this is built from");
    const leversOnly = text(renderToStaticMarkup(<CashScenarios basis={BASIS} defaultOpen outcome={false} />));
    expect(leversOnly).toContain("Clients pay late by (days)");
    expect(leversOnly).not.toContain("As things stand");
    expect(leversOnly).not.toContain("What this is built from");
  });
});

describe("the outcome's parts", () => {
  const result = cashScenario(BASIS, levers());

  it("are the cases and chart, the findings, and the coverage, which together make the outcome", () => {
    const cases = text(renderToStaticMarkup(<ScenarioCases result={result} />));
    expect(cases).toContain("Runs short on Oct 14, 2026");
    expect(cases).toContain("No bank balance is counted.");
    expect(cases).not.toContain("What could help");
    const findings = text(renderToStaticMarkup(<ScenarioFindings result={result} />));
    expect(findings).toContain("Due while the balance is short");
    expect(findings).toContain("What could help");
    expect(findings).toContain("What moves it most");
    expect(findings).not.toContain("What this is built from");
    expect(text(renderToStaticMarkup(<CoverageList result={result} />))).toContain("Bills known for 13 of 30 days");
  });

  it("draw no findings when nothing leaves and nothing runs short", () => {
    const quiet = cashScenario({ ...BASIS, outflows: [] }, levers());
    expect(renderToStaticMarkup(<ScenarioFindings result={quiet} />)).toBe("");
  });
});

describe("the copy", () => {
  const sources = ["src/components/vx/CashScenarios.tsx", "src/lib/cash-scenarios.ts", "src/lib/cash-scenario-basis.ts"].map((file) => readFileSync(path.join(ROOT, file), "utf8"));

  it("never tells anyone to borrow or invest, and never talks the money down", () => {
    for (const source of sources) {
      expect(source).not.toMatch(/\b(?:borrow|loan|credit|invest|sweep)\w*/i);
      expect(source).not.toMatch(/no real money|play money|\bfake\b/i);
    }
  });
});

describe("money safety", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : [];
    });
  const payers = ["src/lib/agent", "src/lib/commands", "src/app/actions", "src/app/api"].flatMap((dir) => walk(path.join(ROOT, dir)));

  it("leaves the scenarios out of everything that pays, decides or answers the API", () => {
    expect(payers.length).toBeGreaterThan(50);
    const importers = payers.filter((file) => /from\s+["'][^"']*cash-scenario/.test(readFileSync(file, "utf8")));
    expect(importers).toEqual([]);
  });
});

describe("the Treasury page", () => {
  const page = readFileSync(path.join(ROOT, "src", "app", "o", "[slug]", "console", "page.tsx"), "utf8");

  it("draws What if right under Next 30 days, from the rows the outlook counts and the recurring payments", () => {
    expect(page).toContain("<CashOutlookPanel outlook={outlook} />\n              <CashScenarios basis={scenarios} />");
    expect(page).toContain("const outlook = cashOutlook(outlookInput);");
    expect(page).toContain("const scenarios = scenarioBasis({ ...outlookInput, recurring });");
    expect(page).toMatch(/listRecurringPayables\(\)\.catch\(/);
  });
});
