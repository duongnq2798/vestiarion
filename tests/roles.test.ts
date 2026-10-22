import { describe, expect, it } from "vitest";
import { can, canAssignRole, isOrgRole, ORG_ROLES, PERMISSIONS, ROLE_SUMMARIES, type OrgRole, type Permission } from "@/lib/auth/roles";

// Spec §7, row by row. ✓ = allowed. The accountant (accountant console A1) reads everything, books payments in the
// accounting tool and does the receivables bookkeeping; it decides no payment and changes no treasury, limit,
// integration or member.
type Row = { owner: boolean; admin: boolean; approver: boolean; accountant: boolean; viewer: boolean };
const TABLE: Array<[Permission, Row]> = [
  ["workspace.read",   { owner: true,  admin: true,  approver: true,  accountant: true,  viewer: true  }],
  ["agent.pause",      { owner: true,  admin: true,  approver: true,  accountant: false, viewer: false }],
  ["approval.decide",  { owner: true,  admin: true,  approver: true,  accountant: false, viewer: false }],
  ["records.write",    { owner: true,  admin: true,  approver: false, accountant: false, viewer: false }],
  ["receivables.reconcile", { owner: true, admin: true, approver: false, accountant: true, viewer: false }],
  ["payables.reconcile", { owner: true, admin: true, approver: false, accountant: true, viewer: false }],
  ["approval.cosign", { owner: false, admin: false, approver: false, accountant: true, viewer: false }],
  ["agent.run_cycle",  { owner: true,  admin: true,  approver: false, accountant: false, viewer: false }],
  ["agent.resume",     { owner: true,  admin: true,  approver: false, accountant: false, viewer: false }],
  ["agent.budget",     { owner: true,  admin: true,  approver: false, accountant: false, viewer: false }],
  ["approval.policy",  { owner: true,  admin: false, approver: false, accountant: false, viewer: false }],
  ["members.manage",   { owner: true,  admin: true,  approver: false, accountant: false, viewer: false }],
  ["api_keys.manage",  { owner: true,  admin: true,  approver: false, accountant: false, viewer: false }],
  ["webhooks.manage",  { owner: true,  admin: true,  approver: false, accountant: false, viewer: false }],
  ["treasury.manage",  { owner: true,  admin: true,  approver: false, accountant: false, viewer: false }],
  ["integrations.manage", { owner: true, admin: true, approver: false, accountant: false, viewer: false }],
  ["accounting.book",  { owner: true,  admin: true,  approver: false, accountant: true,  viewer: false }],
  ["report.share",    { owner: true,  admin: true,  approver: false, accountant: false, viewer: false }],
  ["reporting.manage", { owner: true, admin: true,  approver: false, accountant: false, viewer: false }],
  ["org.administer",   { owner: true,  admin: false, approver: false, accountant: false, viewer: false }],
];

describe("can — the §7 permission map", () => {
  it.each(TABLE)("%s", (permission, expected) => {
    for (const role of ORG_ROLES) {
      expect(can(role, permission), `${role} → ${permission}`).toBe(expected[role]);
    }
  });

  it("covers every permission in the map", () => {
    expect(TABLE.map(([permission]) => permission).sort()).toEqual(Object.keys(PERMISSIONS).sort());
  });

  it("gives no permission to someone without a role", () => {
    for (const [permission] of TABLE) {
      expect(can(null, permission)).toBe(false);
      expect(can(undefined, permission)).toBe(false);
    }
  });

  it("gives the accountant nothing an admin does not hold, so an admin may invite one", () => {
    // A co-sign is one of a bill's two approvals and never pays: part of approval.decide, which an admin holds (accountant
    // co-sign CS7).
    const partOf: Record<string, string> = { "approval.cosign": "approval.decide" };
    const admin = (permission: string) => TABLE.find(([name]) => name === permission)?.[1].admin === true;
    for (const [permission, row] of TABLE) if (row.accountant) expect(admin(permission) || admin(partOf[permission] ?? ""), permission).toBe(true);
  });
});

describe("canAssignRole — no one grants a role above their own", () => {
  it.each([
    ["owner", "owner", true], ["owner", "admin", true], ["owner", "approver", true], ["owner", "accountant", true], ["owner", "viewer", true],
    ["admin", "owner", false], ["admin", "admin", false], ["admin", "approver", true], ["admin", "accountant", true], ["admin", "viewer", true],
    ["approver", "viewer", false], ["approver", "accountant", false], ["accountant", "viewer", false], ["accountant", "accountant", false],
    ["viewer", "viewer", false],
  ] as const)("%s may assign %s: %s", (actor, target, expected) => {
    expect(canAssignRole(actor, target)).toBe(expected);
  });
});

describe("ROLE_SUMMARIES — what the invitation form says each role may do", () => {
  // A summary may say "Everything an X does" (or "an X and a Y do"): it then says all of X's too.
  const said = (role: OrgRole): string => {
    const summary = ROLE_SUMMARIES[role];
    const inherited = /^Everything an? ([a-z]+)(?: and an? ([a-z]+))? do(?:es)?\b/.exec(summary);
    return [summary, ...(inherited ? inherited.slice(1).filter(Boolean).map((other) => said(other as OrgRole)) : [])].join(" ");
  };

  it.each([
    ["approval.decide", /\bDecides the payments\b/],
    ["accounting.book", /\bbooks payments\b/],
    ["receivables.reconcile", /\bapplies money received\b/],
    ["payables.reconcile", /\bchecks vendors' statements\b/],
  ] as const)("says a role holds %s exactly when it does, so nobody grants a decision unknowingly", (permission, words) => {
    for (const role of ORG_ROLES) expect(words.test(said(role)), `${role}: ${said(role)}`).toBe(can(role, permission));
  });
});

describe("isOrgRole", () => {
  it("accepts the five roles and nothing else", () => {
    for (const role of ["owner", "admin", "approver", "accountant", "viewer"]) expect(isOrgRole(role)).toBe(true);
    for (const value of ["Owner", "superuser", "bookkeeper", "", null, 1]) expect(isOrgRole(value)).toBe(false);
  });

  it("keeps viewer last, the role an invitation starts on", () => {
    expect(ORG_ROLES[ORG_ROLES.length - 1]).toBe("viewer");
  });
});
