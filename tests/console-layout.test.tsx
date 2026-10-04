import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CashOutlookPanel, SafeToSpendFigure } from "@/components/vx/CashOutlook";
import { CollapsibleReasoning } from "@/components/vx/CollapsibleReasoning";
import { ManageDisclosure } from "@/components/vx/ManageDisclosure";
import type { CashOutlook } from "@/lib/cash-outlook";

/**
 * The console, laid out to be scanned: Safe to spend today is a headline tile linking to the one panel that
 * shows how it is reached and the 30 days behind it; treasury reasoning is folded to its first lines; the
 * funds outside the wallet show their figure, with their explanation and form folded under Manage; and the
 * side column holds only what people check.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "console", "page.tsx"), "utf8");

const OUTLOOK: CashOutlook = {
  safeToSpend: 35.5,
  cash: 100,
  reserve: 0,
  dueIn30d: 50,
  dueCount: 2,
  milestonesOpen: 10,
  milestoneCount: 1,
  cushion: 4.5,
  expectedIn30d: 0,
  eurcLeftOut: 0,
  shortOn: null,
  days: [{ day: "2026-10-05", items: [{ kind: "out", label: "Northwind", amount: 20, note: "scheduled" }], balance: 80, balanceWithExpected: 80 }],
};

describe("CashOutlookPanel", () => {
  it("is the console's one picture of what is owed: how Safe to spend today is reached, then each day, under the tile's anchor", () => {
    const markup = renderToStaticMarkup(<CashOutlookPanel outlook={OUTLOOK} />);
    expect(markup).toContain('id="cash-outlook"');
    const shown = text(markup);
    expect(shown).toContain("Next 30 days");
    expect(shown).toContain("In the operating wallet");
    expect(shown).toContain("Due within 30 days (2 invoices)");
    expect(shown).toContain("Northwind");
  });

  it("gives the tile the figure, or how short the wallet is", () => {
    expect(text(renderToStaticMarkup(<SafeToSpendFigure outlook={OUTLOOK} />))).toMatch(/^35\.50/);
    expect(text(renderToStaticMarkup(<SafeToSpendFigure outlook={{ ...OUTLOOK, safeToSpend: -4 }} />))).toMatch(/^Short by 4\.00/);
  });
});

describe("CollapsibleReasoning", () => {
  it("leaves a short reasoning whole, with no toggle", () => {
    const markup = renderToStaticMarkup(<CollapsibleReasoning text="Held: the payee's address changed and no one has confirmed it." />);
    expect(markup).not.toContain("View reasoning");
    expect(markup).not.toContain("line-clamp-3");
  });

  it("folds a long one to three lines with a toggle that says what it controls, the whole text still in the page", () => {
    const long = "Idle operating cash would sit unused for about a day, so sweeping it would cost more than it earns. ".repeat(4);
    const markup = renderToStaticMarkup(<CollapsibleReasoning text={long} />);
    expect(markup).toContain("line-clamp-3");
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"[^>]*>View reasoning<\/button>/);
    expect(text(markup)).toContain(long.trim());
  });
});

describe("ManageDisclosure", () => {
  it("is closed by default, its form still in the page", () => {
    const markup = renderToStaticMarkup(
      <ManageDisclosure label="Manage">
        <form>
          <input name="amount" />
        </form>
      </ManageDisclosure>
    );
    expect(markup).toMatch(/^<details(?![^>]*\sopen)/);
    expect(markup).toContain("<summary");
    expect(markup).toContain('name="amount"');
  });
});

describe("the console page", () => {
  const aside = page.slice(page.indexOf("<aside"), page.indexOf("</aside>"));
  const main = page.slice(page.indexOf('<div className="min-w-0 space-y-8">'), page.indexOf("<aside"));

  it("leads with Safe to spend today as a tile that links to how it is reached", () => {
    expect(page).toMatch(/<StatTile label="Safe to spend today"[^>]*href="#cash-outlook"/);
    expect(main).toContain("<CashOutlookPanel outlook={outlook} />");
  });

  it("folds the treasury decisions' reasoning", () => {
    const treasury = main.slice(main.indexOf('title="Treasury decisions"'));
    expect(treasury).toContain("collapseReasoning");
  });

  it("keeps the side column to the limits, accounts and forecast, then the funds outside the wallet", () => {
    const order = ["<AgentBudgetPanel", "<AccountsList", "<ForecastPanel", "<GatewayPanel", "<ServiceBudgetPanel"].map((tag) => aside.indexOf(tag));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(aside).not.toContain("SafeToSpendPanel");
  });
});
