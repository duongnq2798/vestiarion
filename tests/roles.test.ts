import { describe, expect, it } from "vitest";
import { can, canAssignRole, isOrgRole, PERMISSIONS, type Permission } from "@/lib/auth/roles";

// Spec §7, row by row. ✓ = allowed.
const TABLE: Array<[Permission, { owner: boolean; admin: boolean; approver: boolean; viewer: boolean }]> = [
  ["workspace.read",   { owner: true,  admin: true,  approver: true,  viewer: true  }],
  ["agent.pause",      { owner: true,  admin: true,  approver: true,  viewer: false }],
  ["approval.decide",  { owner: true,  admin: true,  approver: true,  viewer: false }],
  ["records.write",    { owner: true,  admin: true,  approver: false, viewer: false }],
  ["agent.run_cycle",  { owner: true,  admin: true,  approver: false, viewer: false }],
  ["agent.resume",     { owner: true,  admin: true,  approver: false, viewer: false }],
  ["agent.budget",     { owner: true,  admin: true,  approver: false, viewer: false }],
  ["members.manage",   { owner: true,  admin: true,  approver: false, viewer: false }],
  ["api_keys.manage",  { owner: true,  admin: true,  approver: false, viewer: false }],
  ["webhooks.manage",  { owner: true,  admin: true,  approver: false, viewer: false }],
  ["treasury.manage",  { owner: true,  admin: true,  approver: false, viewer: false }],
  ["org.administer",   { owner: true,  admin: false, approver: false, viewer: false }],
];

describe("can — the §7 permission map", () => {
  it.each(TABLE)("%s", (permission, expected) => {
    for (const role of ["owner", "admin", "approver", "viewer"] as const) {
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
});

describe("canAssignRole — no one grants a role above their own", () => {
  it.each([
    ["owner", "owner", true], ["owner", "admin", true], ["owner", "approver", true], ["owner", "viewer", true],
    ["admin", "owner", false], ["admin", "admin", false], ["admin", "approver", true], ["admin", "viewer", true],
    ["approver", "viewer", false], ["viewer", "viewer", false],
  ] as const)("%s may assign %s: %s", (actor, target, expected) => {
    expect(canAssignRole(actor, target)).toBe(expected);
  });
});

describe("isOrgRole", () => {
  it("accepts the four roles and nothing else", () => {
    for (const role of ["owner", "admin", "approver", "viewer"]) expect(isOrgRole(role)).toBe(true);
    for (const value of ["Owner", "superuser", "", null, 1]) expect(isOrgRole(value)).toBe(false);
  });
});
