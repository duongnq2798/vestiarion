import { beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { projectedReceivableInflow } from "@/lib/allocations/book";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The cycle's forecast of money in (`projected_inflow`, shown on Treasury as "Expected in" and in GET /api/v1/treasury):
 * a part-paid receivable is expected for what is still owed, since what arrived is in the wallet already and counting
 * the whole would count it twice (docs/superpowers/specs/2026-10-12-allocations-design.md L11).
 */

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a12";
const MISSING = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.receivable_allocations' in the schema cache" } };

const OPEN = [
  { id: "inv-1", amount: "12.500000", currency: "USDC" },
  { id: "inv-2", amount: "100.000000", currency: null },
  { id: "inv-3", amount: "40.000000", currency: "EURC" },
];
const row = (over: Record<string, unknown>) => ({
  id: "alloc-1",
  kind: "payment",
  invoice_id: "inv-1",
  transfer_id: "transfer-1",
  amount: "5.000000",
  currency: "USDC",
  reverses: null,
  reason: null,
  basis: "person",
  payment_seq: 1,
  created_by: "person-1",
  created_at: "2026-10-09T09:00:00Z",
  ...over,
});

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
const world = (allocations: FakeReply) =>
  fakeSupabase((r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/invoices") return { body: OPEN };
    if (r.path === "/rest/v1/receivable_allocations") return allocations;
    return { body: [] };
  });

describe("projectedReceivableInflow", () => {
  beforeEach(() => {
    fake = world({ body: [] });
  });

  it("adds up open USDC receivables, never EURC", async () => {
    expect(await run(() => projectedReceivableInflow(db()))).toBe(112.5);
    const read = fake.requests.find((r) => r.path === "/rest/v1/invoices")!;
    expect(read.params.get("direction")).toBe("eq.receivable");
    expect(read.params.get("status")).toBe("in.(pending,matched)");
  });

  it("expects a part-paid receivable for what is still owed: payments and fees applied, less reversals", async () => {
    fake = world({
      body: [
        row({}),
        row({ id: "fee-1", kind: "fee", transfer_id: null, amount: "0.500000", reason: "Transfer fee", basis: null, payment_seq: null, created_at: "2026-10-09T09:01:00Z" }),
        row({ id: "alloc-2", invoice_id: "inv-2", amount: "30.000000", payment_seq: 2 }),
        row({ id: "rev-2", kind: "reversal", invoice_id: "inv-2", amount: "30.000000", reverses: "alloc-2", reason: "Wrong invoice", basis: null, payment_seq: 3, created_at: "2026-10-09T10:00:00Z" }),
      ],
    });
    expect(await run(() => projectedReceivableInflow(db()))).toBe(107);
  });

  it("adds up the whole of each before migration 0103 runs", async () => {
    fake = world(MISSING);
    expect(await run(() => projectedReceivableInflow(db()))).toBe(112.5);
  });
});
