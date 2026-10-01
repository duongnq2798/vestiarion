import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OpenPage, { metadata } from "@/app/open/page";
import { formatFigure, formatRow, OPEN_ROWS, OUTCOME_ROWS } from "@/components/open/OpenNumbersTable";
import { requiresSession } from "@/lib/auth/routes";
import { readOpenNumbers, type OpenNumbers } from "@/lib/platform/open-numbers";

vi.mock("@/lib/platform/open-numbers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/open-numbers")>();
  return { ...actual, readOpenNumbers: vi.fn() };
});

/**
 * The public /open page (docs/superpowers/specs/2026-09-30-open-numbers-design.md
 * §2): one table with customers, ours and the total; the payments chart; our
 * own payments with arcscan links; and the method. The figures come from
 * readOpenNumbers, faked here; parsePeriod and dailySeries are the real ones.
 */

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const side = (scale: number) => ({
  workspacesOpened: 2 * scale, liveWorkspaces: 1 * scale, people: 3 * scale, payments: 4 * scale, usdcPaid: 1234.5 * scale,
  payees: 2 * scale, invoicesDecided: 5 * scale, milestonesReleased: 1 * scale, cycles: 7 * scale, modelDecisions: 9 * scale,
  policyDepartures: 1 * scale, refusedByCode: 1 * scale, usdcInWallets: 40 * scale,
  firstPayments: 1 * scale, medianMinutesToFirstPayment: scale === 2 ? null : 95 * scale,
  decisionsCarriedOut: 3 * scale, decisionsEscalated: 1 * scale, escalationsResolved: 1 * scale, flagsResolved: 2 * scale,
  flagsUpheld: 1 * scale, invoicesPaidOnArc: 4 * scale, invoicesPaidOnTime: 3 * scale, invoicesPaidOnTimeUntouched: 2 * scale,
  duplicatesCaught: 0,
});

/** The cells of the row whose label is `label`, in column order. */
function cellsOf(markup: string, label: string): string[] {
  const row = markup.slice(markup.indexOf(`${label}</th>`));
  return [...row.slice(0, row.indexOf("</tr>")).matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((match) => text(match[1]));
}

const NUMBERS: OpenNumbers = {
  generatedAt: "2026-09-30T12:00:00+00:00",
  sides: { customers: side(1), ours: side(2), total: side(3) },
  daily: [{ day: "2026-09-28", customers: 1, ours: 2, oursUsdc: 3 }],
  ourPayments: [
    { at: "2026-09-27T10:00:00+00:00", amount: 2, txHash: "0xabc1234567890def", chain: "ARC-TESTNET" },
    { at: "2026-09-27T09:00:00+00:00", amount: 5, token: "EURC", txHash: "0xeurc567890abcdef", chain: "ARC-TESTNET" },
  ],
};

async function render(params: Record<string, string> = {}) {
  return renderToStaticMarkup(await OpenPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  vi.mocked(readOpenNumbers).mockReset();
  vi.mocked(readOpenNumbers).mockResolvedValue(NUMBERS);
});

describe("the /open page", () => {
  it("is public, titled, and canonical at /open", () => {
    expect(requiresSession("/open")).toBe(false);
    expect(metadata.title).toBe("Open numbers");
    expect(metadata.alternates?.canonical).toBe("/open");
  });

  it("shows every row for customers, our workspaces and the total", async () => {
    const markup = await render();
    const page = text(markup);
    const table = markup.slice(markup.indexOf("<table"), markup.indexOf("</table>"));
    const columns = [...table.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((match) => text(match[1]));
    expect(columns).toEqual(["Figure", "Customers", "Our workspaces", "Total"]);
    for (const row of OPEN_ROWS) expect(page).toContain(row.label);
    expect(table.match(/<th scope="row"/g)).toHaveLength(OPEN_ROWS.length);
    // Each label says no more than its figure counts: milestones paid by a settled Arc payment; refusals by code,
    // whichever path proposed the decision.
    expect(OPEN_ROWS.find((row) => row.key === "milestonesReleased")?.label).toBe("Contractor milestones paid on Arc testnet");
    expect(OPEN_ROWS.find((row) => row.key === "refusedByCode")?.label).toBe("Decisions refused by code");
  });

  it("shows the first payments and the median time to one, with a dash where there is none", async () => {
    const markup = await render();
    expect(cellsOf(markup, "Median time from workspace opened to first payment")).toEqual(["1 h 35 min", "—", "4 h 45 min"]);
    expect(text(markup)).toContain("Workspaces that made a first payment on Arc testnet");
  });

  it("shows how the agent's payment decisions turned out, in a table of their own", async () => {
    const markup = await render();
    const page = text(markup);
    expect(page).toContain("Outcomes");
    for (const row of OUTCOME_ROWS) expect(page).toContain(row.label);
    expect(markup.match(/<table/g)).toHaveLength(3); // usage, outcomes, and the chart's table view
    expect(cellsOf(markup, "Payment decisions the agent carried out itself")).toEqual(["3", "6", "9"]);
    expect(cellsOf(markup, "Decided by the agent itself")).toEqual(["75%", "75%", "75%"]);
    expect(cellsOf(markup, "Agent flags a person upheld")).toEqual(["1 of 2", "2 of 4", "3 of 6"]);
    expect(cellsOf(markup, "Invoices paid on time on Arc testnet")).toEqual(["3 of 4", "6 of 8", "9 of 12"]);
    expect(cellsOf(markup, "Paid on time with no person involved")).toEqual(["2 of 4", "4 of 8", "6 of 12"]);
    expect(cellsOf(markup, "Duplicate invoices caught")).toEqual(["0", "0", "0"]);
  });

  it("shows dashes for the outcomes when they could not be read", async () => {
    const blank = Object.fromEntries(
      ["decisionsCarriedOut", "decisionsEscalated", "escalationsResolved", "flagsResolved", "flagsUpheld", "invoicesPaidOnArc",
        "invoicesPaidOnTime", "invoicesPaidOnTimeUntouched", "duplicatesCaught"].map((key) => [key, null])
    );
    const sides = { customers: { ...side(1), ...blank }, ours: { ...side(2), ...blank }, total: { ...side(3), ...blank } };
    vi.mocked(readOpenNumbers).mockResolvedValue({ ...NUMBERS, sides });
    const markup = await render();
    for (const row of OUTCOME_ROWS) expect(cellsOf(markup, row.label)).toEqual(["—", "—", "—"]);
    expect(cellsOf(markup, "Payments settled on Arc testnet")).toEqual(["4", "8", "12"]);
  });

  it("writes a share as a whole percent and a ratio as x of y, with a dash when there is nothing to measure", () => {
    const share = OUTCOME_ROWS.find((row) => row.format === "percent")!;
    const onTime = OUTCOME_ROWS.find((row) => row.label === "Invoices paid on time on Arc testnet")!;
    expect(formatRow({ ...side(1), decisionsCarriedOut: 2, decisionsEscalated: 1 }, share)).toBe("67%");
    expect(formatRow({ ...side(1), decisionsCarriedOut: 0, decisionsEscalated: 0 }, share)).toBe("—");
    expect(formatRow({ ...side(1), invoicesPaidOnTime: 0, invoicesPaidOnArc: 0 }, onTime)).toBe("—");
    expect(formatRow({ ...side(1), invoicesPaidOnTime: 0, invoicesPaidOnArc: 3 }, onTime)).toBe("0 of 3");
    expect(formatRow({ ...side(1), invoicesPaidOnTime: null, invoicesPaidOnArc: 3 }, onTime)).toBe("—");
  });

  it("writes a duration in minutes, hours or days", () => {
    expect(formatFigure(null, "duration")).toBe("—");
    expect(formatFigure(0, "duration")).toBe("0 min");
    expect(formatFigure(12.6, "duration")).toBe("13 min");
    expect(formatFigure(60, "duration")).toBe("1 h 0 min");
    expect(formatFigure(1439, "duration")).toBe("23 h 59 min");
    expect(formatFigure(1440, "duration")).toBe("1 d 0 h");
    expect(formatFigure(7290, "duration")).toBe("5 d 1 h");
    expect(formatFigure(3, "count")).toBe("3");
  });

  it("writes USDC with two decimals and marks today's totals as now", async () => {
    const page = text(await render());
    expect(page).toContain("1,234.50");
    expect(page).toContain("3,703.50");
    const nowRows = OPEN_ROWS.filter((row) => row.kind === "now");
    expect(nowRows.map((row) => row.key)).toEqual(["liveWorkspaces", "people", "usdcInWallets"]);
    expect(page.match(/\bnow\b/g)?.length).toBeGreaterThanOrEqual(nowRows.length);
  });

  it("asks for the period in the query and marks it in the period links", async () => {
    const markup = await render({ period: "7d" });
    expect(vi.mocked(readOpenNumbers).mock.calls[0][0]).toMatchObject({ key: "7d" });
    expect(markup).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/open\?period=7d"|<a[^>]*href="\/open\?period=7d"[^>]*aria-current="page"/);
    expect(text(markup)).toContain("Last 7 days");
  });

  it("says so when the period could not be read", async () => {
    const page = text(await render({ since: "2031-01-01" }));
    expect(page).toContain("That period could not be read, so this shows all time.");
    expect(vi.mocked(readOpenNumbers).mock.calls[0][0]).toMatchObject({ key: "all", fallback: true });
  });

  it("links our own payments to arcscan, and says customers' are counted but not listed", async () => {
    const markup = await render();
    expect(markup).toContain('href="https://testnet.arcscan.app/tx/0xabc1234567890def"');
    expect(text(markup)).toContain("counted above and never listed");
  });

  it("draws the settled payments by day, with a legend and a table view", async () => {
    const markup = await render();
    expect(markup).toContain('role="img"');
    // On a phone the chart keeps a legible width and scrolls inside a focusable region, never the page.
    expect(markup).toMatch(/<div role="region" aria-label="Settled payments by day, chart" tabindex="0" class="[^"]*overflow-x-auto[^"]*"><svg[^>]*class="[^"]*min-w-\[40rem\]/);
    const page = text(markup);
    expect(page).toContain("Settled payments by day");
    expect(page).toContain("Sep 28, 2026");
    expect(markup).toContain("<details");
    // A customer's amounts never appear by day, in the tooltip or the table view.
    const details = markup.slice(markup.indexOf("<details"));
    const dayColumns = [...details.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((match) => text(match[1]));
    expect(dayColumns).toEqual(["Day", "Customers", "Our workspaces", "USDC"]);
    expect(markup).toContain("<title>Sep 28, 2026: 1 by customers, 2 by our workspaces (3.00 USDC)</title>");
  });

  it("shows an empty chart state when nothing was paid", async () => {
    vi.mocked(readOpenNumbers).mockResolvedValue({ ...NUMBERS, daily: [], ourPayments: [] });
    const markup = await render();
    expect(markup).not.toContain('role="img"');
    expect(text(markup)).toContain("No payment settled in this period.");
  });

  it("still renders, without figures, when the numbers cannot be read", async () => {
    vi.mocked(readOpenNumbers).mockRejectedValue(new Error("function open_numbers does not exist"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const markup = await render();
    errors.mockRestore();
    expect(text(markup)).toContain("The numbers could not be read right now.");
    expect(markup).not.toContain("<table");
    expect(markup).not.toContain("open_numbers does not exist");
  });
});

describe("the privacy page", () => {
  it("says the open numbers publish counts and totals only, and never a customer's payment", async () => {
    const { default: PrivacyPage } = await import("@/app/privacy/page");
    const page = text(renderToStaticMarkup(<PrivacyPage />));
    expect(page).toContain("open numbers page shows counts and totals across all workspaces");
    expect(page).toContain("never lists a customer's payment");
  });
});

describe("our payments in EURC (review I2)", () => {
  it("lists a EURC payment in EURC, and one with no token as USDC", async () => {
    const page = text(await render());
    expect(page).toContain("5.00 EURC");
    expect(page).toContain("2.00 USDC");
  });
});
