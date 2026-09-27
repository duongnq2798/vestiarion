import { describe, expect, it } from "vitest";
import { canMutate, isOrgRole } from "@/lib/auth/roles";

describe("canMutate — Plan 1: only an owner changes anything", () => {
  it.each([
    ["owner", true],
    ["admin", false],
    ["approver", false],
    ["viewer", false],
    [null, false],
    [undefined, false],
  ] as const)("%s → %s", (role, expected) => {
    expect(canMutate(role)).toBe(expected);
  });
});

describe("isOrgRole", () => {
  it("accepts the four roles and nothing else", () => {
    for (const role of ["owner", "admin", "approver", "viewer"]) expect(isOrgRole(role)).toBe(true);
    for (const value of ["Owner", "superuser", "", null, 1]) expect(isOrgRole(value)).toBe(false);
  });
});
