import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { readStatement } from "@/lib/bank-statement/lines";
import type { Candidate, LineMatch } from "@/lib/bank-statement/match";
import { StatementImportError } from "@/lib/bank-statements";
import type { Actor } from "@/lib/commands/actor";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import { importBankStatement } from "@/lib/commands/statements";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Importing a bank statement as a command (docs/superpowers/specs/2026-10-10-bank-statement-design.md B8): the roles
 * that record what the business paid (`records.write`: owners and admins), from the console only; the gate runs before
 * anything is read; the server reads and matches the statement again, and saves a ticked pair only while that bill is
 * still one of that line's candidates and no line or bill is in two pairs.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { matchStatementNow: vi.fn(), recordStatementLine: vi.fn() } }));
vi.mock("@/lib/bank-statements", async (original) => ({
  ...(await original<typeof import("@/lib/bank-statements")>()),
  matchStatementNow: mocks.matchStatementNow,
  recordStatementLine: mocks.recordStatementLine,
}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c71";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c7";
const NORTH = "018f8ce0-1557-7b54-a931-4d777f6bc001";
const ATLAS = "018f8ce0-1557-7b54-a931-4d777f6bc002";
const KESTREL = "018f8ce0-1557-7b54-a931-4d777f6bc003";
const OTHER = "018f8ce0-1557-7b54-a931-4d777f6bc004";
const ELSE = "018f8ce0-1557-7b54-a931-4d777f6bc005";
const TODAY = "2026-10-11";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);
const actor = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "owner", mode: "live", surface: { kind: "console" }, ...fields });

const TEXT = ["Date,Description,Amount", "2026-10-03,NORTHWIND,-1250.00", "2026-10-04,ATLAS,-45.50", "2026-10-05,GIRO,-80.00", "2026-10-06,Refund,20.00"].join("\n");
const CHOICES = { currency: "SGD" };
const read = readStatement(TEXT, CHOICES, TODAY);
const candidate = (invoiceId: string, over: Partial<Candidate> = {}): Candidate => ({
  invoiceId,
  payee: "Supplier",
  bill: { amount: 1, currency: "SGD" },
  dueDate: null,
  exact: true,
  name: 0,
  number: null,
  replaces: null,
  why: [],
  ...over,
});
const MATCHES: LineMatch[] = [
  { line: 2, status: "matched", candidate: candidate(NORTH, { replaces: "rec-9" }), ticked: true },
  { line: 3, status: "used", invoiceId: ATLAS, payee: "Atlas" },
  { line: 4, status: "choose", candidates: [candidate(ATLAS), candidate(KESTREL)] },
  { line: 5, status: "money_in" },
];
const INPUT = { account: "DBS operating", text: TEXT, choices: CHOICES, today: TODAY };

beforeEach(() => {
  mocks.matchStatementNow.mockReset().mockResolvedValue({ read, matches: MATCHES, hashes: [] });
  mocks.recordStatementLine.mockReset().mockResolvedValue({ corrected: false });
});

describe("who may import a bank statement", () => {
  it("is the permission that records what the business paid, from the console only", () => {
    expect(COMMAND_PERMISSIONS["payable.import_statement"]).toBe("records.write");
    for (const surface of ["api", "slack", "telegram", "github"] as const) expect(SURFACE_COMMANDS[surface]).not.toContain("payable.import_statement");
  });

  it.each(["owner", "admin"] as const)("lets an %s save the ticked lines", async (role) => {
    const outcome = await run(() => importBankStatement(actor({ role }), { ...INPUT, pairs: [{ line: 2, invoiceId: NORTH }] }));
    expect(outcome).toEqual({ ok: true, message: "Saved 1 payment from the statement: 1 new.", saved: 1, corrected: 0, notSaved: [] });
    expect(mocks.recordStatementLine).toHaveBeenCalledWith({ actorId: USER, account: "DBS operating", line: read.lines[0], invoiceId: NORTH, replaces: "rec-9", today: TODAY });
  });

  it.each(["approver", "viewer"] as const)("refuses an %s before anything is read", async (role) => {
    const outcome = await run(() => importBankStatement(actor({ role }), { ...INPUT, pairs: [{ line: 2, invoiceId: NORTH }] }));
    expect(outcome).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.matchStatementNow).not.toHaveBeenCalled();
  });

  it("refuses a surface other than the console", async () => {
    const outcome = await run(() => importBankStatement(actor({ surface: { kind: "api", apiKeyId: "k-1" } }), { ...INPUT, pairs: [] }));
    expect(outcome).toMatchObject({ ok: false, code: "surface" });
  });
});

describe("importBankStatement", () => {
  it("saves a pair only while the bill is still one of the line's candidates, once per line and per bill", async () => {
    mocks.recordStatementLine.mockResolvedValueOnce({ corrected: true }).mockResolvedValueOnce({ corrected: false });
    const outcome = await run(() =>
      importBankStatement(actor(), {
        ...INPUT,
        pairs: [
          { line: 2, invoiceId: NORTH },
          { line: 4, invoiceId: KESTREL },
          { line: 3, invoiceId: ATLAS },
          { line: 5, invoiceId: OTHER },
          { line: 9, invoiceId: ELSE },
        ],
      })
    );
    expect(mocks.recordStatementLine).toHaveBeenCalledTimes(2);
    expect(mocks.recordStatementLine.mock.calls[1][0]).toMatchObject({ line: read.lines[2], invoiceId: KESTREL, replaces: null });
    expect(outcome).toEqual({
      ok: true,
      message: "Saved 2 payments from the statement: 1 new, 1 correction. 3 lines were not saved.",
      saved: 2,
      corrected: 1,
      notSaved: [
        { line: 3, why: "This line recorded a payment already, for Atlas." },
        { line: 5, why: "Money in is not matched to bills." },
        { line: 9, why: "That line is not in the statement as read. Read the statement again." },
      ],
    });
  });

  it("refuses both lines when one bill is ticked for two", async () => {
    const outcome = await run(() =>
      importBankStatement(actor(), {
        ...INPUT,
        pairs: [
          { line: 2, invoiceId: NORTH },
          { line: 4, invoiceId: NORTH },
        ],
      })
    );
    expect(mocks.recordStatementLine).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      ok: false,
      code: "nothing_saved",
      message: "No payment was saved. 2 lines were not saved. Line 2: Another ticked line is matched to the same bill.",
    });
  });

  it("refuses a bill that is not one the line could have paid", async () => {
    const outcome = await run(() => importBankStatement(actor(), { ...INPUT, pairs: [{ line: 2, invoiceId: ATLAS }] }));
    expect(mocks.recordStatementLine).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, message: "No payment was saved. 1 line was not saved. Line 2: That bill is not one this line could have paid. Read the statement again." });
  });

  it("keeps going when one line is refused, in the refusal's own words", async () => {
    const { ActualPaymentError } = await import("@/lib/actual-payments");
    mocks.recordStatementLine.mockRejectedValueOnce(new ActualPaymentError("changed")).mockResolvedValueOnce({ corrected: false });
    const outcome = await run(() =>
      importBankStatement(actor(), {
        ...INPUT,
        pairs: [
          { line: 2, invoiceId: NORTH },
          { line: 4, invoiceId: ATLAS },
        ],
      })
    );
    expect(outcome).toMatchObject({ ok: true, saved: 1, notSaved: [{ line: 2, why: "Someone recorded this bill a moment before. Reload the page to see it." }] });
  });

  it("says what stops the statement being read, that nothing is ticked, and that the import is not set up", async () => {
    expect(await run(() => importBankStatement(actor(), { ...INPUT, pairs: [] }))).toEqual({ ok: false, code: "nothing_ticked", message: "Tick at least one line to save." });
    mocks.matchStatementNow.mockResolvedValueOnce({ read: readStatement(TEXT, {}, TODAY), matches: null, hashes: [] });
    expect(await run(() => importBankStatement(actor(), { ...INPUT, pairs: [{ line: 2, invoiceId: NORTH }] }))).toEqual({
      ok: false,
      code: "statement",
      message: "Type the account's currency, such as SGD, EUR or USDC.",
    });
    mocks.matchStatementNow.mockRejectedValueOnce(new StatementImportError("not_ready"));
    expect(await run(() => importBankStatement(actor(), { ...INPUT, pairs: [{ line: 2, invoiceId: NORTH }] }))).toEqual({
      ok: false,
      code: "not_ready",
      message: "Importing a bank statement is not set up on this deployment yet.",
    });
  });

  it("saves at most 200 payments at a time", async () => {
    const pairs = Array.from({ length: 201 }, (_, index) => ({ line: index + 2, invoiceId: NORTH }));
    expect(await run(() => importBankStatement(actor(), { ...INPUT, pairs }))).toEqual({ ok: false, code: "too_many", message: "Save at most 200 payments at a time." });
  });
});
