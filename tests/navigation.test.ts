import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS_LINK, HOME_PATH, NAV_GROUPS, NAV_ITEMS, navItemForPathname, sectionPathOf, sectionTitle } from "@/components/vx/nav";
import { LEGACY_PRODUCT_PATHS } from "@/lib/auth/org-paths";

/**
 * The workspace navigation, pinned as structure: every section it lists is a
 * page, every page is listed, and each page is titled by its label. The
 * sidebar, the mobile drawer, the browser tab and the page heading all read
 * the same list, so none of them can drift from the others unnoticed.
 */

const WORKSPACE = path.join(process.cwd(), "src", "app", "o", "[slug]");
const SECTION_PAGES = readdirSync(WORKSPACE).filter((name) => existsSync(path.join(WORKSPACE, name, "page.tsx")));

describe("the workspace navigation", () => {
  it("lists each section once, under a group that is not empty", () => {
    const keys = NAV_ITEMS.map((item) => item.key);
    const paths = NAV_ITEMS.map((item) => item.path);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(paths).size).toBe(paths.length);
    expect(NAV_GROUPS.every((group) => group.items.length > 0)).toBe(true);
  });

  it("links to every section page there is, and to nothing else", () => {
    expect(SECTION_PAGES.length).toBeGreaterThanOrEqual(7);
    expect(NAV_ITEMS.map((item) => item.path.slice(1)).sort()).toEqual([...SECTION_PAGES].sort());
  });

  it("still lists every section an old bookmark redirects to", () => {
    for (const legacy of LEGACY_PRODUCT_PATHS) expect(NAV_ITEMS.map((item) => item.path)).toContain(legacy);
  });

  it("lists Approvals in Controls, first, before Compliance", () => {
    const controls = NAV_GROUPS.find((group) => group.label === "Controls");
    expect(controls?.items.map((item) => item.key)).toEqual(["approvals", "compliance", "audit", "members", "settings"]);
    expect(sectionTitle("approvals")).toBe("Approvals");
    expect(NAV_ITEMS.find((item) => item.key === "approvals")?.path).toBe("/approvals");
  });

  it("opens a workspace on its first section, the treasury", () => {
    expect(HOME_PATH).toBe("/console");
    expect(sectionTitle("treasury")).toBe("Treasury");
  });

  it.each(NAV_ITEMS.map((item) => [item.key, item.path] as const))(
    "%s is titled by its label, in the tab and in the heading",
    (key, sectionPath) => {
      const source = readFileSync(path.join(WORKSPACE, sectionPath.slice(1), "page.tsx"), "utf8");
      expect(source).toContain(`export const metadata: Metadata = { title: sectionTitle("${key}") };`);
      expect(source).toMatch(new RegExp(`<PageHead\\s+title=\\{sectionTitle\\("${key}"\\)\\}`));
    }
  );
});

describe("the Docs link", () => {
  it("leads to the public developer docs, outside the workspace's sections", () => {
    expect(DOCS_LINK).toEqual({ href: "/docs", label: "Docs" });
    expect(NAV_ITEMS.map((item) => item.path)).not.toContain(DOCS_LINK.href);
  });

  it("is in the navigation panel, which the sidebar and the drawer share, and in the command palette", () => {
    const panel = readFileSync(path.join(process.cwd(), "src", "components", "vx", "AppNav.tsx"), "utf8");
    expect(panel).toMatch(/<Link\s+href=\{DOCS_LINK\.href\}/);
    const palette = readFileSync(path.join(process.cwd(), "src", "components", "vx", "CommandPalette.tsx"), "utf8");
    expect(palette).toContain("go(DOCS_TARGET.href)");
  });
});

describe("navItemForPathname — which section the current URL is in", () => {
  it.each([
    ["/o/acme/audit", "audit"],
    ["/o/acme/console", "treasury"],
    ["/o/founding/invoices", "invoices"],
    ["/o/acme/audit/anything-deeper", "audit"],
    ["/o/x/members", "members"],
    ["/o/acme/approvals", "approvals"],
    ["/o/x/settings", "settings"],
  ])("%s → %s", (pathname, key) => {
    expect(navItemForPathname(pathname)?.key).toBe(key);
    if (key === "settings") expect(sectionTitle("settings")).toBe("Settings");
  });

  it.each(["/o/acme", "/o/acme/", "/audit", "/o/acme/consoles", "/onboarding", "/"])("%s is no section", (pathname) => {
    expect(navItemForPathname(pathname)).toBeUndefined();
  });
});

describe("sectionPathOf", () => {
  it("keeps the section a person is in", () => {
    expect(sectionPathOf("/o/acme/audit/anything-deeper")).toBe("/audit");
  });

  it("falls back to the workspace's home", () => {
    expect(sectionPathOf("/o/acme")).toBe(HOME_PATH);
  });
});
