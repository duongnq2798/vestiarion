import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OpenPage, { metadata } from "@/app/open/page";
import { DECIDED_BY_AGENT, FIGURE_GROUPS, FIGURE_ROWS, formatFigure, formatRow } from "@/components/open/OpenNumbersTable";
import { requiresSession } from "@/lib/auth/routes";
import { readOpenNumbers, type OpenNumbers } from "@/lib/platform/open-numbers";

vi.mock("@/lib/platform/open-numbers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/open-numbers")>();
  return { ...actual, readOpenNumbers: vi.fn() };
});

/**
 * The public /open page (docs/superpowers/specs/2026-09-30-open-numbers-design.md
 * §2): customers' headline figures with the total beside them, how the agent
 * performs, the checks between a model and the money, the payments chart, our
 * own payments with explorer links, every figure in one table with customers,
 * ours and the total, and the method. The figures come from readOpenNumbers,
 * faked here; parsePeriod and dailySeries are the real ones.
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

/** A no-break space: a figure's number and unit, or a ratio, stay on one line in a narrow table. */
const NB = " ";

/** The full figures table: customers, ours and the total, every row. */
function figureTable(markup: string): string {
  const from = markup.slice(markup.indexOf('aria-label="Every figure"'));
  return from.slice(0, from.indexOf("</table>"));
}

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

/** A network with nothing in it: no workspace, no payment (network foundation N7). */
const zero = () => ({ ...side(0), medianMinutesToFirstPayment: null });
const EMPTY: OpenNumbers = { generatedAt: "2026-09-30T12:00:00+00:00", sides: { customers: zero(), ours: zero(), total: zero() }, daily: [], ourPayments: [] };

/** Each network's figures, as the page asks for them. */
function byNetwork(numbers: { mainnet: OpenNumbers | Error; testnet: OpenNumbers | Error }) {
  vi.mocked(readOpenNumbers).mockImplementation(async (_period, network) => {
    const answer = network === "arc-mainnet" ? numbers.mainnet : numbers.testnet;
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

/** The markup of one network's section, up to the next network's or the method. */
function sectionOf(markup: string, id: "mainnet" | "testnet"): string {
  const start = markup.indexOf(`<section aria-labelledby="${id}"`);
  const next = markup.slice(start + 1).search(/<section aria-labelledby="(mainnet|testnet|method)"/);
  return markup.slice(start, next === -1 ? undefined : start + 1 + next);
}

beforeEach(() => {
  vi.mocked(readOpenNumbers).mockReset();
  byNetwork({ mainnet: EMPTY, testnet: NUMBERS });
});

describe("the /open page", () => {
  it("is public, titled, and canonical at /open", () => {
    expect(requiresSession("/open")).toBe(false);
    expect(metadata.title).toBe("Open numbers");
    expect(metadata.alternates?.canonical).toBe("/open");
  });

  it("shows every row for customers, our workspaces and the total", async () => {
    const markup = await render();
    const table = figureTable(markup);
    const columns = [...table.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((match) => text(match[1]));
    expect(columns).toEqual(["Figure", "Customers", "Our workspaces", "Total"]);
    for (const row of FIGURE_ROWS) expect(text(table)).toContain(row.label);
    expect(table.match(/<th scope="row"/g)).toHaveLength(FIGURE_ROWS.length);
    // Grouped by what the figures say, each group headed in the table.
    const groups = [...table.matchAll(/<th scope="rowgroup"[^>]*>(.*?)<\/th>/g)].map((match) => text(match[1]));
    expect(groups).toEqual(FIGURE_GROUPS.map((group) => group.title));
    expect(groups).toEqual(["Adoption", "Money moved", "Agent activity", "Outcomes", "Safety and controls"]);
    // Each label says no more than its figure counts: milestones paid by a settled Arc payment; refusals by code,
    // whichever path proposed the decision.
    // Each section names its network, so no row does (network foundation N7).
    expect(FIGURE_ROWS.find((row) => row.key === "milestonesReleased")?.label).toBe("Contractor milestones paid");
    for (const row of FIGURE_ROWS) expect(row.label).not.toMatch(/Arc testnet|Arc mainnet/);
    expect(FIGURE_ROWS.find((row) => row.key === "refusedByCode")?.label).toBe("Decisions refused by code");
    // A disagreement is measured against the written policy, which the model's choice must still pass in code.
    expect(FIGURE_ROWS.find((row) => row.key === "policyDepartures")?.label).toBe("Model disagreed with the written policy");
  });

  it("shows the first payments and the median time to one, with a dash where there is none", async () => {
    const markup = await render();
    expect(cellsOf(markup, "Median time from workspace opened to first payment")).toEqual(["1 h 35 min", "—", "4 h 45 min"]);
    expect(text(markup)).toContain("Workspaces that made a first payment");
  });

  it("shows how the agent's payment decisions turned out in the figures table", async () => {
    const markup = await render();
    expect(text(markup)).toContain("Outcomes");
    expect(markup.match(/<table/g)).toHaveLength(2); // every figure, and the chart's table view
    expect(cellsOf(markup, "Payment decisions the agent carried out itself")).toEqual(["3", "6", "9"]);
    expect(cellsOf(markup, "Decided by the agent itself")).toEqual(["75%", "75%", "75%"]);
    expect(cellsOf(markup, "Agent flags a person upheld")).toEqual(["1 of 2", "2 of 4", "3 of 6"]);
    expect(cellsOf(markup, "Invoices paid on time")).toEqual(["3 of 4", "6 of 8", "9 of 12"]);
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
    const outcomes = ["decisionsCarriedOut", "decisionsEscalated", "escalationsResolved", "flagsUpheld", "invoicesPaidOnTime", "invoicesPaidOnTimeUntouched", "duplicatesCaught"];
    for (const row of FIGURE_ROWS.filter((row) => outcomes.includes(row.key))) expect(cellsOf(markup, row.label)).toEqual(["—", "—", "—"]);
    // The agent's cards say there is nothing to measure rather than show a share of nothing.
    expect(text(markup)).toContain("Nothing to measure yet");
    expect(cellsOf(markup, "Payments settled")).toEqual(["4", "8", "12"]);
  });

  it("writes a share as a whole percent and a ratio as x of y, with a dash when there is nothing to measure", () => {
    const share = DECIDED_BY_AGENT;
    const onTime = FIGURE_ROWS.find((row) => row.label === "Invoices paid on time")!;
    expect(formatRow({ ...side(1), decisionsCarriedOut: 2, decisionsEscalated: 1 }, share)).toBe("67%");
    expect(formatRow({ ...side(1), decisionsCarriedOut: 0, decisionsEscalated: 0 }, share)).toBe("—");
    expect(formatRow({ ...side(1), invoicesPaidOnTime: 0, invoicesPaidOnArc: 0 }, onTime)).toBe("—");
    // A ratio never breaks across lines.
    expect(formatRow({ ...side(1), invoicesPaidOnTime: 0, invoicesPaidOnArc: 3 }, onTime)).toBe(`0${NB}of${NB}3`);
    expect(formatRow({ ...side(1), invoicesPaidOnTime: null, invoicesPaidOnArc: 3 }, onTime)).toBe("—");
  });

  it("writes a duration in minutes, hours or days, each number kept with its unit", () => {
    expect(formatFigure(null, "duration")).toBe("—");
    expect(formatFigure(0, "duration")).toBe(`0${NB}min`);
    expect(formatFigure(12.6, "duration")).toBe(`13${NB}min`);
    expect(formatFigure(60, "duration")).toBe(`1${NB}h 0${NB}min`);
    expect(formatFigure(1439, "duration")).toBe(`23${NB}h 59${NB}min`);
    expect(formatFigure(1440, "duration")).toBe(`1${NB}d 0${NB}h`);
    expect(formatFigure(7290, "duration")).toBe(`5${NB}d 1${NB}h`);
    expect(formatFigure(3, "count")).toBe("3");
  });

  it("writes USDC with two decimals and marks today's totals as now", async () => {
    const page = text(await render());
    expect(page).toContain("1,234.50");
    expect(page).toContain("3,703.50");
    const nowRows = FIGURE_ROWS.filter((row) => row.kind === "now");
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

  it("links our own payments to Arc's explorer, and says customers' are counted but not listed", async () => {
    const markup = await render();
    expect(markup).toContain('href="https://explorer.testnet.arc.io/tx/0xabc1234567890def"');
    expect(text(markup)).toContain("counted above and never listed");
  });

  it("lists the newest five of our payments, and folds the rest away", async () => {
    const payments = Array.from({ length: 8 }, (_, index) => ({
      at: `2026-09-27T1${index}:00:00+00:00`, amount: index + 1, txHash: `0x${String(index).repeat(16)}`, chain: "ARC-TESTNET",
    }));
    vi.mocked(readOpenNumbers).mockResolvedValue({ ...NUMBERS, ourPayments: payments });
    const markup = await render();
    const list = markup.slice(markup.indexOf('aria-labelledby="our-payments-arc-testnet"'));
    const shown = list.slice(0, list.indexOf("<details"));
    expect(shown.match(/explorer\.testnet\.arc\.io\/tx\//g)).toHaveLength(5);
    expect(text(list)).toContain("Show 3 more");
    for (const payment of payments) expect(markup).toContain(`/tx/${payment.txHash}"`);
  });

  it("leads with customers' figures, each with the total that includes our own workspaces", async () => {
    const markup = await render();
    const customers = markup.slice(markup.indexOf('aria-labelledby="customers-arc-testnet"'), markup.indexOf('aria-labelledby="agent-arc-testnet"'));
    const page = text(customers);
    expect(page).toContain("Real customer usage");
    // Customers' 4 payments, with the 12 that include ours beside them; their median, with the total's.
    expect(page).toMatch(/Payments settled 4 Confirmed by Circle on Arc testnet\. With our workspaces: 12/);
    // text() folds the no-break spaces inside a duration into spaces.
    expect(page).toMatch(/Median time to first payment 1 h 35 min From opening a workspace to its first settled payment\. With our workspaces: 4 h 45 min/);
    expect(page).toContain("1,234.50 USDC");
    expect(page).toContain("never listed one by one");
    // The headline comes before the agent's figures, and both before the full table.
    expect(markup.indexOf("Real customer usage")).toBeLessThan(markup.indexOf("How the agent performs"));
    expect(markup.indexOf("How the agent performs")).toBeLessThan(markup.indexOf('aria-label="Every figure"'));
  });

  it("shows the agent's shares across every workspace, with customers' own beneath", async () => {
    const page = text(await render());
    // 9 carried out of 12 decided across every workspace; customers' 3 of 4.
    expect(page).toMatch(/Decided by the agent itself 75% 9 of 12 payment decisions/);
    expect(page).toContain("Customers: 75% (3 of 4)");
    expect(page).toMatch(/Invoices paid on time 75% 9 of 12 invoices paid/);
    expect(page).toMatch(/Agent flags upheld 50% 3 of 6 flags a person decided/);
  });

  it("counts each check between a model and the money, the uncomfortable ones too", async () => {
    const markup = await render();
    const controls = text(markup.slice(markup.indexOf('aria-labelledby="controls-arc-testnet"'), markup.indexOf('aria-labelledby="payments-by-day-arc-testnet"')));
    expect(controls).toMatch(/A model proposes 27 decisions made by a model In 21 agent cycles, deciding 15 invoices\./);
    expect(controls).toMatch(/Compared with the written policy 3 times the model disagreed/);
    expect(controls).toMatch(/Hard limits in code 3 decisions refused by code/);
    expect(controls).toContain("0 duplicate invoices caught before payment.");
    expect(controls).toMatch(/A person when it matters 3 decisions escalated to a person 3 resolved by a person so far\./);
    expect(controls).toMatch(/Settles on Arc testnet 12 payments settled 3 of them paid contractor milestones\./);
  });

  it("folds the method into groups, every definition still on the page", async () => {
    const markup = await render();
    const method = markup.slice(markup.indexOf('<section aria-labelledby="method"'));
    const groups = [...method.matchAll(/<summary[^>]*>(.*?)<\/summary>/g)].map((match) => text(match[1]));
    expect(groups).toEqual(["Networks, periods and freshness", "Customers and our workspaces", "Payments and money", "The agent's decisions", "What is never shown"]);
    expect(method).not.toMatch(/<details[^>]*\sopen/);
    expect(text(method)).toContain("A decision is refused by code when a hard limit blocked it, whether a model or the written policy proposed it.");
  });

  it("draws the settled payments by day, with a legend and a table view", async () => {
    const markup = await render();
    expect(markup).toContain('role="img"');
    // On a phone the chart keeps a legible width and scrolls inside a focusable region, never the page.
    expect(markup).toMatch(/<div role="region" aria-label="Settled payments by day on Arc testnet, chart" tabindex="0" class="[^"]*overflow-x-auto[^"]*"><svg[^>]*class="[^"]*min-w-\[40rem\]/);
    const page = text(markup);
    expect(page).toContain("Settled payments by day");
    expect(page).toContain("Sep 28, 2026");
    expect(markup).toContain("<details");
    // A customer's amounts never appear by day, in the tooltip or the table view.
    const from = markup.slice(markup.indexOf('aria-label="Settled payments by day, as a table"'));
    const details = from.slice(0, from.indexOf("</table>"));
    const dayColumns = [...details.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((match) => text(match[1]));
    expect(dayColumns).toEqual(["Day", "Customers", "Our workspaces", "USDC"]);
    expect(markup).toContain("<title>Sep 28, 2026: 1 by customers, 2 by our workspaces (3.00 USDC)</title>");
  });

  it("shows an empty chart state when nothing was paid", async () => {
    vi.mocked(readOpenNumbers).mockResolvedValue({ ...NUMBERS, daily: [], ourPayments: [] });
    const markup = await render();
    expect(markup).not.toContain('role="img"');
    expect(text(markup)).toContain("No payment settled in this period.");
    expect(text(markup)).not.toContain("Latest payment settled on");
  });

  it("still renders, without figures, when the numbers cannot be read", async () => {
    byNetwork({ mainnet: new Error("function open_numbers does not exist"), testnet: new Error("function open_numbers does not exist") });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const markup = await render();
    errors.mockRestore();
    expect(text(markup)).toContain("The Arc mainnet numbers could not be read right now.");
    expect(text(markup)).toContain("The Arc testnet numbers could not be read right now.");
    expect(markup).not.toContain("<table");
    expect(markup).not.toContain("open_numbers does not exist");
  });
});

describe("the /open page, one network at a time (network foundation N7)", () => {
  /** The networks' headings, in page order. */
  const networkHeadings = (markup: string) => [...markup.matchAll(/<h2 id="(mainnet|testnet)"[^>]*>(.*?)<\/h2>/g)].map((match) => text(match[2]));

  it("leads with a network that has figures, and puts an empty one after it, each in a section of its own", async () => {
    const markup = await render();
    expect(networkHeadings(markup)).toEqual(["Arc testnet", "Arc mainnet"]);
    expect(vi.mocked(readOpenNumbers).mock.calls.map((call) => call[1]).sort()).toEqual(["arc-mainnet", "arc-testnet"]);
    expect(text(markup)).toContain("Latest payment settled on Sep 28, 2026");
  });

  it("shows Arc mainnet first once both networks have figures", async () => {
    byNetwork({ mainnet: NUMBERS, testnet: NUMBERS });
    expect(networkHeadings(await render())).toEqual(["Arc mainnet", "Arc testnet"]);
  });

  it("says no workspace runs on Arc mainnet yet, rather than show a table of zeros", async () => {
    const markup = await render();
    const mainnet = sectionOf(markup, "mainnet");
    expect(text(mainnet)).toContain("No workspace runs on Arc mainnet yet.");
    expect(mainnet).not.toContain("<table");
    expect(sectionOf(markup, "testnet")).toContain("<table");
  });

  it("shows Arc mainnet's own figures when it has some, never added to Arc testnet's", async () => {
    byNetwork({ mainnet: { ...NUMBERS, sides: { customers: side(10), ours: side(20), total: side(30) }, daily: [], ourPayments: [] }, testnet: NUMBERS });
    const markup = await render();
    expect(cellsOf(sectionOf(markup, "mainnet"), "Payments settled")).toEqual(["40", "80", "120"]);
    expect(cellsOf(sectionOf(markup, "testnet"), "Payments settled")).toEqual(["4", "8", "12"]);
  });

  it("keeps Arc testnet's figures when Arc mainnet's cannot be read", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    byNetwork({ mainnet: new Error("function open_numbers does not exist"), testnet: NUMBERS });
    const markup = await render();
    errors.mockRestore();
    expect(text(sectionOf(markup, "mainnet"))).toContain("The Arc mainnet numbers could not be read right now.");
    expect(cellsOf(sectionOf(markup, "testnet"), "Payments settled")).toEqual(["4", "8", "12"]);
  });

  it("says in what counts that the two networks are counted apart", async () => {
    const page = text(await render());
    expect(page).toContain("Arc mainnet and Arc testnet are counted apart, and nothing is ever added across them.");
    expect(page).not.toContain("A payment counts once Circle confirms it on Arc testnet.");
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
