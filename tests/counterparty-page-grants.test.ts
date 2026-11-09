import { describe, expect, it } from "vitest";
import { ORG_ROLES, type OrgRole } from "@/lib/auth/roles";
import { pageGrants, type PageGrants } from "@/lib/counterparties/page-grants";

/**
 * What each member may do on a counterparty's page (docs/superpowers/specs/2026-11-09-counterparty-page-design.md CL3 and
 * "Who sees and does what"): the list's grants, from the role, whether this accountant co-signs now, whether the workspace
 * is live, and whether the deployment pays to bank accounts.
 */

const LIVE = { cosigns: false, live: true, bankPayouts: true };

// The spec's table, row by row: owner, admin, approver, accountant with co-signing off, accountant with it on, viewer.
type Column = "owner" | "admin" | "approver" | "accountant" | "accountant co-signing" | "viewer";
const COLUMNS: Column[] = ["owner", "admin", "approver", "accountant", "accountant co-signing", "viewer"];
const grantsOf = (column: Column, facts = LIVE): PageGrants =>
  column === "accountant co-signing" ? pageGrants("accountant", { ...facts, cosigns: true }) : pageGrants(column as OrgRole, facts);

const TABLE: Array<[string, keyof PageGrants, boolean[]]> = [
  ["Edit limit, billing email, purchase orders, address, mirror; unfreeze; revoke a document request", "write", [true, true, false, false, false, false]],
  ["Confirm a changed address", "confirmAddress", [true, true, true, false, true, false]],
  ["Dismiss a screening match", "decide", [true, true, true, false, false, false]],
  ["Check a vendor's statement", "reconcile", [true, true, false, true, true, false]],
  ["Payee link section: see, create, renew, revoke, history", "seeLinks", [true, true, false, false, false, false]],
  ["Share, renew, revoke a receipt (live workspace)", "shareReceipts", [true, true, false, false, false, false]],
  ["Bank account (BlindPay set up)", "manageBank", [true, true, false, false, false, false]],
];

describe("pageGrants", () => {
  for (const [row, grant, expected] of TABLE) {
    it(`CL3: ${row}`, () => {
      expect(COLUMNS.map((column) => grantsOf(column)[grant])).toEqual(expected);
    });
  }

  it("CL3: gives every grant the page uses, and nothing else", () => {
    expect(Object.keys(pageGrants("owner", LIVE)).sort()).toEqual(["confirmAddress", "decide", "manageBank", "reconcile", "seeLinks", "shareReceipts", "write"]);
  });

  it("CL3: lets an accountant confirm an address only while co-signing is on", () => {
    expect(pageGrants("accountant", { ...LIVE, cosigns: false }).confirmAddress).toBe(false);
    expect(pageGrants("accountant", { ...LIVE, cosigns: true }).confirmAddress).toBe(true);
    // Co-signing gives the accountant nothing else.
    expect({ ...pageGrants("accountant", { ...LIVE, cosigns: true }), confirmAddress: false }).toEqual(pageGrants("accountant", { ...LIVE, cosigns: false }));
  });

  it("CL3: counts a co-sign only for the role that co-signs", () => {
    for (const role of ["viewer", "approver"] as const) {
      expect(pageGrants(role, { ...LIVE, cosigns: true })).toEqual(pageGrants(role, { ...LIVE, cosigns: false }));
    }
    expect(pageGrants("viewer", { ...LIVE, cosigns: true }).confirmAddress).toBe(false);
  });

  it("CL3: shares receipts only in a live workspace", () => {
    for (const role of ORG_ROLES) expect(pageGrants(role, { ...LIVE, live: false }).shareReceipts, role).toBe(false);
    expect(pageGrants("owner", { ...LIVE, live: false }).write).toBe(true);
    expect(pageGrants("owner", { ...LIVE, live: false }).seeLinks).toBe(true);
  });

  it("CL3: manages a bank account only on a deployment with BlindPay", () => {
    for (const role of ORG_ROLES) expect(pageGrants(role, { ...LIVE, bankPayouts: false }).manageBank, role).toBe(false);
  });

  it("CL3: a viewer may do nothing but read", () => {
    expect(Object.values(pageGrants("viewer", { cosigns: true, live: true, bankPayouts: true })).every((grant) => grant === false)).toBe(true);
  });
});
