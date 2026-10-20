import { beforeEach, describe, expect, it, vi } from "vitest";

type Read = { data: unknown; error: { message: string } | null };

const mocks = vi.hoisted(() => ({
  tables: {} as Record<string, Read>,
  org: { data: null, error: null } as Read,
}));

/** A query on `table`: every filter chains, and the read resolves to the table's rows, or its first row for maybeSingle. */
function query(table: string, read: () => Read) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "gte", "not", "order", "limit"]) builder[method] = () => builder;
  builder.maybeSingle = async () => {
    const { data, error } = read();
    return { data: error ? null : ((data as unknown[] | null)?.[0] ?? null), error };
  };
  builder.then = (resolve: (value: Read) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(read()).then(resolve, reject);
  return builder;
}

vi.mock("@/lib/dal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dal")>()),
  db: () => ({
    rpc: async () => ({ data: true, error: null }),
    from: (table: string) => query(table, () => mocks.tables[table] ?? { data: [], error: null }),
  }),
  platformDb: () => ({ from: () => query("orgs", () => mocks.org) }),
}));
vi.mock("@/lib/context", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/context")>()), currentOrgId: () => "org-1" }));

import { offersView } from "@/lib/early-pay/offers";

/**
 * What Bills shows of early-payment offers (docs/superpowers/specs/2026-10-16-early-payment-offers-design.md E1, E2):
 * read in the workspace in scope, with or without a reserve.
 */

const NOW = new Date("2026-10-20T09:00:00Z");
const BILL = { id: "inv-1", amount: "1000", currency: "USDC", due_date: "2026-11-09T12:00:00Z", memo: "INV-108", status: "scheduled", counterparties: { name: "Northwind Supply" } };

beforeEach(() => {
  mocks.tables = { invoices: { data: [BILL], error: null } };
  mocks.org = { data: [{ mode: "live", early_offers_on_at: null, early_offers_max_pct: null }], error: null };
});

describe("the offers view (E1, E2)", () => {
  it("reads a workspace with no reserve as earning nothing by waiting, not as a failure", async () => {
    // No reserve account: the read comes back with no row.
    mocks.tables.accounts = { data: [], error: null };
    const view = await offersView(NOW);
    expect(view).toMatchObject({ reserveApy: 0, agent: { on: false, maxPct: null, sandbox: false }, recent: [], results: null });
    expect(view?.candidates).toHaveLength(1);
    expect(view?.candidates[0]).toMatchObject({ invoiceId: "inv-1", counterpartyName: "Northwind Supply", suggestion: { days: 20, pct: 0.5 }, open: null });
  });

  it("suggests from the reserve's yield, and shows the offer out, where there is a reserve", async () => {
    // 60 days out, 4.2% a year earns 0.69%: twice that rounds up to 1.50%, above the 0.5% floor a workspace with no reserve gets.
    mocks.tables.invoices = { data: [{ ...BILL, due_date: "2026-12-19T12:00:00Z" }], error: null };
    mocks.tables.accounts = { data: [{ apy: "0.042" }], error: null };
    mocks.org = { data: [{ mode: "live", early_offers_on_at: "2026-10-16T00:00:00Z", early_offers_max_pct: "2.00" }], error: null };
    mocks.tables.early_payment_offers = {
      data: [{ id: "offer-1", invoice_id: "inv-1", discount_pct: "1.00", amount: "1000", offered_amount: "990", counter_pct: null, status: "open", expires_at: "2026-10-25T09:00:00Z", decided_at: null, counterparties: { name: "Northwind Supply" } }],
      error: null,
    };
    mocks.tables.early_payment_offer_reviews = { data: [{ offer_id: "offer-1" }], error: null };
    const view = await offersView(NOW);
    expect(view).toMatchObject({ reserveApy: 0.042, agent: { on: true, maxPct: 2 } });
    expect(view?.candidates[0].suggestion).toMatchObject({ days: 60, pct: 1.5 });
    expect(view?.candidates[0].open).toEqual({ id: "offer-1", pct: 1, offered: 990, expiresAt: "2026-10-25T09:00:00Z", byAgent: true, counterPct: null });
    expect(view?.results).toMatchObject({ made: 1, byAgent: 1, accepted: 0, declined: 0 });
  });

  it("still fails when the reserve cannot be read, so the page logs it", async () => {
    mocks.tables.accounts = { data: null, error: { message: "permission denied for table accounts" } };
    await expect(offersView(NOW)).rejects.toThrow("permission denied for table accounts");
  });
});
