import { describe, expect, it } from "vitest";
import { sectionTargets, shortcutLabel, workspaceTargets } from "@/components/vx/command-items";
import { NAV_ITEMS } from "@/components/vx/nav";
import type { WorkspaceSummary } from "@/components/vx/workspace";

const acme: WorkspaceSummary = { slug: "acme", name: "Acme", mode: "live", role: "owner" };
const sandbox: WorkspaceSummary = { slug: "note-one", name: "Note One", mode: "sandbox", role: "admin" };

describe("sectionTargets — the palette's sections", () => {
  it("offers every section of the workspace, in navigation order", () => {
    const targets = sectionTargets("acme");
    expect(targets.map((target) => target.key)).toEqual(NAV_ITEMS.map((item) => item.key));
    expect(targets[0]).toMatchObject({ label: "Treasury", href: "/o/acme/console" });
  });

  it("gives each section words to be found by beyond its label", () => {
    for (const target of sectionTargets("acme")) expect(target.keywords.length, target.key).toBeGreaterThan(0);
  });

  it("finds the invoices section by what people call invoices", () => {
    const invoices = sectionTargets("acme").find((target) => target.key === "invoices");
    expect(invoices?.keywords).toEqual(expect.arrayContaining(["payables", "receivables"]));
  });
});

describe("workspaceTargets — switching workspace from the palette", () => {
  it("offers every other workspace, landing on the same section", () => {
    expect(workspaceTargets(acme, [acme, sandbox], "/o/acme/audit")).toEqual([
      expect.objectContaining({ label: "Note One", href: "/o/note-one/audit" }),
    ]);
  });

  it("lands on the first section when the current page is none", () => {
    expect(workspaceTargets(acme, [acme, sandbox], "/o/acme")[0].href).toBe("/o/note-one/console");
  });

  it("offers nothing when the current workspace is the only one", () => {
    expect(workspaceTargets(acme, [acme], "/o/acme/console")).toEqual([]);
  });
});

describe("shortcutLabel — the key hint beside the search button", () => {
  it.each([
    ["MacIntel", "⌘K"],
    ["iPhone", "⌘K"],
    ["iPad", "⌘K"],
    ["Win32", "Ctrl K"],
    ["Linux x86_64", "Ctrl K"],
    ["", "Ctrl K"],
  ])("%s → %s", (platform, label) => {
    expect(shortcutLabel(platform)).toBe(label);
  });
});
