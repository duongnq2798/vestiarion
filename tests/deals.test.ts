import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import type { DealDraft } from "@/lib/deals/input";
import { plannedLinesOf, readDeal, readDeals } from "@/lib/deals/read";
import { changeDeal, confirmDeal, DealError, releaseDealLine, releaseDueDealLines, switchDealAutoRelease } from "@/lib/deals/write";
import { dealStoreResponder, emptyStore, type DealStore } from "./support/deal-store";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Deals, written (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D7-D13): a confirm makes one deal per key
 * and signs version 1; a change is planned again from the deal as it is and signed; a release claims the line, then adds
 * the receivable through `createInvoice` naming the deal, and undoes the claim when that fails; the cycle releases the
 * lines whose day came, as the agent, only where the switch is on.
 */

const { bestEffort, append, canSign, usdRate } = vi.hoisted(() => ({ bestEffort: vi.fn(), append: vi.fn(), canSign: vi.fn(), usdRate: vi.fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: bestEffort }));
vi.mock("@/lib/ledger", async (original) => ({ ...(await original<typeof import("@/lib/ledger")>()), appendLedgerEntry: append, assertLedgerCanSign: canSign }));
vi.mock("@/lib/fx/usd-rates", async (original) => ({ ...(await original<typeof import("@/lib/fx/usd-rates")>()), usdRate }));
// A new customer is screened as any counterparty; the screening itself is not what is tested here.
vi.mock("@/lib/compliance", async (original) => ({ ...(await original<typeof import("@/lib/compliance")>()), screenCounterparty: vi.fn(async () => ({ riskLevel: "clear" })) }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a01";
const PERSON = "a1b2c3d4-0000-4000-8000-0000000000a1";
const CLIENT = "c1c1c1c1-0000-4000-8000-0000000000c1";

let store: DealStore;
let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: PERSON }), fn);
const requests = (method: string, path: string) => fake.requests.filter((r) => r.method === method && r.path === path);

const draft = (over: Partial<DealDraft> = {}): DealDraft => ({
  customer: { id: CLIENT },
  title: "Website rebuild",
  currency: "USDC",
  digits: 2,
  totalMinor: 1_000_000,
  startsOn: "2026-10-12",
  termsDays: 14,
  externalRef: null,
  template: "deposit",
  lines: [
    { position: 1, kind: "charge", label: "Deposit (30%)", invoiceOn: "2026-10-12", dueOn: "2026-10-26", amountMinor: 300_000, roundingMinor: 0 },
    { position: 2, kind: "charge", label: "Balance on delivery", invoiceOn: "2026-12-01", dueOn: "2026-12-15", amountMinor: 700_000, roundingMinor: 0 },
  ],
  autoRelease: false,
  idempotencyKey: "4f7c2b1e-1d8a-4b4e-9b0f-1c2d3e4f5a6b",
  ...over,
});

beforeEach(() => {
  bestEffort.mockReset().mockResolvedValue(undefined);
  append.mockReset().mockResolvedValue({});
  canSign.mockReset();
  usdRate.mockReset().mockResolvedValue({ perUsd: 150, source: "test-rates", at: "2026-10-12T00:00:00Z" });
  store = emptyStore({ counterparties: [{ id: CLIENT, name: "Acme Studio", role: "client" }] });
  fake = fakeSupabase(dealStoreResponder(store));
});

async function signed(over: Partial<DealDraft> = {}) {
  return run(() => confirmDeal({ actorId: PERSON, draft: draft(over) }));
}

describe("confirmDeal", () => {
  it("writes version 1 through create_deal and signs deal_signed with every line", async () => {
    const result = await signed();
    expect(result).toMatchObject({ created: true, title: "Website rebuild", customerName: "Acme Studio" });
    const call = requests("POST", "/rest/v1/rpc/create_deal")[0].body as { p_org_id: string; p_deal: Record<string, unknown>; p_lines: unknown[] };
    expect(call.p_org_id).toBe(ORG);
    expect(call.p_deal).toMatchObject({ counterpartyId: CLIENT, currency: "USDC", minorDigits: 2, totalMinor: 1_000_000, idempotencyKey: draft().idempotencyKey, createdBy: PERSON });
    expect(call.p_lines).toHaveLength(2);
    expect(canSign).toHaveBeenCalled();
    const entry = bestEffort.mock.calls[0][1];
    expect(entry).toMatchObject({
      actor: "human",
      domain: "ar",
      action: "deal_signed",
      summary: "Signed the deal Website rebuild with Acme Studio: 10,000.00 USDC in 2 lines",
      detail: { by: PERSON, dealId: result.dealId, version: 1, counterpartyId: CLIENT, total: "10000.00", totalMinor: 1_000_000, template: "deposit", autoRelease: false },
    });
    expect(entry.detail.lines.map((line: { amount: string }) => line.amount)).toEqual(["3000.00", "7000.00"]);
  });

  it("makes one deal for a confirm repeated with the same key, and signs it once", async () => {
    const first = await signed();
    const again = await signed();
    expect(again).toMatchObject({ dealId: first.dealId, created: false });
    expect(store.deals).toHaveLength(1);
    expect(bestEffort).toHaveBeenCalledTimes(1);
  });

  it("signs a version a request that died left unsigned, when the same confirm comes a minute later", async () => {
    const first = await signed();
    bestEffort.mockClear();
    store.deal_versions[0].created_at = new Date(Date.now() - 120_000).toISOString();
    await signed();
    expect(bestEffort).toHaveBeenCalledTimes(1);
    expect(bestEffort.mock.calls[0][1]).toMatchObject({ action: "deal_signed", detail: { dealId: first.dealId, version: 1 } });
  });

  it("takes a new customer by name, using a client of that name again", async () => {
    await signed({ customer: { name: "acme studio" } });
    expect(requests("POST", "/rest/v1/counterparties")).toHaveLength(0);
    expect((requests("POST", "/rest/v1/rpc/create_deal")[0].body as { p_deal: { counterpartyId: string } }).p_deal.counterpartyId).toBe(CLIENT);
  });

  it("refuses before anything is written while 0104 has not run, and refuses a reference another deal has", async () => {
    store.override.deals = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.deals' in the schema cache" } };
    await expect(signed({ customer: { name: "Brand new" } })).rejects.toMatchObject({ code: "not_ready" });
    expect(requests("POST", "/rest/v1/counterparties")).toHaveLength(0);
    store.override.deals = undefined;
    await signed({ externalRef: "hubspot-1" });
    await expect(signed({ externalRef: "hubspot-1", idempotencyKey: "5f7c2b1e-1d8a-4b4e-9b0f-1c2d3e4f5a6b" })).rejects.toMatchObject({ code: "external_ref_taken" });
  });

  it("refuses a customer not in the workspace", async () => {
    await expect(signed({ customer: { id: "99999999-0000-4000-8000-000000000099" } })).rejects.toMatchObject({ code: "customer_not_found" });
  });
});

describe("changeDeal", () => {
  it("plans the change again from the deal as it is, writes it through revise_deal and signs deal_revised", async () => {
    const { dealId } = await signed();
    const [deposit, balance] = store.deal_lines;
    bestEffort.mockClear();
    const result = await run(() =>
      changeDeal({
        actorId: PERSON,
        change: {
          dealId,
          baseVersion: 1,
          kind: "revised",
          totalMinor: 1_200_000,
          reason: "Extra page",
          idempotencyKey: "rev-0000-0000-4000-8000-000000000001",
          lines: [
            { id: deposit.id as string, kind: "charge", label: "Deposit (30%)", invoiceOn: "2026-10-12", amountMinor: 300_000 },
            { id: balance.id as string, kind: "charge", label: "Balance on delivery", invoiceOn: "2026-12-01", amountMinor: 700_000 },
            { kind: "charge", label: "Price change", invoiceOn: "2026-12-01", amountMinor: 200_000 },
          ],
        },
      })
    );
    expect(result).toEqual({ version: 2, created: true, title: "Website rebuild", kind: "revised" });
    const call = requests("POST", "/rest/v1/rpc/revise_deal")[0].body as { p_base_version: number; p_revision: Record<string, unknown> };
    expect(call.p_base_version).toBe(1);
    expect(call.p_revision).toMatchObject({ kind: "revised", totalMinor: 1_200_000, end: [], add: [{ label: "Price change", amountMinor: 200_000, position: 3 }] });
    expect(bestEffort.mock.calls[0][1]).toMatchObject({
      action: "deal_revised",
      summary: "Changed the deal Website rebuild with Acme Studio (version 2): 10,000.00 USDC to 12,000.00 USDC",
      detail: { version: 2, kind: "revised", fromTotal: "10000.00", toTotal: "12000.00", difference: "2000.00", reason: "Extra page", ended: [] },
    });
  });

  it("answers a change repeated with the same key without a second version, and refuses a stale one", async () => {
    const { dealId } = await signed();
    const change = { dealId, baseVersion: 1, kind: "cancelled" as const, totalMinor: null, reason: null, lines: [], idempotencyKey: "rev-0000-0000-4000-8000-000000000002" };
    await run(() => changeDeal({ actorId: PERSON, change }));
    expect(await run(() => changeDeal({ actorId: PERSON, change }))).toMatchObject({ version: 2, created: false });
    expect(requests("POST", "/rest/v1/rpc/revise_deal")).toHaveLength(1);
    await expect(run(() => changeDeal({ actorId: PERSON, change: { ...change, idempotencyKey: "rev-0000-0000-4000-8000-000000000003" } }))).rejects.toMatchObject({ code: "changed" });
  });

  it("refuses a change the plan refuses, before anything is written", async () => {
    const { dealId } = await signed();
    await expect(
      run(() =>
        changeDeal({
          actorId: PERSON,
          change: {
            dealId,
            baseVersion: 1,
            kind: "revised",
            totalMinor: 1_000_000,
            reason: null,
            lines: [{ id: store.deal_lines[0].id as string, kind: "charge", label: "Deposit (30%)", invoiceOn: "2026-10-12", amountMinor: 300_000 }],
            idempotencyKey: "rev-0000-0000-4000-8000-000000000004",
          },
        })
      )
    ).rejects.toMatchObject({ code: "sum" });
    expect(requests("POST", "/rest/v1/rpc/revise_deal")).toHaveLength(0);
  });
});

describe("releaseDealLine", () => {
  it("claims the line, then adds the receivable naming the deal, signed as create_invoice", async () => {
    const { dealId } = await signed();
    const deposit = store.deal_lines[0];
    const released = await run(() => releaseDealLine({ actorId: PERSON, dealId, lineId: deposit.id as string, via: "person" }));
    expect(released).toMatchObject({ made: true, title: "Website rebuild", line: "Deposit (30%)", amount: "3,000.00 USDC" });
    expect(requests("PATCH", "/rest/v1/deal_lines")[0].params.get("status")).toBe("eq.planned");
    expect(deposit).toMatchObject({ status: "released", released_by: PERSON, released_via: "person" });
    const invoice = requests("POST", "/rest/v1/invoices")[0].body as Record<string, unknown>;
    expect(invoice).toMatchObject({ direction: "receivable", counterparty_id: CLIENT, amount: "3000.00", currency: "USDC", memo: "Website rebuild: Deposit (30%)", deal_id: dealId, deal_line_id: deposit.id });
    expect(invoice.due_date).toBe("2026-10-26T12:00:00.000Z");
    expect(append.mock.calls[0][0]).toMatchObject({
      actor: "human",
      domain: "ar",
      action: "create_invoice",
      detail: { via: "deal", deal: { dealId, lineId: deposit.id, version: 1, title: "Website rebuild", line: "Deposit (30%)", releasedBy: "person" } },
    });
  });

  it("answers the receivable already made for a line released twice", async () => {
    const { dealId } = await signed();
    const deposit = store.deal_lines[0];
    const first = await run(() => releaseDealLine({ actorId: PERSON, dealId, lineId: deposit.id as string, via: "person" }));
    await expect(run(() => releaseDealLine({ actorId: PERSON, dealId, lineId: deposit.id as string, via: "person" }))).rejects.toMatchObject({ code: "released" });
    expect(store.invoices).toHaveLength(1);
    expect(first.invoiceId).toBe(store.invoices[0].id);
  });

  it("undoes the claim when the receivable could not be added, and makes it at the next release", async () => {
    const { dealId } = await signed();
    const deposit = store.deal_lines[0];
    store.override.invoices = { status: 500, body: { code: "XX000", message: "connection reset" } };
    await expect(run(() => releaseDealLine({ actorId: PERSON, dealId, lineId: deposit.id as string, via: "person" }))).rejects.toThrow(/connection reset/);
    expect(deposit).toMatchObject({ status: "planned", released_at: null, released_via: null });
    store.override.invoices = undefined;
    await run(() => releaseDealLine({ actorId: PERSON, dealId, lineId: deposit.id as string, via: "person" }));
    expect(store.invoices).toHaveLength(1);
  });

  it("makes the receivable of a line left released without one", async () => {
    const { dealId } = await signed();
    Object.assign(store.deal_lines[0], { status: "released", released_at: "2026-10-12T09:00:00Z", released_via: "person" });
    const released = await run(() => releaseDealLine({ actorId: PERSON, dealId, lineId: store.deal_lines[0].id as string, via: "person" }));
    expect(released.made).toBe(true);
    expect(requests("PATCH", "/rest/v1/deal_lines")).toHaveLength(0);
  });

  it("refuses a cancelled deal's line and a credit", async () => {
    const { dealId } = await signed();
    store.deal_lines.push({ ...store.deal_lines[1], id: "credit00-0000-4000-8000-000000000001", position: 3, kind: "credit", amount_minor: -1 });
    await expect(run(() => releaseDealLine({ actorId: PERSON, dealId, lineId: "credit00-0000-4000-8000-000000000001", via: "person" }))).rejects.toMatchObject({ code: "credit" });
    store.deals[0].status = "cancelled";
    await expect(run(() => releaseDealLine({ actorId: PERSON, dealId, lineId: store.deal_lines[1].id as string, via: "person" }))).rejects.toMatchObject({ code: "deal_cancelled" });
  });

  it("takes a line in the business's own currency at its USDC amount, in shadow mode only", async () => {
    const yen = draft({
      currency: "JPY",
      digits: 0,
      totalMinor: 1_000_000,
      lines: [{ position: 1, kind: "charge", label: "All", invoiceOn: "2026-10-12", dueOn: "2026-10-26", amountMinor: 1_000_000, roundingMinor: 0 }],
    });
    const { dealId } = await run(() => confirmDeal({ actorId: PERSON, draft: yen }));
    const line = store.deal_lines[0].id as string;
    await expect(run(() => releaseDealLine({ actorId: PERSON, dealId, lineId: line, via: "person" }))).rejects.toMatchObject({ code: "shadow" });
    expect(store.deal_lines[0].status).toBe("planned");
    store.shadow_modes.push({ currency: "JPY", started_at: "2026-10-01T00:00:00Z", started_by: PERSON });
    await run(() => releaseDealLine({ actorId: PERSON, dealId, lineId: line, via: "person" }));
    expect(store.invoices[0]).toMatchObject({ amount: "6666.67", currency: "USDC", original_currency: "JPY", original_amount: 1_000_000, fx_rate: 150 });
  });
});

describe("the agent's release on a line's day", () => {
  it("releases nothing where the switch is off, and the lines whose day came as the agent where it is on", async () => {
    const { dealId } = await signed({ autoRelease: false });
    expect(await run(() => releaseDueDealLines(db(), new Date("2026-11-01T10:00:00Z")))).toEqual([]);
    await run(() => switchDealAutoRelease({ actorId: PERSON, dealId, on: true }));
    expect(bestEffort.mock.calls.at(-1)?.[1]).toMatchObject({ action: "deal_auto_release_changed", detail: { by: PERSON, dealId, on: true } });
    const log = await run(() => releaseDueDealLines(db(), new Date("2026-11-01T10:00:00Z")));
    expect(log).toEqual([{ domain: "ar", message: "Acme Studio: released Deposit (30%) of the deal Website rebuild as a receivable (3,000.00 USDC)" }]);
    expect(store.deal_lines.map((line) => line.status)).toEqual(["released", "planned"]);
    expect(store.deal_lines[0]).toMatchObject({ released_by: null, released_via: "schedule" });
    expect(append.mock.calls[0][0]).toMatchObject({ actor: "agent", action: "create_invoice", detail: { deal: { releasedBy: "schedule" } } });
  });

  it("does nothing before 0104 runs", async () => {
    store.override.deals = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.deals' in the schema cache" } };
    expect(await run(() => releaseDueDealLines(db()))).toEqual([]);
  });
});

describe("reading a deal", () => {
  it("joins each line to the receivable it became", async () => {
    const { dealId } = await signed();
    await run(() => releaseDealLine({ actorId: PERSON, dealId, lineId: store.deal_lines[0].id as string, via: "person" }));
    const read = await run(() => readDeal(dealId));
    if (!read.available || !read.deal) throw new Error("not read");
    expect(read.deal.facts.lines[0].receivable).toMatchObject({ id: store.invoices[0].id, status: "pending" });
    expect(read.deal.customer).toEqual({ id: CLIENT, name: "Acme Studio" });
    expect(read.deal.versions).toHaveLength(1);
  });

  it("finds no deal for a malformed id", async () => {
    expect(await run(() => readDeal("not-a-uuid"))).toEqual({ available: true, deal: null });
  });

  it("reads every line once when the workspace's lines take more than one page", async () => {
    // 18 retainers of 60 months: 1,080 lines, so two pages of 1,000. Every deal has a line at position 1, and so on.
    const deals = Array.from({ length: 18 }, (_, index) => `dddddddd-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    for (const [index, id] of deals.entries()) {
      store.deals.push({
        id,
        counterparty_id: CLIENT,
        title: `Retainer ${index + 1}`,
        currency: "USDC",
        minor_digits: 2,
        total_minor: 60 * 100_000,
        starts_on: "2026-10-01",
        terms_days: 14,
        external_ref: null,
        template: "retainer",
        status: "active",
        current_version: 1,
        auto_release: false,
        auto_release_by: null,
        auto_release_at: null,
        created_by: PERSON,
        created_at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
      });
      store.deal_versions.push({ deal_id: id, version: 1, kind: "signed", total_minor: 60 * 100_000, reason: null, changes: [], created_by: PERSON, created_at: "2026-10-01T00:00:00Z" });
      for (let position = 1; position <= 60; position += 1) {
        store.deal_lines.push({
          id: `${String(position).padStart(8, "0")}-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          deal_id: id,
          added_in: 1,
          position,
          kind: "charge",
          label: `Month ${position}`,
          invoice_on: "2026-11-01",
          due_on: "2026-11-15",
          amount_minor: 100_000,
          rounding_minor: 0,
          replaces: null,
          status: "planned",
          ended_in: null,
          released_at: null,
          released_via: null,
        });
      }
    }
    // PostgREST pages as Postgres sorts: rows that tie on every key named come in whatever order the plan gives, which
    // need not be the same for the first page and the second.
    const base = dealStoreResponder(store);
    fake = fakeSupabase((request) => {
      const reply = base(request);
      const name = request.path.replace("/rest/v1/", "");
      if (request.method !== "GET" || (name !== "deal_lines" && name !== "deal_versions")) return reply;
      const keys = (request.params.get("order") ?? "").split(",").filter(Boolean).map((part) => part.split(".")[0]);
      const offset = Number(request.params.get("offset") ?? 0);
      const limit = Number(request.params.get("limit") ?? 1_000_000);
      const tie = (row: Record<string, unknown>) => [...`${offset}:${String(row.id)}`].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16_777_619) >>> 0, 2_166_136_261);
      const rows = [...(reply.body as Array<Record<string, unknown>>)].sort((a, b) => {
        for (const key of keys) {
          const [x, y] = [a[key] as string | number, b[key] as string | number];
          if (x !== y) return x < y ? -1 : 1;
        }
        return tie(a) - tie(b);
      });
      return { body: rows.slice(offset, offset + limit) };
    });
    const read = await run(() => readDeals());
    if (!read.available) throw new Error("not read");
    expect(read.deals).toHaveLength(18);
    for (const record of read.deals) expect(new Set(record.facts.lines.map((line) => line.id)).size, record.title).toBe(60);
    expect(plannedLinesOf(read.deals).reduce((sum, line) => sum + line.amount, 0)).toBe(18 * 60 * 1000);
  });

  it("is a DealError a person can read", () => {
    expect(new DealError("not_ready").message).toBe("Deals are not set up on this deployment yet.");
  });
});
