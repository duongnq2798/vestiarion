import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS_LINK, HOME_PATH, insideSection, NAV_GROUPS, NAV_ITEMS, navItemForPathname, sectionPathOf, sectionTitle, subpageLabel } from "@/components/vx/nav";
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

  // Workspace shell design S1: where the money is and what waits for a person first, then the work, the controls, the
  // measurements and the workspace itself.
  it("groups the sections as people use them, Approvals beside Treasury", () => {
    expect(NAV_GROUPS.map((group) => [group.label, group.items.map((item) => item.key)])).toEqual([
      ["Home", ["treasury", "approvals"]],
      ["Operations", ["invoices", "counterparties", "contractors", "projects"]],
      ["Controls", ["compliance", "audit"]],
      ["Analytics", ["insights", "report"]],
      ["Workspace", ["members", "settings"]],
    ]);
    // Only the first group goes without a visible heading; its label still names it for a screen reader.
    expect(NAV_GROUPS.map((group) => group.hideLabel)).toEqual([true, false, false, false, false]);
    expect(sectionTitle("approvals")).toBe("Approvals");
    expect(NAV_ITEMS.find((item) => item.key === "approvals")?.path).toBe("/approvals");
  });

  it("calls the bills page by what it holds, at the path it always had", () => {
    expect(sectionTitle("invoices")).toBe("Bills & receivables");
    expect(NAV_ITEMS.find((item) => item.key === "invoices")?.path).toBe("/invoices");
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

  // A payment's evidence is part of the section its record lives in (evidence chain E1).
  it.each([
    ["/o/acme/evidence/invoice/5f1e2d3c-0000-4000-8000-000000000001", "invoices", "/invoices"],
    ["/o/acme/evidence/milestone/5f1e2d3c-0000-4000-8000-000000000002", "contractors", "/contractors"],
    // A project's page is part of Projects.
    ["/o/acme/projects/5f1e2d3c-0000-4000-8000-000000000003", "projects", "/projects"],
  ])("%s → %s", (pathname, key, path) => {
    expect(navItemForPathname(pathname)?.key).toBe(key);
    expect(sectionPathOf(pathname)).toBe(path);
  });

  it.each(["/o/acme/evidence", "/o/acme/evidence/receivable/5f1e2d3c-0000-4000-8000-000000000001", "/o/acme/evidences/invoice/x"])("%s is no section", (pathname) => {
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

describe("subpageLabel — the page inside a section, named after it", () => {
  const ID = "5f1e2d3c-0000-4000-8000-000000000001";

  it.each([
    ["/o/pinecrest-studio/invoices/commissions", "invoices", "Commissions"],
    [`/o/acme/invoices/deals/${ID}`, "invoices", "Deal"],
    [`/o/acme/projects/${ID}`, "projects", "Project"],
    [`/o/acme/evidence/invoice/${ID}`, "invoices", "Payment evidence"],
    [`/o/acme/evidence/milestone/${ID}`, "contractors", "Payment evidence"],
    // The monthly close pack sits inside the Audit log, which links it (close pack CP11, CP16).
    ["/o/acme/evidence/close-pack", "audit", "Monthly close pack"],
  ])("%s is inside %s, as %s", (pathname, key, label) => {
    expect(navItemForPathname(pathname)?.key).toBe(key);
    expect(insideSection(pathname)).toBe(true);
    expect(subpageLabel(pathname)).toBe(label);
  });

  it.each(["/o/acme/invoices", "/o/acme/projects", "/o/acme/contractors", "/o/acme/console", "/o/acme", "/onboarding", "/"])(
    "%s is no page inside a section",
    (pathname) => {
      expect(insideSection(pathname)).toBe(false);
      expect(subpageLabel(pathname)).toBeUndefined();
    }
  );

  // Every page.tsx below a section's own page, as the pathnames a person opens: a dynamic segment takes each value
  // it is opened with. A page added without a row in nav.ts would show its section as the current page.
  const SAMPLES: Record<string, readonly string[]> = { "[id]": [ID], "[kind]": ["invoice", "milestone"] };
  function pathnamesOf(file: string): string[] {
    return file
      .split("/")
      .slice(0, -1)
      .reduce<string[]>((paths, segment) => {
        const values = segment.startsWith("[") ? SAMPLES[segment] : [segment];
        if (!values) throw new Error(`no sample value for ${segment} in ${file}: add one to SAMPLES`);
        return paths.flatMap((base) => values.map((value) => `${base}/${value}`));
      }, ["/o/acme"]);
  }
  const NESTED_PAGES = (readdirSync(WORKSPACE, { recursive: true }) as string[])
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => file.endsWith("/page.tsx") && file.split("/").length > 2);

  it("finds the pages inside sections there are", () => {
    expect(NESTED_PAGES).toEqual(
      expect.arrayContaining(["evidence/[kind]/[id]/page.tsx", "invoices/commissions/page.tsx", "invoices/deals/[id]/page.tsx", "projects/[id]/page.tsx"])
    );
  });

  it.each(NESTED_PAGES)("%s is inside its section, named as in the browser tab", (file) => {
    const source = readFileSync(path.join(WORKSPACE, file), "utf8");
    const title = /export const metadata: Metadata = \{ title: "([^"]+)" \};/.exec(source)?.[1];
    expect(title).toBeDefined();
    for (const pathname of pathnamesOf(file)) {
      expect(navItemForPathname(pathname)).toBeDefined();
      expect(subpageLabel(pathname)).toBe(title);
    }
  });

  // A page showing one record names it in the header, rather than its kind (`ProductShell`'s crumb).
  it.each([
    ["invoices/deals/[id]/page.tsx", "crumb={deal.title}"],
    ["projects/[id]/page.tsx", "crumb={project.name}"],
    ["evidence/[kind]/[id]/page.tsx", "crumb={subject.title}"],
  ])("%s names its record in the breadcrumb", (file, crumb) => {
    expect(readFileSync(path.join(WORKSPACE, file), "utf8")).toContain(crumb);
  });
});
