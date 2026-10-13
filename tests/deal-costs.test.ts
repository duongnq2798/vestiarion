import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { CostDraft } from "@/lib/deals/costs";
import { readDealCosts, readLinkCandidates } from "@/lib/deals/costs-read";
import { addDealCost, DealCostError, linkDealCost, removeDealCost } from "@/lib/deals/costs-write";
import type { DealDraft } from "@/lib/deals/input";
import { readDeal } from "@/lib/deals/read";
import { confirmDeal } from "@/lib/deals/write";
import { dealStoreResponder, emptyStore, type DealStore, type Row } from "./support/deal-store";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * A deal's costs, written and read (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md K1-K3, K9): a cost
 * is added once per key and signed; a removal is kept and signed; a link names a payable of the deal's currency or a
 * milestone, once, and signs what it became; and the costs read back with what each became, in the deal's minor units.
 */

const { bestEffort, canSign } = vi.hoisted(() => ({ bestEffort: vi.fn(), canSign: vi.fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: bestEffort }));
vi.mock("@/lib/ledger", async (original) => ({ ...(await original<typeof import("@/lib/ledger")>()), assertLedgerCanSign: canSign }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c01";
const PERSON = "a1b2c3d4-0000-4000-8000-0000000000c1";
const CLIENT = "c1c1c1c1-0000-4000-8000-0000000000c1";
const VENDOR = "c1c1c1c1-0000-4000-8000-0000000000c2";
const BILL = "b1b1b1b1-0000-4000-8000-0000000000b1";
const EURO_BILL = "b1b1b1b1-0000-4000-8000-0000000000b2";
const OWED = "b1b1b1b1-0000-4000-8000-0000000000b3";
const WORK = "e1e1e1e1-0000-4000-8000-0000000000e1";

type Store = DealStore & { deal_costs: Row[]; milestones: Row[] };
let store: Store;
let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: PERSON }), fn);

/** The deal store, with the costs' own rules: one cost per key (an ignored duplicate), and one live cost per bill. */
function responder(base: Store) {
  const inner = dealStoreResponder(base);
  return (request: RecordedRequest): FakeReply => {
    if (request.path === "/rest/v1/deal_costs" && base.override.deal_costs) return base.override.deal_costs;
    if (request.path === "/rest/v1/deal_costs" && request.method === "POST") {
      const body = (Array.isArray(request.body) ? request.body[0] : request.body) as Row;
      if (base.deal_costs.some((row) => row.idempotency_key === body.idempotency_key)) return { status: 201, body: [] };
      const row: Row = { id: `22222222-0000-4000-8000-00000000000${base.deal_costs.length + 1}`, created_at: new Date().toISOString(), removed_at: null, invoice_id: null, milestone_id: null, ...body };
      base.deal_costs.push(row);
      return { status: 201, body: [{ ...row, counterparties: row.counterparty_id ? { name: base.counterparties.find((cp) => cp.id === row.counterparty_id)?.name } : null }] };
    }
    if (request.path === "/rest/v1/deal_costs" && request.method === "PATCH") {
      const patch = request.body as Row;
      if (patch.invoice_id && base.deal_costs.some((row) => row.invoice_id === patch.invoice_id && !row.removed_at)) {
        return { status: 409, body: { code: "23505", message: 'duplicate key value violates unique constraint "deal_costs_invoice_key"' } };
      }
    }
    return inner(request);
  };
}

const dealDraft: DealDraft = {
  customer: { id: CLIENT },
  title: "Website rebuild",
  currency: "USDC",
  digits: 2,
  totalMinor: 1_200_000,
  startsOn: "2026-10-05",
  termsDays: 14,
  externalRef: null,
  template: "deposit",
  lines: [
    { position: 1, kind: "charge", label: "Deposit (30%)", invoiceOn: "2026-10-13", dueOn: "2026-10-27", amountMinor: 360_000, roundingMinor: 0 },
    { position: 2, kind: "charge", label: "Balance on delivery", invoiceOn: "2026-12-01", dueOn: "2026-12-15", amountMinor: 840_000, roundingMinor: 0 },
  ],
  autoRelease: false,
  idempotencyKey: "4f7c2b1e-1d8a-4b4e-9b0f-1c2d3e4f5a6b",
};

let dealId: string;
const cost = (over: Partial<CostDraft> = {}): CostDraft => ({
  dealId,
  label: "Contractor: design",
  counterpartyId: VENDOR,
  amountMinor: 124_000,
  expectedOn: "2026-10-20",
  noDocument: true,
  idempotencyKey: "cost-key-0001",
  ...over,
});

beforeEach(async () => {
  bestEffort.mockReset().mockResolvedValue(undefined);
  canSign.mockReset();
  store = {
    ...emptyStore({
      counterparties: [
        { id: CLIENT, name: "Acme Studio", role: "client" },
        { id: VENDOR, name: "Northwind Hosting", role: "vendor" },
      ],
    }),
    deal_costs: [],
    milestones: [{ id: WORK, title: "Design", amount: "800", status: "pending", settled_at: null, contractor_id: VENDOR, counterparty_id: VENDOR }],
  };
  store.invoices.push(
    { id: BILL, direction: "payable", counterparty_id: VENDOR, amount: "1500", currency: "USDC", status: "held", due_date: "2026-10-22T00:00:00Z", scheduled_for: null, settled_at: null, paid_amount: null, memo: "INV-7" },
    { id: EURO_BILL, direction: "payable", counterparty_id: VENDOR, amount: "900", currency: "EURC", status: "pending", due_date: "2026-10-22T00:00:00Z", scheduled_for: null, settled_at: null, paid_amount: null, memo: null },
    { id: OWED, direction: "receivable", counterparty_id: CLIENT, amount: "900", currency: "USDC", status: "pending", due_date: "2026-10-22T00:00:00Z", scheduled_for: null, settled_at: null, paid_amount: null, memo: null }
  );
  fake = fakeSupabase(responder(store));
  dealId = (await run(() => confirmDeal({ actorId: PERSON, draft: dealDraft }))).dealId;
  bestEffort.mockClear();
});

describe("addDealCost", () => {
  it("adds the cost as the person and signs deal_cost_added with its figures", async () => {
    const result = await run(() => addDealCost({ actorId: PERSON, draft: cost() }));
    expect(result).toMatchObject({ created: true, title: "Website rebuild", amount: "1,240.00 USDC" });
    expect(store.deal_costs[0]).toMatchObject({ org_id: ORG, deal_id: dealId, label: "Contractor: design", counterparty_id: VENDOR, amount_minor: 124_000, expected_on: "2026-10-20", no_document: true, created_by: PERSON });
    expect(canSign).toHaveBeenCalled();
    expect(bestEffort.mock.calls[0][1]).toMatchObject({
      actor: "human",
      domain: "ar",
      action: "deal_cost_added",
      summary: "Planned a cost of 1,240.00 USDC for the deal Website rebuild: Contractor: design",
      detail: { by: PERSON, dealId, costId: result.cost.id, counterpartyName: "Northwind Hosting", amount: "1240.00", amountMinor: 124_000, expectedOn: "2026-10-20", noDocument: true, currency: "USDC" },
    });
  });

  it("adds one cost for the same form sent twice, and refuses the key with other details", async () => {
    await run(() => addDealCost({ actorId: PERSON, draft: cost() }));
    expect(await run(() => addDealCost({ actorId: PERSON, draft: cost() }))).toMatchObject({ created: false });
    expect(store.deal_costs).toHaveLength(1);
    expect(bestEffort).toHaveBeenCalledTimes(1);
    await expect(run(() => addDealCost({ actorId: PERSON, draft: cost({ amountMinor: 1 }) }))).rejects.toMatchObject({ code: "key_reused" });
  });

  it("refuses a vendor that is not the workspace's, and says costs are not set up before 0108", async () => {
    await expect(run(() => addDealCost({ actorId: PERSON, draft: cost({ counterpartyId: "c1c1c1c1-0000-4000-8000-0000000000ff" }) }))).rejects.toMatchObject({ code: "counterparty_not_found" });
    store.override.deal_costs = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.deal_costs' in the schema cache" } };
    await expect(run(() => addDealCost({ actorId: PERSON, draft: cost() }))).rejects.toEqual(new DealCostError("not_ready"));
  });
});

describe("removeDealCost", () => {
  it("keeps the cost with who removed it, signs it once, and says a second removal changed nothing", async () => {
    const { cost: added } = await run(() => addDealCost({ actorId: PERSON, draft: cost() }));
    bestEffort.mockClear();
    expect(await run(() => removeDealCost({ actorId: PERSON, dealId, costId: added.id }))).toEqual({ removed: true, title: "Website rebuild", label: "Contractor: design" });
    expect(store.deal_costs[0]).toMatchObject({ removed_by: PERSON });
    expect(store.deal_costs[0].removed_at).toBeTruthy();
    expect(bestEffort.mock.calls[0][1]).toMatchObject({ action: "deal_cost_removed", detail: { costId: added.id, amountMinor: 124_000, linked: null } });
    expect(await run(() => removeDealCost({ actorId: PERSON, dealId, costId: added.id }))).toMatchObject({ removed: false });
    expect(bestEffort).toHaveBeenCalledTimes(1);
    await expect(run(() => removeDealCost({ actorId: PERSON, dealId, costId: "22222222-0000-4000-8000-0000000000ff" }))).rejects.toMatchObject({ code: "cost_not_found" });
  });
});

describe("linkDealCost", () => {
  it("links a cost to a payable in the deal's currency and signs what it became", async () => {
    const { cost: added } = await run(() => addDealCost({ actorId: PERSON, draft: cost() }));
    bestEffort.mockClear();
    const result = await run(() => linkDealCost({ actorId: PERSON, dealId, costId: added.id, target: { kind: "payable", id: BILL } }));
    expect(result.to).toBe("the bill from Northwind Hosting, 1,500.00 USDC");
    expect(store.deal_costs[0]).toMatchObject({ invoice_id: BILL, linked_by: PERSON });
    expect(bestEffort.mock.calls[0][1]).toMatchObject({ action: "deal_cost_linked", detail: { costId: added.id, linked: { kind: "payable", id: BILL, amount: "1500.00", amountMinor: 150_000, status: "held" } } });
    await expect(run(() => linkDealCost({ actorId: PERSON, dealId, costId: added.id, target: { kind: "milestone", id: WORK } }))).rejects.toMatchObject({ code: "linked" });
  });

  it("refuses a receivable, a bill in another currency, a bill backing another cost, and a removed cost", async () => {
    const { cost: first } = await run(() => addDealCost({ actorId: PERSON, draft: cost() }));
    const { cost: second } = await run(() => addDealCost({ actorId: PERSON, draft: cost({ idempotencyKey: "cost-key-0002" }) }));
    await expect(run(() => linkDealCost({ actorId: PERSON, dealId, costId: first.id, target: { kind: "payable", id: OWED } }))).rejects.toMatchObject({ code: "link_not_found" });
    await expect(run(() => linkDealCost({ actorId: PERSON, dealId, costId: first.id, target: { kind: "payable", id: EURO_BILL } }))).rejects.toMatchObject({ code: "link_currency" });
    await run(() => linkDealCost({ actorId: PERSON, dealId, costId: first.id, target: { kind: "payable", id: BILL } }));
    await expect(run(() => linkDealCost({ actorId: PERSON, dealId, costId: second.id, target: { kind: "payable", id: BILL } }))).rejects.toMatchObject({ code: "link_taken" });
    await run(() => removeDealCost({ actorId: PERSON, dealId, costId: second.id }));
    await expect(run(() => linkDealCost({ actorId: PERSON, dealId, costId: second.id, target: { kind: "milestone", id: WORK } }))).rejects.toMatchObject({ code: "removed" });
  });
});

describe("readDealCosts", () => {
  it("reads each cost with what it became, in the deal's minor units", async () => {
    const { cost: first } = await run(() => addDealCost({ actorId: PERSON, draft: cost() }));
    const { cost: second } = await run(() => addDealCost({ actorId: PERSON, draft: cost({ idempotencyKey: "cost-key-0002", label: "Design work", counterpartyId: null }) }));
    await run(() => linkDealCost({ actorId: PERSON, dealId, costId: first.id, target: { kind: "payable", id: BILL } }));
    await run(() => linkDealCost({ actorId: PERSON, dealId, costId: second.id, target: { kind: "milestone", id: WORK } }));
    const read = await run(async () => {
      const deal = await readDeal(dealId);
      if (!deal.available || !deal.deal) throw new Error("deal not read");
      return readDealCosts([deal.deal]);
    });
    if (!read.available) throw new Error("costs not read");
    const costs = read.byDeal.get(dealId) ?? [];
    expect(costs.map((each) => [each.label, each.counterparty?.name ?? null, each.link?.kind, each.link?.amountMinor])).toEqual([
      ["Contractor: design", "Northwind Hosting", "payable", 150_000],
      ["Design work", null, "milestone", 80_000],
    ]);
    expect(costs[0].link).toMatchObject({ counterpartyName: "Northwind Hosting", status: "held", dueOn: "2026-10-22", memo: "INV-7" });
  });

  it("offers the bills and milestones no cost is linked to yet, in the deal's currency", async () => {
    const { cost: first } = await run(() => addDealCost({ actorId: PERSON, draft: cost() }));
    const words = ({ name, amountMinor }: { name: string; amountMinor: number }) => `${name} ${amountMinor}`;
    const offered = async () =>
      run(async () => {
        const deal = await readDeal(dealId);
        if (!deal.available || !deal.deal) throw new Error("deal not read");
        const read = await readLinkCandidates(deal.deal, words);
        return read.available ? read.candidates.map((candidate) => [candidate.kind, candidate.name]) : null;
      });
    expect(await offered()).toEqual([
      ["payable", "Northwind Hosting 150000"],
      ["milestone", "Northwind Hosting: Design 80000"],
    ]);
    await run(() => linkDealCost({ actorId: PERSON, dealId, costId: first.id, target: { kind: "payable", id: BILL } }));
    expect(await offered()).toEqual([["milestone", "Northwind Hosting: Design 80000"]]);
  });
});
