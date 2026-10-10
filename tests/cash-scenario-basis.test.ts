import { describe, expect, it } from "vitest";
import { outlookMoves, type OutlookInput } from "@/lib/cash-outlook";
import { scenarioBasis, type RecurringScheduleInput, type ScenarioBasisInput } from "@/lib/cash-scenario-basis";

/**
 * What the cash scenarios start from (docs/superpowers/specs/2026-10-11-cash-scenarios-design.md C2-C4, C8): the
 * outlook's own rules over 90 days, each active recurring payment's periods not billed yet, each client's payment
 * record, and EURC apart. Built on the page from the rows it already loaded, then handed to the browser.
 */

const NOW = Date.parse("2026-10-02T09:00:00Z");
const day = (offset: number, hour = 12) => new Date(Date.UTC(2026, 9, 2 + offset, hour)).toISOString();
const ymd = (offset: number) => day(offset).slice(0, 10);

const base = (over: Partial<ScenarioBasisInput> = {}): ScenarioBasisInput => ({
  now: NOW,
  operatingUsdc: 100,
  reserveUsdc: 50,
  payables: [],
  milestones: [],
  receivables: [],
  recurring: [],
  ...over,
});

const payable = (id: string, amount: number, due: string, over: Record<string, unknown> = {}) => ({
  id, counterparty: `Vendor ${id}`, amount, currency: "USDC", due_date: due, status: "pending", scheduled_for: null, ...over,
});
const receivable = (id: string, amount: number, due: string, over: Record<string, unknown> = {}) => ({
  id, counterparty: `Client ${id}`, counterparty_id: `client-${id}`, amount, currency: "USDC", due_date: due, status: "pending", ...over,
});
const schedule = (over: Partial<RecurringScheduleInput> = {}): RecurringScheduleInput => ({
  id: "rec-1",
  counterpartyName: "Linh Design",
  amount: 25,
  currency: "USDC",
  status: "active",
  startsOn: ymd(5),
  endsOn: null,
  everyCount: 1,
  everyUnit: "month",
  nextPeriod: 0,
  ...over,
});

describe("outlookMoves: the outlook's rules over any window", () => {
  const input: OutlookInput = {
    now: NOW,
    operatingUsdc: 0,
    payables: [payable("near", 5, day(3)), payable("far", 7, day(70))],
    milestones: [],
    receivables: [receivable("r", 9, day(45))],
  };

  it("counts over 90 days what the 30-day outlook leaves out, on the same days", () => {
    expect(outlookMoves(input, 30).moves.map((move) => move.id)).toEqual(["near"]);
    const ninety = outlookMoves(input, 90);
    expect(ninety.moves.map((move) => [move.id, (move.at - ninety.today) / 86_400_000])).toEqual([
      ["near", 3],
      ["far", 70],
      ["r", 45],
    ]);
  });
});

describe("scenarioBasis", () => {
  it("starts from the wallet and the USYC reserve, apart, and today's UTC day", () => {
    const basis = scenarioBasis(base());
    expect(basis).toMatchObject({ today: "2026-10-02", cash: 100, reserve: 50, outflows: [], receivables: [], recurringRead: true });
  });

  it("dates every bill, milestone and receivable as the outlook does, in days from today, over 90 days", () => {
    const basis = scenarioBasis(
      base({
        payables: [
          payable("late", 5, day(-3)),
          payable("held", 6, day(10), { status: "held" }),
          payable("sched", 7, day(40), { status: "scheduled", scheduled_for: day(20, 0) }),
          payable("far", 8, day(95)),
          payable("paid", 9, day(4), { status: "paid" }),
          payable("fx", 10, day(12), { original_currency: "EUR" }),
        ],
        milestones: [
          { id: "m1", title: "Thumbnails", contractor: "Linh", amount: 4, status: "verified", escrow_state: null },
          { id: "m2", title: "Locked", contractor: "Linh", amount: 4, status: "verified", escrow_state: "funded" },
        ],
        receivables: [receivable("r1", 30, day(-2)), receivable("r2", 40, day(50)), receivable("r3", 50, day(5), { status: "received" })],
      })
    );
    expect(basis.outflows).toEqual([
      { id: "late", kind: "bill", label: "Vendor late", amount: 5, day: 0, note: "overdue", foreign: false },
      { id: "held", kind: "bill", label: "Vendor held", amount: 6, day: 10, note: "held", foreign: false },
      { id: "sched", kind: "bill", label: "Vendor sched", amount: 7, day: 20, note: "scheduled", foreign: false, dueDay: 40 },
      { id: "fx", kind: "bill", label: "Vendor fx", amount: 10, day: 12, note: "due", foreign: true },
      { id: "m1", kind: "milestone", label: "Linh: Thumbnails", amount: 4, day: 0, note: "verified", foreign: false },
    ]);
    expect(basis.receivables).toEqual([
      { id: "r1", label: "Client r1", amount: 30, day: 0, overdue: true, client: "client-r1" },
      { id: "r2", label: "Client r2", amount: 40, day: 50, overdue: false, client: "client-r2" },
    ]);
  });

  it("keeps EURC apart, each with its day, never as a USDC amount", () => {
    const basis = scenarioBasis(
      base({
        payables: [payable("e", 9, day(40), { currency: "EURC" })],
        receivables: [receivable("re", 11, day(70), { currency: "EURC" })],
        recurring: [schedule({ id: "rec-eur", currency: "EURC", amount: 3, startsOn: ymd(10) })],
      })
    );
    expect(basis.outflows).toEqual([]);
    expect(basis.receivables).toEqual([]);
    expect(basis.eurc).toEqual([
      { kind: "bill", amount: 9, day: 40 },
      { kind: "receivable", amount: 11, day: 70 },
      { kind: "bill", amount: 3, day: 10 },
      { kind: "bill", amount: 3, day: 41 },
      { kind: "bill", amount: 3, day: 71 },
    ]);
  });

  describe("recurring payments not billed yet", () => {
    it("projects each period from the next one to bill, on its due day, within 90 days", () => {
      const basis = scenarioBasis(base({ recurring: [schedule({ startsOn: "2026-09-05", nextPeriod: 1 })] }));
      // Period 1 is Oct 5, then Nov 5 and Dec 5; Jan 5 is past the 90 days (Dec 30 is the last).
      expect(basis.outflows).toEqual([
        { id: "rec-1:2026-10-05", kind: "recurring", label: "Linh Design", amount: 25, day: 3, note: "recurring, not billed yet", foreign: false },
        { id: "rec-1:2026-11-05", kind: "recurring", label: "Linh Design", amount: 25, day: 34, note: "recurring, not billed yet", foreign: false },
        { id: "rec-1:2026-12-05", kind: "recurring", label: "Linh Design", amount: 25, day: 64, note: "recurring, not billed yet", foreign: false },
      ]);
    });

    it("skips a period whose invoice already exists, whatever its status, so nothing is counted twice", () => {
      const basis = scenarioBasis(
        base({
          payables: [payable("inv", 25, day(3), { recurring_id: "rec-1", recurring_period: "2026-10-05", counterparty: "Linh Design", status: "paid" })],
          recurring: [schedule({ startsOn: "2026-10-05", nextPeriod: 0 })],
        })
      );
      expect(basis.outflows.map((outflow) => outflow.id)).toEqual(["rec-1:2026-11-05", "rec-1:2026-12-05"]);
    });

    it("counts a period already due today, as an overdue bill, and stops at the last due day", () => {
      const basis = scenarioBasis(base({ recurring: [schedule({ startsOn: "2026-09-28", everyUnit: "week", endsOn: "2026-10-12" })] }));
      expect(basis.outflows.map((outflow) => [outflow.id, outflow.day])).toEqual([
        ["rec-1:2026-09-28", 0],
        ["rec-1:2026-10-05", 3],
        ["rec-1:2026-10-12", 10],
      ]);
    });

    it("projects only running schedules, and says when they could not be read", () => {
      expect(scenarioBasis(base({ recurring: [schedule({ status: "stopped" }), schedule({ status: "ended" })] })).outflows).toEqual([]);
      const unread = scenarioBasis(base({ recurring: null }));
      expect(unread.recurringRead).toBe(false);
      expect(unread.outflows).toEqual([]);
    });
  });

  describe("each client's payment record", () => {
    it("counts received receivables on time or late, in UTC days, with the average days late, for clients with one expected", () => {
      const settled = (id: string, due: number, paid: number) =>
        receivable(id, 1, day(due), { status: "received", settled_at: day(paid, 23), counterparty_id: "client-acme" });
      const basis = scenarioBasis(
        base({
          receivables: [
            receivable("open", 100, day(20), { counterparty_id: "client-acme", counterparty: "Acme" }),
            receivable("new", 50, day(25), { counterparty_id: "client-new", counterparty: "Newco" }),
            settled("a", -60, -60),
            settled("b", -40, -31),
            settled("c", -20, -15),
            receivable("other", 1, day(-10), { status: "received", settled_at: day(-1), counterparty_id: "client-gone" }),
            receivable("unsettled", 1, day(-10), { status: "received", settled_at: null, counterparty_id: "client-new" }),
          ],
        })
      );
      expect(basis.clients).toEqual({ "client-acme": { paidOnTime: 1, paidLate: 2, averageDaysLate: 7 } });
    });
  });
});
