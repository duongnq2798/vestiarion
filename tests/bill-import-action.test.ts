import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkBillListAction, importBillListAction } from "@/app/actions/bill-import";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { ImportSettings } from "@/lib/bill-import/rows";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * The check and the import of a bill list (import design B11, B12), against a real supabase-js client whose network is
 * a workspace held in memory: counterparties, the invoices already added, shadow mode in yen. The check writes
 * nothing; the import adds each row through `addInvoice`, with a signed `create_invoice` entry naming the list; the
 * same list imported again adds nothing.
 */

const { ORG, USER, mocks } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000b11",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b1",
  mocks: { authorize: vi.fn(), ledger: vi.fn(), rate: vi.fn(), runCycleSoon: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: mocks.authorize }));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: mocks.runCycleSoon }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: mocks.ledger }));
vi.mock("@/lib/fx/usd-rates", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/fx/usd-rates")>()), usdRate: mocks.rate }));

const FIXTURE = readFileSync(path.join(process.cwd(), "tests", "fixtures", "bill-import", "bills-100.csv"), "utf8");
const SETTINGS: ImportSettings = {
  hasHeader: true,
  mapping: { counterparty: 0, invoiceNumber: 1, memo: 2, dueDate: 3, amount: 4, currency: 5, poReference: 6 },
  direction: "payable",
  dateOrder: "dmy",
  decimalMark: null,
  currency: "JPY",
  goodsReceived: false,
};

const KANTO = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1";
const LION = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c2";
const COUNTERPARTIES = [
  { id: KANTO, name: "Kanto Paper Co., Ltd." },
  { id: LION, name: "Lion City Logistics Pte Ltd" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c3", name: "Manila Print House" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c4", name: "Seoul Office Supply" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c5", name: "Penang Parts Sdn Bhd" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c6", name: "Northwind Hosting" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c7", name: "Northwind Hosting" },
];

type StoredInvoice = Record<string, unknown> & { id: string };

/** A workspace in memory, answered the way PostgREST answers: numeric columns come back as numbers. */
function workspace(options: { shadow?: string | null } = {}) {
  const invoices: StoredInvoice[] = [
    {
      id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000e0001", counterparty_id: KANTO, due_date: "2026-10-20T12:00:00+00:00", amount: 586.67, currency: "USDC",
      original_amount: 88000, original_currency: "JPY", po_reference: null, memo: "Invoice KP-2001: Paper",
    },
    {
      id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000e0002", counterparty_id: LION, due_date: "2026-11-05T12:00:00+00:00", amount: 2500, currency: "USDC",
      original_amount: null, original_currency: null, po_reference: "PO-777", memo: "Freight",
    },
  ];
  const shadow = options.shadow === undefined ? "JPY" : options.shadow;
  const respond = (sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") {
      return { body: { id: ORG, slug: "kanto", name: "Kanto", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
    }
    if (sent.path === "/rest/v1/shadow_modes") return { body: shadow ? [{ currency: shadow, started_at: "2026-10-07T00:00:00Z", started_by: USER }] : [] };
    if (sent.path === "/rest/v1/counterparties") {
      const id = sent.params.get("id");
      const found = id ? COUNTERPARTIES.filter((row) => id === `eq.${row.id}`) : COUNTERPARTIES;
      const wantsObject = sent.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
      return { body: wantsObject ? found[0] ?? null : found };
    }
    if (sent.path === "/rest/v1/invoices" && sent.method === "POST") {
      const row = sent.body as Record<string, unknown>;
      const stored: StoredInvoice = {
        ...row,
        id: `0b6c1c9e-4a4f-4a7e-9b1e-${String(invoices.length + 1).padStart(12, "0")}`,
        amount: Number(row.amount),
        original_amount: row.original_amount ?? null,
        original_currency: row.original_currency ?? null,
      };
      invoices.push(stored);
      return { body: { id: stored.id } };
    }
    if (sent.path === "/rest/v1/invoices") return { body: invoices };
    return { body: [] };
  };
  const fake = fakeSupabase(respond);
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, invoices, run };
}

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key", SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const inserts = (fake: ReturnType<typeof fakeSupabase>) => fake.requests.filter((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST");

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockResolvedValue({
    ok: true,
    user: { id: USER, email: null },
    membership: { orgId: ORG, slug: "kanto", name: "Kanto", mode: "live", role: "owner" },
  });
  mocks.ledger.mockResolvedValue(undefined);
  mocks.rate.mockImplementation(async (currency: string) => ({ currency, perUsd: 150, source: "ExchangeRate-API", at: "2026-10-10T00:02:31.000Z" }));
});

describe("checkBillListAction", () => {
  it("gives every row its fate and writes nothing", async () => {
    const { fake, run } = workspace();
    const result = await run(() => checkBillListAction("kanto", FIXTURE, SETTINGS));
    expect(result).toMatchObject({ ok: true, counts: { add: 84, duplicate: 3, error: 13 } });
    expect(result.fates).toHaveLength(100);
    expect(inserts(fake)).toEqual([]);
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(mocks.runCycleSoon).not.toHaveBeenCalled();
    // The invoices a row could repeat are read in the workspace's scope, for the rows' counterparties and days only.
    const read = fake.requests.find((sent) => sent.path === "/rest/v1/invoices" && sent.method === "GET");
    expect(read?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(read?.params.get("counterparty_id")).toMatch(/^in\.\(/);
    expect(read?.params.get("counterparty_id")).toContain(KANTO);
    expect(read?.params.getAll("due_date")).toEqual(["gte.2026-10-13T00:00:00.000Z", "lte.2026-12-27T23:59:59.999Z"]);
    // The day's rate is read once for the yen, not once per bill.
    expect(mocks.rate).toHaveBeenCalledTimes(1);
    expect(mocks.rate).toHaveBeenCalledWith("JPY");
  });

  it("says what is still to be answered, and reads no further", async () => {
    const { fake, run } = workspace();
    const result = await run(() => checkBillListAction("kanto", FIXTURE, { ...SETTINGS, dateOrder: null }));
    expect(result).toEqual({ ok: false, message: "Choose whether the list's dates are day first or month first." });
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/invoices")).toBe(false);
  });

  it("refuses answers it cannot read, and a list larger than 1 MB", async () => {
    const { run } = workspace();
    expect(await run(() => checkBillListAction("kanto", FIXTURE, { ...SETTINGS, mapping: "everything" }))).toEqual({
      ok: false, message: "The answers could not be read. Choose the columns again.",
    });
    expect(await run(() => checkBillListAction("kanto", "x".repeat(1_000_001), SETTINGS))).toEqual({ ok: false, message: "The list must be smaller than 1 MB." });
  });

  it("refuses someone who may not add invoices", async () => {
    mocks.authorize.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (approver) cannot do that." });
    const { fake, run } = workspace();
    expect(await run(() => checkBillListAction("kanto", FIXTURE, SETTINGS))).toEqual({ ok: false, message: "Your role in this workspace (approver) cannot do that." });
    expect(fake.requests).toEqual([]);
  });
});

describe("importBillListAction", () => {
  it("adds each row through addInvoice, with a signed entry naming the list and the row, and starts the agent", async () => {
    const { fake, invoices, run } = workspace();
    const result = await run(() => importBillListAction("kanto", FIXTURE, SETTINGS));

    expect(result).toMatchObject({ ok: true, message: "Added 84 bills. 3 were already in Vestiarion. 13 can't be added.", counts: { added: 84, duplicate: 3, error: 13 } });
    expect(inserts(fake)).toHaveLength(84);
    expect(invoices).toHaveLength(86);
    expect(mocks.ledger).toHaveBeenCalledTimes(84);
    const file = createHash("sha256").update(FIXTURE, "utf8").digest("hex");
    expect(mocks.ledger.mock.calls[0][0]).toMatchObject({
      actor: "human",
      action: "create_invoice",
      detail: {
        by: USER, counterpartyId: KANTO, amount: "666.67", currency: "USDC", via: "import", importFile: file, importRow: 2, invoiceNumber: "KP-1000",
        bill: { currency: "JPY", amount: 100000, perUsd: 150, source: "ExchangeRate-API" },
      },
    });
    expect(inserts(fake)[0].body).toMatchObject({
      org_id: ORG, counterparty_id: KANTO, amount: "666.67", currency: "USDC", memo: "Invoice KP-1000: Copy paper", po_reference: "PO-300",
      goods_received: false, due_date: "2026-10-13T12:00:00.000Z", original_currency: "JPY", original_amount: 100000, fx_rate: 150, created_by: USER,
    });
    // A USDC bill exactly as the list wrote it; no bill figure beside it.
    const usdc = inserts(fake).find((sent) => (sent.body as Record<string, unknown>).memo === "Invoice MP-1002: Brochures")?.body;
    expect(usdc).toMatchObject({ amount: "1021", currency: "USDC" });
    expect(usdc).not.toHaveProperty("original_currency");
    expect(mocks.runCycleSoon).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, kind: "invoice_added" }));

    const added = result.fates?.filter((fate) => fate.status === "added") ?? [];
    expect(added).toHaveLength(84);
    expect(added[0]).toMatchObject({ line: 2, invoiceId: invoices[2].id });
  });

  it("adds nothing the second time the same list is imported: each row keeps the invoice it became", async () => {
    const { fake, invoices, run } = workspace();
    const first = await run(() => importBillListAction("kanto", FIXTURE, SETTINGS));
    const again = await run(() => importBillListAction("kanto", FIXTURE, SETTINGS));

    expect(again).toMatchObject({ ok: true, message: "Added no bills. 87 were already in Vestiarion. 13 can't be added.", counts: { added: 0, duplicate: 87, error: 13 } });
    expect(inserts(fake)).toHaveLength(84);
    expect(invoices).toHaveLength(86);
    const ids = new Map(first.fates?.flatMap((fate) => (fate.status === "added" ? [[fate.line, fate.invoiceId] as const] : [])));
    for (const fate of again.fates ?? []) {
      if (ids.has(fate.line)) expect(fate).toMatchObject({ status: "duplicate", invoiceId: ids.get(fate.line) });
    }
  });

  it("refuses a bill in yen outside shadow mode, and adds the rest", async () => {
    const { fake, run } = workspace({ shadow: null });
    const result = await run(() => importBillListAction("kanto", FIXTURE, { ...SETTINGS, currency: "USDC" }));
    expect(result.ok).toBe(true);
    const yen = result.fates?.find((fate) => fate.line === 2);
    expect(yen).toMatchObject({ status: "error", reason: "Bills in JPY are taken in shadow mode only. Turn it on for JPY in Settings, or convert the amount to USDC." });
    expect(inserts(fake).every((sent) => ["USDC", "EURC"].includes((sent.body as Record<string, unknown>).currency as string))).toBe(true);
    expect(mocks.rate).not.toHaveBeenCalled();
  });

  it("says why a row the command refused was not added, and still adds the others", async () => {
    mocks.ledger.mockRejectedValueOnce(new Error("ledger down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = workspace();
    const result = await run(() => importBillListAction("kanto", FIXTURE, SETTINGS));
    expect(result.counts).toEqual({ added: 83, duplicate: 3, error: 14 });
    expect(result.fates?.find((fate) => fate.line === 2)).toMatchObject({ status: "error", reason: "The invoice could not be added. Try again in a moment." });
    log.mockRestore();
  });

  it("refuses someone who may not add invoices, and writes nothing", async () => {
    mocks.authorize.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });
    const { fake, run } = workspace();
    expect(await run(() => importBillListAction("kanto", FIXTURE, SETTINGS))).toEqual({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });
    expect(fake.requests).toEqual([]);
  });
});
