import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOME_PATH, NAV_GROUPS, NAV_ITEMS, navItemForPathname, sectionTitle } from "@/components/vx/nav";
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

describe("navItemForPathname — which section the current URL is in", () => {
  it.each([
    ["/o/acme/audit", "audit"],
    ["/o/acme/console", "treasury"],
    ["/o/founding/invoices", "invoices"],
    ["/o/acme/audit/anything-deeper", "audit"],
    ["/o/x/members", "members"],
  ])("%s → %s", (pathname, key) => {
    expect(navItemForPathname(pathname)?.key).toBe(key);
  });

  it.each(["/o/acme", "/o/acme/", "/audit", "/o/acme/consoles", "/onboarding", "/"])("%s is no section", (pathname) => {
    expect(navItemForPathname(pathname)).toBeUndefined();
  });
});
