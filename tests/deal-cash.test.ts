import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cashBadge, dealCashReadiness, depositLever, percentWords, tryDeposit } from "@/lib/deals/cash";
import { costCount, readCostForm, type CostLink, type DealCost } from "@/lib/deals/costs";
import type { DealFacts, DealLine } from "@/lib/deals/lines";

/**
 * A deal's cash readiness (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md K2-K8). Three deals where a
 * person reads the right short day off the view: a contractor paid before the deposit arrives, a bill that lands after
 * the deposit, and a deal that paid out more than it collected; then the margin, money counted once, the deposit try and
 * the badge.
 */

const TODAY = "2026-10-13";
const DEAL = "dddddddd-0000-4000-8000-0000000000d1";

const line = (n: number, over: Partial<DealLine>): DealLine => ({
  id: `11111111-0000-4000-8000-00000000000${n}`,
  position: n,
  kind: "charge",
  label: `Line ${n}`,
  invoiceOn: "2026-10-13",
  dueOn: "2026-10-27",
  amountMinor: 0,
  roundingMinor: 0,
  status: "planned",
  addedIn: 1,
  endedIn: null,
  replaces: null,
  releasedAt: null,
  releasedVia: null,
  receivable: null,
  ...over,
});

const facts = (lines: DealLine[], over: Partial<DealFacts> = {}): DealFacts => ({
  id: DEAL,
  status: "active",
  version: 1,
  totalMinor: lines.reduce((sum, each) => sum + each.amountMinor, 0),
  currency: "USDC",
  startsOn: "2026-10-05",
  termsDays: 14,
  autoRelease: false,
  lines,
  ...over,
});

const cost = (n: number, over: Partial<DealCost>): DealCost => ({
  id: `22222222-0000-4000-8000-00000000000${n}`,
  label: `Cost ${n}`,
  counterparty: null,
  amountMinor: 0,
  expectedOn: TODAY,
  noDocument: false,
  createdAt: `2026-10-1${n}T09:00:00Z`,
  createdBy: null,
  removedAt: null,
  link: null,
  ...over,
});

const bill = (over: Partial<Extract<CostLink, { kind: "payable" }>>): CostLink => ({
  kind: "payable",
  id: "33333333-0000-4000-8000-000000000001",
  counterpartyName: "Northwind Hosting",
  memo: null,
  status: "pending",
  dueOn: "2026-11-03",
  scheduledFor: null,
  settledOn: null,
  amountMinor: 0,
  paidMinor: null,
  ...over,
});

/** A 12,000.00 USDC deal: a 30% deposit invoiced today and due in 14 days, the balance on Dec 1. */
const depositDeal = (over: { deposit?: Partial<DealLine>; balance?: Partial<DealLine> } = {}) =>
  facts([
    line(1, { label: "Deposit (30%)", invoiceOn: "2026-10-13", dueOn: "2026-10-27", amountMinor: 360_000, ...over.deposit }),
    line(2, { label: "Balance on delivery", invoiceOn: "2026-12-01", dueOn: "2026-12-15", amountMinor: 840_000, ...over.balance }),
  ]);

const read = (dealFacts: DealFacts, costs: DealCost[] | null) => dealCashReadiness({ facts: dealFacts, digits: 2 }, costs, TODAY);

describe("the short day", () => {
  it("fixture 1: a contractor paid on Oct 20, before the deposit arrives on Oct 27, is short by 1,240.00 USDC on Oct 20", () => {
    const costs = [
      cost(1, { label: "Contractor: design", amountMinor: 124_000, expectedOn: "2026-10-20", noDocument: true }),
      cost(2, { label: "Hosting setup", amountMinor: 100_000, expectedOn: "2026-11-05" }),
    ];
    const readiness = read(depositDeal(), costs);
    expect(readiness.short).toEqual({ day: "2026-10-20", byMinor: 124_000, deepest: { day: "2026-10-20", byMinor: 124_000 } });
    expect(cashBadge(readiness, "active")).toEqual({ label: "Short 1,240.00 USDC on Oct 20, 2026", tone: "held" });
    expect(readiness.days.map((day) => [day.day, day.inMinor, day.outMinor, day.positionMinor])).toEqual([
      ["2026-10-20", 0, 124_000, -124_000],
      ["2026-10-27", 360_000, 0, 236_000],
      ["2026-11-05", 0, 100_000, 136_000],
      ["2026-12-15", 840_000, 0, 976_000],
    ]);
    // Each figure says where it comes from: the cost's day and that no document backs it, the line's invoice and due days.
    expect(readiness.days[0].items[0]).toMatchObject({ source: "cost", kind: "planned", noDocument: true, basis: "planned for Oct 20, 2026, no document yet" });
    expect(readiness.days[1].items[0]).toMatchObject({ source: "line", kind: "planned", basis: "Planned line, invoiced Oct 13, 2026, due Oct 27, 2026" });
    expect(readiness.in).toEqual({ plannedMinor: 1_200_000, expectedMinor: 0 });
  });

  it("fixture 2: after a paid deposit and a paid contractor, a bill due Nov 3 makes it short by 1,400.00 USDC that day, and deepest on Nov 20", () => {
    const deal = depositDeal({
      deposit: { status: "released", releasedAt: "2026-10-05T09:00:00Z", releasedVia: "person", receivable: { id: "r1", status: "received", dueDate: "2026-10-19T00:00:00Z" } },
    });
    const costs = [
      // Planned at 2,000.00; its bill was paid.
      cost(1, { label: "Contractor: design", amountMinor: 200_000, expectedOn: "2026-10-10", link: bill({ id: "b1", status: "paid", amountMinor: 200_000, paidMinor: 200_000, settledOn: "2026-10-11" }) }),
      // Planned at 2,500.00; its bill is 3,000.00 and due Nov 3: the bill counts, once.
      cost(2, { label: "Vendor: printing", amountMinor: 250_000, expectedOn: "2026-11-01", link: bill({ id: "b2", status: "held", amountMinor: 300_000, dueOn: "2026-11-03" }) }),
      cost(3, { label: "Courier", amountMinor: 50_000, expectedOn: "2026-11-20" }),
    ];
    const readiness = read(deal, costs);
    expect(readiness.collected).toEqual({ totalMinor: 360_000, lines: [{ id: deal.lines[0].id, label: "Deposit (30%)", amountMinor: 360_000 }] });
    expect(readiness.paidOut.totalMinor).toBe(200_000);
    expect(readiness.toDateMinor).toBe(160_000);
    expect(readiness.short).toEqual({ day: "2026-11-03", byMinor: 140_000, deepest: { day: "2026-11-20", byMinor: 190_000 } });
    const billDay = readiness.days.find((day) => day.day === "2026-11-03");
    expect(billDay?.items).toEqual([expect.objectContaining({ kind: "due", amountMinor: 300_000, basis: "Bill from Northwind Hosting, due Nov 3, 2026 (planned at 2,500.00 USDC)" })]);
    // The bill's 3,000.00, never also the planned 2,500.00.
    expect(readiness.days.flatMap((day) => day.items).filter((item) => item.id === costs[1].id)).toHaveLength(1);
    expect(readiness.out).toEqual({ plannedMinor: 50_000, dueMinor: 300_000 });
  });

  it("fixture 3: more paid out than collected, and an overdue receivable counted today, is short by 1,400.00 USDC today", () => {
    const deal = depositDeal({
      deposit: { invoiceOn: "2026-09-20", dueOn: "2026-10-04", status: "released", releasedAt: "2026-09-20T09:00:00Z", releasedVia: "person", receivable: { id: "r1", status: "pending", dueDate: "2026-10-04T00:00:00Z" } },
    });
    const costs = [cost(1, { label: "Equipment", amountMinor: 500_000, expectedOn: "2026-10-01", link: bill({ status: "paid", amountMinor: 500_000, settledOn: "2026-10-02" }) })];
    const readiness = read(deal, costs);
    expect(readiness.toDateMinor).toBe(-500_000);
    expect(readiness.days[0]).toMatchObject({ day: TODAY, inMinor: 360_000, outMinor: 0, positionMinor: -140_000 });
    expect(readiness.days[0].items[0]).toMatchObject({ kind: "expected", late: true, basis: "Invoiced, due Oct 4, 2026, overdue: counted today" });
    expect(readiness.short).toEqual({ day: TODAY, byMinor: 140_000, deepest: { day: TODAY, byMinor: 140_000 } });
  });

  it("is short today, from what moved to date, when nothing moves today", () => {
    const costs = [cost(1, { amountMinor: 50_000, link: bill({ status: "paid", amountMinor: 50_000 }) })];
    expect(read(depositDeal(), costs).short).toEqual({ day: TODAY, byMinor: 50_000, deepest: { day: TODAY, byMinor: 50_000 } });
  });

  it("finds no gap when the deposit arrives before any cost leaves", () => {
    const readiness = read(depositDeal(), [cost(1, { amountMinor: 300_000, expectedOn: "2026-10-28" })]);
    expect(readiness.short).toBeNull();
    expect(cashBadge(readiness, "active")).toEqual({ label: "No cash gap", tone: "proof" });
  });
});

describe("the margin", () => {
  it("is not enough data with no cost entered, never 100%", () => {
    const readiness = read(depositDeal(), []);
    expect(readiness.margin).toEqual({ state: "not_enough_data", why: "no_costs" });
    expect(cashBadge(readiness, "active")).toEqual({ label: "No costs entered", tone: "neutral" });
    expect(read(depositDeal(), null).margin).toEqual({ state: "not_enough_data", why: "costs_unread" });
    expect(cashBadge(read(depositDeal(), null), "active")).toBeNull();
  });

  it("is the total less every cost counted, a removed one left out and a linked one at its bill's amount", () => {
    const costs = [
      cost(1, { amountMinor: 200_000, noDocument: true }),
      cost(2, { amountMinor: 250_000, link: bill({ amountMinor: 300_000 }) }),
      cost(3, { amountMinor: 900_000, removedAt: "2026-10-12T10:00:00Z" }),
    ];
    expect(read(depositDeal(), costs).margin).toEqual({
      state: "estimated",
      totalMinor: 1_200_000,
      costsMinor: 500_000,
      marginMinor: 700_000,
      basisPoints: 5833,
      costCount: 2,
      withoutDocument: 1,
    });
    expect(percentWords(5833)).toBe("58.33%");
  });

  it("counts a credit owed to the customer in the total, never as money in or out", () => {
    const deal = facts([...depositDeal().lines, line(3, { kind: "credit", label: "Credit for price change", amountMinor: -50_000, addedIn: 2 })]);
    const readiness = read(deal, [cost(1, { amountMinor: 100_000 })]);
    expect(readiness.creditMinor).toBe(-50_000);
    expect(readiness.days.flatMap((day) => day.items).some((item) => item.label === "Credit for price change")).toBe(false);
    expect(readiness.margin).toMatchObject({ totalMinor: 1_150_000, marginMinor: 1_050_000 });
  });
});

describe("a cost counted once", () => {
  it("counts a rejected bill or a closed milestone as the plan again, and a scheduled bill on its day", () => {
    const rejected = cost(1, { amountMinor: 100_000, expectedOn: "2026-10-30", link: bill({ status: "rejected", amountMinor: 120_000 }) });
    expect(costCount(rejected, TODAY)).toEqual({ as: "planned", day: "2026-10-30", late: false, amountMinor: 100_000, again: "rejected" });
    const closed = cost(2, { amountMinor: 80_000, expectedOn: "2026-10-01", link: { kind: "milestone", id: "m1", title: "Design", contractorName: "Ana", status: "closed", settledOn: null, amountMinor: 80_000 } });
    expect(costCount(closed, TODAY)).toEqual({ as: "planned", day: TODAY, late: true, amountMinor: 80_000, again: "closed" });
    const scheduled = cost(3, { amountMinor: 100_000, link: bill({ status: "scheduled", scheduledFor: "2026-10-25", dueOn: "2026-10-31", amountMinor: 100_000 }) });
    expect(costCount(scheduled, TODAY)).toEqual({ as: "due", day: "2026-10-25", late: false, amountMinor: 100_000, scheduled: true });
  });
});

describe("trying another deposit", () => {
  const costs = [cost(1, { label: "Contractor: design", amountMinor: 124_000, expectedOn: "2026-10-20" })];

  it("moves the deposit's day: invoiced on the start, it is due Oct 19, before the contractor, and the gap is gone", () => {
    const deal = depositDeal();
    expect(depositLever(deal)).toMatchObject({ label: "Deposit (30%)", basisPoints: 3000, chargesMinor: 1_200_000 });
    const tried = tryDeposit(deal, { depositOn: "2026-10-05" }, 2);
    expect(tried.ok).toBe(true);
    if (!tried.ok) return;
    expect(tried.changes).toEqual(["Deposit (30%): invoiced Oct 5, 2026 and due Oct 19, 2026, not Oct 13, 2026 and Oct 27, 2026"]);
    expect(read(tried.facts, costs).short).toBeNull();
    // Nothing is saved: the deal itself is as it was.
    expect(deal.lines[0].invoiceOn).toBe("2026-10-13");
  });

  it("sets a new percent, taking the difference off the balance, and refuses one the planned lines cannot take", () => {
    const deal = depositDeal();
    const tried = tryDeposit(deal, { depositPct: "50" }, 2);
    expect(tried.ok && tried.changes).toEqual(["Deposit (30%): 6,000.00 USDC (50%), not 3,600.00 USDC", "Balance on delivery: 6,000.00 USDC, not 8,400.00 USDC"]);
    if (tried.ok) expect(tried.facts.lines.map((each) => each.amountMinor)).toEqual([600_000, 600_000]);
    const lower = tryDeposit(deal, { depositPct: "10" }, 2);
    if (lower.ok) expect(lower.facts.lines.map((each) => each.amountMinor)).toEqual([120_000, 1_080_000]);

    const balanceInvoiced = depositDeal({ balance: { status: "released", releasedAt: "2026-10-01T00:00:00Z", releasedVia: "person", receivable: { id: "r2", status: "pending", dueDate: "2026-12-15T00:00:00Z" } } });
    expect(tryDeposit(balanceInvoiced, { depositPct: "50" }, 2)).toEqual({
      ok: false,
      field: "depositPct",
      message: "The lines not invoiced yet after the deposit come to 0.00 USDC: the deposit can be at most 30%.",
    });
    expect(tryDeposit(deal, { depositPct: "120" }, 2)).toMatchObject({ ok: false, field: "depositPct" });
    expect(tryDeposit(deal, { depositOn: "2026-09-01" }, 2)).toMatchObject({ ok: false, field: "depositOn" });
  });

  it("offers no try once the deposit is invoiced, on a cancelled deal, or where the first line is no deposit", () => {
    expect(depositLever(depositDeal({ deposit: { status: "released", releasedAt: "2026-10-13T00:00:00Z", releasedVia: "person" } }))).toBeNull();
    expect(depositLever({ ...depositDeal(), status: "cancelled" })).toBeNull();
    // A retainer's first month is no deposit; a deal billed as deposit and balance has one, whatever its line is named.
    const retainer = depositDeal({ deposit: { label: "November 2026" }, balance: { label: "December 2026" } });
    expect(depositLever(retainer, "retainer")).toBeNull();
    expect(depositLever(retainer, "deposit")).toMatchObject({ label: "November 2026" });
  });
});

describe("the Add a cost form", () => {
  const deal = { currency: "USDC", startsOn: "2026-10-05" };
  const fields = { dealId: DEAL, label: " Contractor: design ", counterpartyId: "none", amount: "1,240.00", expectedOn: "2026-10-20", noDocument: true, idempotencyKey: "key-12345678" };

  it("reads a cost in the deal's currency", () => {
    expect(readCostForm(fields, deal)).toEqual({
      ok: true,
      draft: { dealId: DEAL, label: "Contractor: design", counterpartyId: null, amountMinor: 124_000, expectedOn: "2026-10-20", noDocument: true, idempotencyKey: "key-12345678" },
    });
    expect(readCostForm({ ...fields, amount: "1000000" }, { currency: "JPY", startsOn: "2026-10-05" })).toMatchObject({ ok: true, draft: { amountMinor: 1_000_000 } });
  });

  it("refuses a missing name, an amount the currency does not write, a day out of range and a stale form", () => {
    expect(readCostForm({ ...fields, label: " " }, deal)).toMatchObject({ ok: false, field: "label" });
    expect(readCostForm({ ...fields, amount: "12.345" }, deal)).toMatchObject({ ok: false, field: "amount", message: "Give the amount in USDC, above zero." });
    expect(readCostForm({ ...fields, expectedOn: "2025-01-01" }, deal)).toMatchObject({ ok: false, field: "expectedOn" });
    expect(readCostForm({ ...fields, counterpartyId: "not-an-id" }, deal)).toMatchObject({ ok: false, field: "counterpartyId" });
    expect(readCostForm({ ...fields, idempotencyKey: "short" }, deal)).toMatchObject({ ok: false, field: "idempotencyKey" });
  });
});

describe("what reads it", () => {
  const ROOT = process.cwd();
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : [];
    });

  it("leaves cash readiness out of everything that pays, decides or answers the API (K5)", () => {
    const payers = ["src/lib/agent", "src/lib/commands", "src/app/actions", "src/app/api"].flatMap((dir) => walk(path.join(ROOT, dir)));
    expect(payers.length).toBeGreaterThan(50);
    expect(payers.filter((file) => /from\s+["'][^"']*deals\/cash["']/.test(readFileSync(file, "utf8")))).toEqual([]);
  });
});
