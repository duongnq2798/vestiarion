import { describe, expect, it } from "vitest";
import { keyNamesForViewer, leaveWorkspaceDescription, removeMemberDescription } from "@/lib/member-keys";

/**
 * What the Members page says about the API keys a membership takes with it
 * (docs/superpowers/specs/2026-10-03-member-api-keys-design.md R9): the
 * confirmations name the keys that stop working, and the page hands the
 * browser only the names for rows the viewer can act on.
 */

describe("removeMemberDescription", () => {
  it("reads as before when the member created no key", () => {
    expect(removeMemberDescription([])).toBe(
      "They lose access to this workspace at once. The removal is recorded in the audit log, and you can invite them again later."
    );
  });

  it("names the one key that stops working", () => {
    expect(removeMemberDescription(["CI deploy"])).toBe(
      'They lose access to this workspace at once, and the API key they created stops working: "CI deploy". The removal is recorded in the audit log, and you can invite them again later.'
    );
  });

  it("names two keys with and", () => {
    expect(removeMemberDescription(["CI deploy", "Reporting"])).toBe(
      'They lose access to this workspace at once, and the API keys they created stop working: "CI deploy" and "Reporting". The removal is recorded in the audit log, and you can invite them again later.'
    );
  });

  it("names three or more keys as a list", () => {
    expect(removeMemberDescription(["a", "b", "c"])).toBe(
      'They lose access to this workspace at once, and the API keys they created stop working: "a", "b" and "c". The removal is recorded in the audit log, and you can invite them again later.'
    );
  });
});

describe("leaveWorkspaceDescription", () => {
  it("reads as before when the viewer created no key", () => {
    expect(leaveWorkspaceDescription([])).toBe("You lose access at once. An owner or admin can invite you back.");
  });

  it("names the viewer's own keys", () => {
    expect(leaveWorkspaceDescription(["CI deploy"])).toBe(
      'You lose access at once, and the API key you created stops working: "CI deploy". An owner or admin can invite you back.'
    );
    expect(leaveWorkspaceDescription(["CI deploy", "Reporting"])).toBe(
      'You lose access at once, and the API keys you created stop working: "CI deploy" and "Reporting". An owner or admin can invite you back.'
    );
  });
});

describe("keyNamesForViewer", () => {
  const members = [
    { userId: "owner", role: "owner" as const },
    { userId: "owner-2", role: "owner" as const },
    { userId: "admin", role: "admin" as const },
    { userId: "admin-2", role: "admin" as const },
    { userId: "approver", role: "approver" as const },
    { userId: "viewer", role: "viewer" as const },
  ];
  const byCreator = {
    owner: ["owner key"],
    "owner-2": ["second owner key"],
    admin: ["admin key"],
    "admin-2": ["second admin key"],
    approver: ["approver key"],
  };

  it("gives a viewer only their own", () => {
    expect(keyNamesForViewer({ members, viewerId: "viewer", viewerRole: "viewer", byCreator })).toEqual({ viewer: [] });
  });

  it("gives an approver only their own, as they remove no one", () => {
    expect(keyNamesForViewer({ members, viewerId: "approver", viewerRole: "approver", byCreator })).toEqual({ approver: ["approver key"] });
  });

  it("gives an admin their own and those of the approvers and viewers they may remove, not other admins' or owners'", () => {
    expect(keyNamesForViewer({ members, viewerId: "admin", viewerRole: "admin", byCreator })).toEqual({
      admin: ["admin key"],
      approver: ["approver key"],
      viewer: [],
    });
  });

  it("gives an owner everyone's", () => {
    expect(keyNamesForViewer({ members, viewerId: "owner", viewerRole: "owner", byCreator })).toEqual({
      owner: ["owner key"],
      "owner-2": ["second owner key"],
      admin: ["admin key"],
      "admin-2": ["second admin key"],
      approver: ["approver key"],
      viewer: [],
    });
  });
});
