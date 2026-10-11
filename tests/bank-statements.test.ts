import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { previewStatement, readStatementSetup, recordStatementLine, statementLineHash } from "@/lib/bank-statements";
import { readStatement } from "@/lib/bank-statement/lines";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The bank statement import over the database (docs/superpowers/specs/2026-10-10-bank-statement-design.md B6, B8, B9,
 * B11): the bills the report counts, each with its newest record; the lines of the statement kept already, by their
 * hash; a line kept, or found kept and unused, before its record; and before migration 0094, a plain not-set-up.
 */

const { ledgerMock, canSign } = vi.hoisted(() => ({ ledgerMock: vi.fn(), canSign: vi.fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));
vi.mock("@/lib/ledger", async (original) => ({ ...(await original<typeof import("@/lib/ledger")>()), assertLedgerCanSign: canSign }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b01";
const PERSON = "a1b2c3d4-0000-4000-8000-0000000000b1";
const NORTH = "018f8ce0-1557-7b54-a931-4d777f6bb001";
const ATLAS = "018f8ce0-1557-7b54-a931-4d777f6bb002";
const SAMPLE = "018f8ce0-1557-7b54-a931-4d777f6bb003";
const TODAY = "2026-10-11";
const MISSING = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.bank_statement_lines' in the schema cache" } };

const STATEMENT = ["Date,Description,Amount,Balance", "03/10/2026,GIRO NORTHWIND CLOUD,-1250.00,3750.00", "05/10/2026,ATLAS COMPUTE,-45.50,3704.50", "06/10/2026,Refund,20.00,3724.50"].join("\n");
const CHOICES = { currency: "SGD", dateOrder: "dmy" as const };

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: PERSON }), fn);

type Row = Record<string, unknown>;
const invoice = (id: string, payee: string, amount: number, sample = false): Row => ({
  id,
  memo: null,
  amount,
  currency: "SGD",
  original_currency: null,
  original_amount: null,
  due_date: "2026-10-15T00:00:00Z",
  created_at: "2026-10-01T09:00:00Z",
  counterparties: { name: payee, sample },
});

function workspace(over: { invoices?: Row[]; records?: Row[]; kept?: Row[]; used?: Row[]; lines?: FakeReply; lineInsert?: FakeReply } = {}) {
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/invoices") {
      // recordActual reads the one payable it records.
      if (r.params.get("id")) return { body: [{ id: r.params.get("id")!.slice(3), direction: "payable" }] };
      return { body: over.invoices ?? [invoice(NORTH, "Northwind Cloud", 1250), invoice(ATLAS, "Atlas Compute", 45.5), invoice(SAMPLE, "Sample Supplier", 1250, true)] };
    }
    if (r.path === "/rest/v1/payment_actuals" && r.method === "GET") {
      if (r.params.get("statement_line_id")) return { body: over.used ?? [] };
      return { body: over.records ?? [] };
    }
    if (r.path === "/rest/v1/payment_actuals" && r.method === "POST") return { status: 201, body: { id: "rec-new", recorded_at: "2026-10-11T08:00:00.000Z", ...(r.body as Row) } };
    if (r.path === "/rest/v1/bank_statement_lines" && r.method === "GET") return over.lines ?? { body: over.kept ?? [] };
    if (r.path === "/rest/v1/bank_statement_lines" && r.method === "POST") return over.lineInsert ?? { status: 201, body: { id: "line-new" } };
    return { body: [] };
  };
}

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  canSign.mockReset();
});

describe("readStatementSetup", () => {
  it("says the import is set up, with the accounts named before, newest first, once each", async () => {
    fake = fakeSupabase(workspace({ kept: [{ account: "DBS operating" }, { account: "Wise EUR" }, { account: "DBS operating" }] }));
    expect(await run(() => readStatementSetup(db()))).toEqual({ available: true, accounts: ["DBS operating", "Wise EUR"] });
  });

  it("says it is not set up before migration 0094, when the table or the column is not there", async () => {
    fake = fakeSupabase(workspace({ lines: MISSING }));
    expect(await run(() => readStatementSetup(db()))).toEqual({ available: false, accounts: [] });
    fake = fakeSupabase((r) =>
      r.path === "/rest/v1/payment_actuals" ? { status: 400, body: { code: "42703", message: "column payment_actuals.statement_line_id does not exist" } } : { body: [] }
    );
    expect(await run(() => readStatementSetup(db()))).toEqual({ available: false, accounts: [] });
  });
});

describe("previewStatement", () => {
  it("matches the money-out lines against the real bills, never the sample data beside them", async () => {
    fake = fakeSupabase(workspace());
    const preview = await run(() => previewStatement({ account: "DBS operating", text: STATEMENT, choices: CHOICES, today: TODAY }));
    expect(preview.matches?.map((match) => (match.status === "matched" ? `${match.status}:${match.candidate.invoiceId}` : match.status))).toEqual([
      `matched:${NORTH}`,
      `matched:${ATLAS}`,
      "money_in",
    ]);
    // Read inside the workspace's scope.
    expect(fake.requests.filter((r) => r.path === "/rest/v1/invoices").every((r) => r.params.get("org_id") === `eq.${ORG}`)).toBe(true);
  });

  it("says a line of an earlier import is already used, by its hash, with its bill", async () => {
    const read = readStatement(STATEMENT, CHOICES, TODAY);
    const hash = statementLineHash("dbs  Operating", read.lines[0]);
    fake = fakeSupabase(workspace({ kept: [{ id: "line-1", line_hash: hash }], used: [{ statement_line_id: "line-1", invoice_id: NORTH }] }));
    const preview = await run(() => previewStatement({ account: "DBS operating", text: STATEMENT, choices: CHOICES, today: TODAY }));
    expect(preview.matches?.[0]).toEqual({ line: 2, status: "used", invoiceId: NORTH, payee: "Northwind Cloud" });
    expect(fake.requests.find((r) => r.path === "/rest/v1/bank_statement_lines" && r.params.has("line_hash"))?.params.get("line_hash")).toContain(hash);
  });

  it("matches a line kept whose record never came as a fresh one", async () => {
    const read = readStatement(STATEMENT, CHOICES, TODAY);
    fake = fakeSupabase(workspace({ kept: [{ id: "line-1", line_hash: statementLineHash("DBS operating", read.lines[0]) }], used: [] }));
    const preview = await run(() => previewStatement({ account: "DBS operating", text: STATEMENT, choices: CHOICES, today: TODAY }));
    expect(preview.matches?.[0].status).toBe("matched");
  });

  it("matches nothing until the questions are answered", async () => {
    fake = fakeSupabase(workspace());
    const preview = await run(() => previewStatement({ account: "DBS operating", text: STATEMENT, choices: {}, today: TODAY }));
    expect(preview.read.problems).toEqual(["Type the account's currency, such as SGD, EUR or USDC."]);
    expect(preview.matches).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses with not_ready before migration 0094 runs", async () => {
    fake = fakeSupabase(workspace({ lines: MISSING }));
    await expect(run(() => previewStatement({ account: "DBS operating", text: STATEMENT, choices: CHOICES, today: TODAY }))).rejects.toMatchObject({
      code: "not_ready",
      message: "Importing a bank statement is not set up on this deployment yet.",
    });
  });
});

describe("recordStatementLine", () => {
  const read = readStatement(STATEMENT, CHOICES, TODAY);

  it("keeps the line, then records the payment naming it, as a bank transfer on the booking day", async () => {
    fake = fakeSupabase(workspace());
    const result = await run(() => recordStatementLine({ actorId: PERSON, account: "DBS operating", line: read.lines[0], invoiceId: NORTH, replaces: null, today: TODAY }));
    expect(result.corrected).toBe(false);
    const kept = fake.requests.find((r) => r.path === "/rest/v1/bank_statement_lines" && r.method === "POST");
    expect(kept?.body).toEqual({
      org_id: ORG,
      account: "DBS operating",
      booked_on: "2026-10-03",
      value_on: null,
      amount: -1250,
      currency: "SGD",
      description: "GIRO NORTHWIND CLOUD",
      payee: null,
      reference: null,
      balance: 3750,
      file_line: 2,
      line_hash: statementLineHash("DBS operating", read.lines[0]),
      imported_by: PERSON,
    });
    const recorded = fake.requests.find((r) => r.path === "/rest/v1/payment_actuals" && r.method === "POST");
    expect(recorded?.body).toMatchObject({ invoice_id: NORTH, outcome: "paid", paid_on: "2026-10-03", amount: 1250, currency: "SGD", method: "bank_transfer", source: "statement", statement_line_id: "line-new" });
    expect(ledgerMock.mock.calls[0][1].detail).toMatchObject({
      via: "statement",
      statementLine: { id: "line-new", account: "DBS operating", line: 2, bookedOn: "2026-10-03", valueOn: null, amount: -1250, currency: "SGD", description: "GIRO NORTHWIND CLOUD", payee: null, reference: null, balance: 3750 },
    });
    // The key that signs the entry is checked before the line is kept.
    expect(canSign).toHaveBeenCalled();
  });

  it("uses a line kept before whose record never came", async () => {
    fake = fakeSupabase(
      workspace({ lineInsert: { status: 409, body: { code: "23505", message: "duplicate key value violates unique constraint \"bank_statement_lines_line_hash_key\"" } }, kept: [{ id: "line-old" }] })
    );
    await run(() => recordStatementLine({ actorId: PERSON, account: "DBS operating", line: read.lines[0], invoiceId: NORTH, replaces: null, today: TODAY }));
    expect(fake.requests.find((r) => r.path === "/rest/v1/payment_actuals" && r.method === "POST")?.body).toMatchObject({ statement_line_id: "line-old" });
  });

  it("refuses with not_ready when the table is not there", async () => {
    fake = fakeSupabase(workspace({ lineInsert: MISSING }));
    await expect(run(() => recordStatementLine({ actorId: PERSON, account: "DBS operating", line: read.lines[0], invoiceId: NORTH, replaces: null, today: TODAY }))).rejects.toMatchObject({
      code: "not_ready",
    });
  });
});
