import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { cashOutlook, type OutlookInput } from "@/lib/cash-outlook";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Telling the owner before the cash runs short (docs/superpowers/specs/2026-10-17-cash-short-alert-design.md): the
 * console's own cash outlook (S1), what the agent is doing about it (S2), told once and again only when it changes
 * (S3), not in shadow mode (S5). The book is our test workspace's on Oct 17: 150.03 USDC, 140 USDC set for Oct 22,
 * 150 USDC held due Oct 23, two 45 USDC bills held due Oct 24 and Oct 25, a customer owing 40 USDC on Oct 27.
 */

const { ledgerMock } = vi.hoisted(() => ({ ledgerMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: ledgerMock }));

import { alertCashShort, alertDue, cashShortOf, CASH_SHORT_AHEAD, CASH_SHORT_CLEARED, type CashShort } from "@/lib/agent/cash-alert";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d0d";
const NOW = Date.parse("2026-10-17T11:20:00Z");

const bill = (id: string, amount: number, status: string, due: string, scheduled: string | null = null) => ({
  id, direction: "payable", status, amount: String(amount), currency: "USDC", due_date: `${due}T12:00:00+00:00`, scheduled_for: scheduled ? `${scheduled}T00:00:00+00:00` : null,
  counterparties: { name: "Cobalt Cloud" },
});
const BOOK = [
  bill("b-140", 140, "scheduled", "2026-10-22", "2026-10-22"),
  bill("b-150", 150, "held", "2026-10-23"),
  bill("b-45-a", 45, "held", "2026-10-24"),
  bill("b-45-b", 45, "held", "2026-10-25"),
  { id: "r-40", direction: "receivable", status: "pending", amount: "40", currency: "USDC", due_date: "2026-10-27T12:00:00+00:00", scheduled_for: null, counterparties: { name: "Harbor Design Studio" } },
];

function outlookOf(over: Partial<OutlookInput> = {}) {
  return cashOutlook({
    now: NOW,
    operatingUsdc: 150.03,
    reserveUsdc: 0,
    payables: BOOK.filter((row) => row.direction === "payable").map((row) => ({ id: row.id, counterparty: "Cobalt Cloud", amount: Number(row.amount), currency: "USDC", due_date: row.due_date, status: row.status, scheduled_for: row.scheduled_for })),
    milestones: [],
    receivables: [{ id: "r-40", counterparty: "Harbor Design Studio", amount: 40, currency: "USDC", due_date: "2026-10-27T12:00:00+00:00", status: "pending" }],
    ...over,
  });
}

describe("how short the wallet runs (S1)", () => {
  it("reads the first short day, the shortest day and the customers' money by then", () => {
    expect(cashShortOf(outlookOf())).toEqual({
      shortOn: "2026-10-23",
      shortBy: 139.97,
      lowestOn: "2026-10-25",
      need: 229.97,
      expectedBy: 0,
      coveredWithExpected: false,
    });
  });

  it("counts receivables expected by the shortest day, and says whether they would cover it", () => {
    const short = cashShortOf(outlookOf({ receivables: [{ id: "r", counterparty: "Harbor", amount: 300, currency: "USDC", due_date: "2026-10-22T12:00:00+00:00", status: "pending" }] }));
    expect(short).toMatchObject({ expectedBy: 300, coveredWithExpected: true });
  });

  it("is null when the wallet never runs short", () => {
    expect(cashShortOf(outlookOf({ operatingUsdc: 400 }))).toBeNull();
  });
});

describe("when to tell the owner (S3)", () => {
  const short = (over: Partial<CashShort> = {}): CashShort => ({ shortOn: "2026-10-23", shortBy: 139.97, lowestOn: "2026-10-25", need: 229.97, expectedBy: 0, coveredWithExpected: false, ...over });
  const told = (detail: Record<string, unknown>, ts = "2026-10-17T11:20:00Z") => ({ action: CASH_SHORT_AHEAD, ts, detail });
  const at = Date.parse("2026-10-17T12:00:00Z");

  it("tells it the first time, and after the last word was that it was cleared", () => {
    expect(alertDue(short(), null, at)).toBe("alert");
    expect(alertDue(short(), { action: CASH_SHORT_CLEARED, ts: "2026-10-16T00:00:00Z", detail: {} }, at)).toBe("alert");
  });

  it("says nothing about a shortfall under a cent, neither alert nor clear (review of #420)", () => {
    expect(alertDue(short({ need: 0.004, shortBy: 0.004 }), null, at)).toBeNull();
    expect(alertDue(short({ need: 0.004, shortBy: 0.004 }), told({ shortOn: "2026-10-23", need: 229.97 }), at)).toBeNull();
  });

  it("says nothing new while it is the same, or a little worse", () => {
    expect(alertDue(short(), told({ shortOn: "2026-10-23", need: 229.97 }), at)).toBeNull();
    expect(alertDue(short({ need: 240 }), told({ shortOn: "2026-10-23", need: 229.97 }), at)).toBeNull();
  });

  it("tells it again when the short day comes earlier, the need grows by a tenth, or a week passes", () => {
    expect(alertDue(short({ shortOn: "2026-10-22" }), told({ shortOn: "2026-10-23", need: 229.97 }), at)).toBe("alert");
    expect(alertDue(short({ need: 253 }), told({ shortOn: "2026-10-23", need: 229.97 }), at)).toBe("alert");
    expect(alertDue(short(), told({ shortOn: "2026-10-23", need: 229.97 }, "2026-10-10T11:00:00Z"), at)).toBe("alert");
  });

  it("clears it once the wallet no longer runs short, and only after an alert", () => {
    expect(alertDue(null, told({ shortOn: "2026-10-23", need: 229.97 }), at)).toBe("clear");
    expect(alertDue(null, null, at)).toBeNull();
    expect(alertDue(null, { action: CASH_SHORT_CLEARED, ts: "2026-10-17T00:00:00Z", detail: {} }, at)).toBeNull();
  });
});

describe("the cash alert stage (S1-S5)", () => {
  interface World {
    operating?: string;
    last?: Array<Record<string, unknown>>;
    shadow?: boolean;
    termRequests?: Array<Record<string, unknown>> | "missing";
  }
  function world(w: World = {}) {
    return fakeSupabase((request) => {
      if (request.path === "/rest/v1/shadow_modes") return { body: w.shadow ? [{ currency: "VND", started_at: "2026-10-01T00:00:00Z", started_by: null }] : [] };
      if (request.path === "/rest/v1/accounts") return { body: [{ kind: "operating", balance: w.operating ?? "150.03", apy: "0" }, { kind: "reserve", balance: "0", apy: "0" }] };
      if (request.path === "/rest/v1/invoices") return { body: BOOK };
      if (request.path === "/rest/v1/milestones") return { body: [] };
      if (request.path === "/rest/v1/ledger_entries" && request.params.get("action")?.includes("cash_short")) return { body: w.last ?? [] };
      if (request.path === "/rest/v1/ledger_entries") {
        const held = (id: string) => ({ detail: { invoiceId: id, execution: { heldBecause: "cash_shortfall" } } });
        return { body: [held("b-150"), held("b-45-a"), held("b-45-b")] };
      }
      if (request.path === "/rest/v1/payment_term_requests") {
        return w.termRequests === "missing" ? { status: 404, body: { code: "42P01", message: "relation does not exist" } } : { body: w.termRequests ?? [] };
      }
      if (request.path === "/rest/v1/customer_discount_offers") return { body: [] };
      return { body: [] };
    });
  }
  const run = (client: ReturnType<typeof fakeSupabase>) => runWith(orgTestContext({ config, client: client.client, orgId: ORG }), () => alertCashShort(db(), { now: NOW }));
  const signed = () => ledgerMock.mock.calls.map((call) => call[0] as { action: string; summary: string; detail: Record<string, unknown> });

  beforeEach(() => {
    ledgerMock.mockReset().mockResolvedValue(undefined);
  });

  it("signs how short, by when, and what the agent is doing about it", async () => {
    const lines = await run(world({ termRequests: [{ id: "t1" }] }));
    const [entry] = signed();
    expect(entry.action).toBe(CASH_SHORT_AHEAD);
    expect(entry.summary).toBe("Cash runs short on Oct 23, 2026 by 139.97 USDC, and by 229.97 USDC on Oct 25, 2026");
    expect(entry.detail).toMatchObject({
      shortOn: "2026-10-23",
      need: 229.97,
      cash: { operating: 150.03, reserve: 0 },
      doing: { heldForCash: { count: 3, total: 240 }, termRequestsOpen: 1, customerDiscountsOpen: 0 },
    });
    expect(lines).toEqual([{ domain: "treasury", message: "cash runs short on Oct 23, 2026 by 139.97 USDC, and by 229.97 USDC on Oct 25, 2026" }]);
  });

  it("reads only open invoices and milestones, so a long history cannot crowd out what is due (review of #420)", async () => {
    const client = world();
    await run(client);
    const invoices = client.requests.find((r) => r.path === "/rest/v1/invoices");
    expect(invoices?.params.get("status")).toBe("in.(pending,matched,held,awaiting_info,scheduled)");
    expect(client.requests.find((r) => r.path === "/rest/v1/milestones")?.params.get("status")).toBe("in.(pending,verified)");
  });

  it("signs nothing when it was told already and nothing changed", async () => {
    await run(world({ last: [{ action: CASH_SHORT_AHEAD, ts: "2026-10-17T11:00:00Z", detail: { shortOn: "2026-10-23", need: 229.97 } }] }));
    expect(signed()).toEqual([]);
  });

  it("clears it once the cash covers everything due", async () => {
    await run(world({ operating: "500", last: [{ action: CASH_SHORT_AHEAD, ts: "2026-10-17T11:00:00Z", detail: { shortOn: "2026-10-23", need: 229.97 } }] }));
    expect(signed().map((entry) => entry.action)).toEqual([CASH_SHORT_CLEARED]);
  });

  it("counts what it cannot read as not known, and says nothing in shadow mode", async () => {
    await run(world({ termRequests: "missing" }));
    expect(signed()[0].detail).toMatchObject({ doing: { termRequestsOpen: null } });
    ledgerMock.mockClear();
    await run(world({ shadow: true }));
    expect(signed()).toEqual([]);
  });
});
