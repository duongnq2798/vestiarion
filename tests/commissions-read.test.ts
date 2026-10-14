import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { reviewCommissions } from "@/lib/commissions/model";
import { readCommissions } from "@/lib/commissions/read";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * The commissions page's read past PostgREST's 1,000 rows (docs/superpowers/specs/2026-10-14-commissions-design.md C10):
 * every open line is read, a page at a time, so what is due is all of it and Create payable names exactly the lines
 * `create_commission_payout` counts; lines in a live payout are not read at all, and a rejected payout's lines are.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c55";
const PAT = "018f8ce0-1557-7b54-a931-4d777f6bc201";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function line(n: number, fields: Record<string, unknown> = {}) {
  return {
    id: id(n), kind: "accrual", plan_id: "plan", beneficiary_id: PAT, invoice_id: id(900_000), deal_id: "deal", source: "payment",
    allocation_id: id(100_000 + n), transfer_id: null, adjusts: null, basis: "net", base_amount: "10.000000", rate_bps: 1000, amount: "1.000000",
    currency: "USDC", applied_at: "2026-09-01T10:00:00+00:00", due_at: "2026-10-01T10:00:00+00:00", reason: null, payout_id: null, ...fields,
  };
}

/** 1,500 open lines, a payout whose payable was rejected with 2 lines, and a paid payout. */
const OPEN = Array.from({ length: 1500 }, (_, index) => line(index + 1));
const REJECTED = [line(5001, { payout_id: "payout-rejected" }), line(5002, { payout_id: "payout-rejected" })];

function respond(request: RecordedRequest) {
  const offset = Number(request.params.get("offset") ?? 0);
  const limit = Number(request.params.get("limit") ?? 1000);
  const page = <T,>(rows: T[]) => rows.slice(offset, offset + Math.min(limit, 1000));
  if (request.path === "/rest/v1/commission_lines") {
    if (request.params.get("payout_id") === "is.null") return { body: page(OPEN) };
    if (request.params.get("payout_id") === "eq.payout-rejected") return { body: page(REJECTED) };
    return { body: [] };
  }
  if (request.path === "/rest/v1/commission_payouts") {
    return {
      body: page([
        { id: "payout-rejected", beneficiary_id: PAT, invoice_id: "bill-1", statement: "CS-00000001", currency: "USDC", amount: "2.000000", line_count: 2, created_by: null, created_at: "2026-10-02T00:00:00Z", invoices: { status: "rejected" } },
        { id: "payout-paid", beneficiary_id: PAT, invoice_id: "bill-2", statement: "CS-00000002", currency: "USDC", amount: "9.000000", line_count: 9, created_by: null, created_at: "2026-10-03T00:00:00Z", invoices: { status: "paid" } },
      ]),
    };
  }
  if (request.path === "/rest/v1/counterparties") return { body: page([{ id: PAT, name: "Pat Referrals", role: "vendor" }]) };
  if (request.path === "/rest/v1/invoices") return { body: [{ id: id(900_000), memo: "INV-1", amount: "100000", currency: "USDC", counterparty_id: PAT }] };
  return { body: [] };
}

describe("readCommissions", () => {
  it("reads every open line a page at a time, and the lines of a rejected payout, never a live payout's", async () => {
    const fake = fakeSupabase(respond);
    const read = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => readCommissions());
    if (!read.available) throw new Error("read as not set up");
    expect(read.lines).toHaveLength(1502);
    const pages = fake.requests.filter((request) => request.path === "/rest/v1/commission_lines" && request.params.get("payout_id") === "is.null");
    expect(pages.map((request) => request.params.get("offset"))).toEqual(["0", "1000"]);
    expect(fake.requests.some((request) => request.path === "/rest/v1/commission_lines" && request.params.get("payout_id") === "eq.payout-paid")).toBe(false);
    expect(read.payouts.map((payout) => [payout.statement, payout.invoiceStatus, payout.lineCount])).toEqual([
      ["CS-00000001", "rejected", 2],
      ["CS-00000002", "paid", 9],
    ]);
    // What is due is every open line: 1,502.00 USDC of commission, as create_commission_payout counts it.
    const [review] = reviewCommissions(read.lines, read.payouts, new Date("2026-10-14T00:00:00Z"));
    expect(review.due).toHaveLength(1502);
    expect(review.dueTotal).toBe(1502_000_000);
    // Each `in` read names at most 100 ids.
    for (const request of fake.requests.filter((sent) => sent.params.get("id")?.startsWith("in."))) {
      expect((request.params.get("id") as string).split(",").length).toBeLessThanOrEqual(100);
    }
  });
});
