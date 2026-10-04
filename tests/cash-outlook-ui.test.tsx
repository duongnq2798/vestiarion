import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CashCalendar, SafeToSpendPanel } from "@/components/vx/CashOutlook";
import type { CashOutlook } from "@/lib/cash-outlook";

/**
 * The console's Safe to spend today and Next 30 days (safe to spend design): the figure and how it was
 * reached, short when the owed exceeds the wallet, and each day with money moving and the balance after.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const OUTLOOK: CashOutlook = {
  safeToSpend: 35.5,
  cash: 100,
  reserve: 0,
  dueIn30d: 50,
  dueCount: 2,
  milestonesOpen: 10,
  milestoneCount: 1,
  cushion: 4.5,
  expectedIn30d: 40,
  eurcLeftOut: 0,
  shortOn: null,
  days: [
    { day: "2026-10-02", items: [{ kind: "milestone", label: "Linh: Thumbnails", amount: 10, note: "verified" }], balance: 90, balanceWithExpected: 90 },
    {
      day: "2026-10-05",
      items: [
        { kind: "out", label: "Northwind", amount: 20, note: "scheduled" },
        { kind: "in", label: "Acme", amount: 40, note: "expected" },
      ],
      balance: 70,
      balanceWithExpected: 110,
    },
  ],
};

describe("SafeToSpendPanel", () => {
  it("shows the figure and every amount taken off it", () => {
    const page = text(renderToStaticMarkup(<SafeToSpendPanel outlook={OUTLOOK} />));
    expect(page).toContain("Safe to spend today");
    expect(page).toContain("35.50");
    expect(page).toContain("In the operating wallet");
    expect(page).toContain("Due within 30 days (2 invoices)");
    expect(page).toContain("Open milestones (1)");
    expect(page).toContain("Cushion: 15% of the next 7 days");
    expect(page).toContain("not counted until they arrive");
  });

  it("names the USYC reserve it counts, and only when there is one", () => {
    const withReserve = text(renderToStaticMarkup(<SafeToSpendPanel outlook={{ ...OUTLOOK, cash: 0.23, reserve: 154.381758, safeToSpend: 154.381758 }} />));
    expect(withReserve).toContain("In the USYC reserve, back in seconds");
    expect(withReserve).toContain("154.381758");
    expect(text(renderToStaticMarkup(<SafeToSpendPanel outlook={OUTLOOK} />))).not.toContain("USYC reserve");
  });

  it("says by how much it is short, and the day the wallet runs out", () => {
    const page = text(renderToStaticMarkup(<SafeToSpendPanel outlook={{ ...OUTLOOK, safeToSpend: -18, shortOn: "2026-10-11" }} />));
    expect(page).toContain("Short by");
    expect(page).toContain("18.00");
    expect(page).toContain("The wallet runs short on Oct 11, 2026");
  });

  it("says EURC owed is paid from EURC, apart from this figure", () => {
    expect(text(renderToStaticMarkup(<SafeToSpendPanel outlook={{ ...OUTLOOK, eurcLeftOut: 17 }} />))).toContain("paid from the EURC balance, so it is left out");
  });
});

describe("CashCalendar", () => {
  it("lists each day with money moving, what moves and why, and the balance after", () => {
    const page = text(renderToStaticMarkup(<CashCalendar outlook={OUTLOOK} />));
    expect(page).toContain("Next 30 days");
    expect(page).toContain("Oct 2, 2026");
    expect(page).toContain("Linh: Thumbnails verified");
    expect(page).toContain("Northwind scheduled");
    expect(page).toContain("Acme expected");
    expect(page).toContain("Balance after");
    expect(page).toContain("with expected");
  });

  it("writes a balance below zero with its minus sign, as on the day the wallet runs short", () => {
    const short: CashOutlook = {
      ...OUTLOOK,
      days: [{ day: "2026-10-09", items: [{ kind: "out", label: "Harbor", amount: 30, note: "due" }], balance: -7.5, balanceWithExpected: 17.5 }],
    };
    const page = text(renderToStaticMarkup(<CashCalendar outlook={short} />));
    expect(page).toMatch(/Balance after − 7\.50 USDC \( 17\.50 USDC with expected\)/);
  });

  it("shows nothing when no money moves in the next 30 days", () => {
    expect(renderToStaticMarkup(<CashCalendar outlook={{ ...OUTLOOK, days: [] }} />)).toBe("");
  });
});
