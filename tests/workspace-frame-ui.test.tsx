import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { MobileNav, NavPanel } from "@/components/vx/AppNav";
import { CommandPaletteProvider } from "@/components/vx/CommandPalette";
import { FrameProvider } from "@/components/vx/FrameContext";
import { NAV_ITEMS } from "@/components/vx/nav";
import type { WorkspaceSummary } from "@/components/vx/workspace";
import { WorkspaceHeader } from "@/components/vx/WorkspaceHeader";
import type { PageStatus, PlatformStatus } from "@/components/vx/workspace-status";

/**
 * The workspace frame as drawn (docs/superpowers/specs/2026-10-10-workspace-shell-design.md S3, S4): the header's
 * breadcrumb, toggle and status button, and the sidebar folded to its icon rail, where every control keeps its name.
 */

vi.mock("server-only", () => ({}));
const route = vi.hoisted(() => ({ pathname: "/o/acme/approvals" }));
vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({ slug: "acme" }),
}));
vi.mock("@/app/login/actions", () => ({ signOut: vi.fn() }));
vi.mock("@/app/account/actions", () => ({ deleteAccountAction: vi.fn() }));

const WORKSPACE: WorkspaceSummary = { slug: "acme", name: "Acme Studio", mode: "live", role: "owner", network: "arc-testnet" };
const PLATFORM: PlatformStatus = { network: "arc-testnet", mode: "live", mainnetEnabled: true, paymentsOff: null, pause: null };
const PAGE: PageStatus = { chain: { mode: "live", earnMode: "simulate", held: false }, shadow: true, screening: { live: true, source: "OpenSanctions" }, clock: { mode: "real", day: 1 } };

function frame(node: ReactNode, collapsed = false) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <FrameProvider workspace={WORKSPACE} platform={PLATFORM} banners={null} initialSidebarCollapsed={collapsed}>
        <CommandPaletteProvider workspace={WORKSPACE} workspaces={[WORKSPACE]}>
          {node}
        </CommandPaletteProvider>
      </FrameProvider>
    </TooltipProvider>
  );
}
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** `null`: no page status yet, as the loading and error states draw it. */
const header = (collapsed = false, page: PageStatus | null = PAGE, crumb?: string): string =>
  frame(<WorkspaceHeader page={page ?? undefined} activity={<span>Last cycle</span>} crumb={crumb} />, collapsed);
const phoneBar = (): string => frame(<MobileNav home="/o/acme/console" workspace={WORKSPACE} workspaces={[WORKSPACE]} email="ada@example.com" />);
/** The breadcrumb's list, and each crumb's words in order. */
const breadcrumb = (markup: string) => {
  const list = /<nav aria-label="Breadcrumb"[^>]*><ol[^>]*>([\s\S]*?)<\/ol><\/nav>/.exec(markup)?.[1] ?? "";
  const items = [...list.matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/g)].map(([, attributes, inner]) => ({ attributes, words: text(inner) }));
  return { list, crumbs: items.filter((item) => !item.attributes.includes('aria-hidden="true"')), separators: items.filter((item) => item.attributes.includes('aria-hidden="true"')) };
};
const ID = "5f1e2d3c-0000-4000-8000-000000000001";
/** Renders at a pathname, then puts the route back. */
function at<T>(pathname: string, render: () => T): T {
  route.pathname = pathname;
  try {
    return render();
  } finally {
    route.pathname = "/o/acme/approvals";
  }
}
const panel = (collapsed: boolean): string => frame((<NavPanel home="/o/acme/console" workspace={WORKSPACE} workspaces={[WORKSPACE]} email="ada@example.com" layoutId="test" collapsed={collapsed} />) as ReactElement);

describe("the workspace header", () => {
  it("is a header, not a heading: the page keeps its own h1", () => {
    const markup = header();
    expect(markup).toMatch(/^<header/);
    expect(markup).not.toMatch(/<h1/);
  });

  it("says where the person is: the workspace, linking home, then the section", () => {
    const markup = header();
    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain('href="/o/acme/console"');
    expect(markup).toMatch(/<li aria-current="page"[^>]*>Approvals<\/li>/);
  });

  it("links the section from a page inside it, which is not the section's own page (evidence chain E1)", () => {
    const markup = at(`/o/acme/evidence/invoice/${ID}`, () => header(false, PAGE, "Design retainer, October"));
    expect(markup).toMatch(/<a[^>]*href="\/o\/acme\/invoices"[^>]*>Bills &amp; receivables<\/a>/);
    expect(breadcrumb(markup).crumbs.map((crumb) => crumb.words)).toEqual(["Acme Studio", "Bills & receivables", "Design retainer, October"]);
  });

  it("names a page inside a section after it, as the current page, with its section a link back (Commissions)", () => {
    const markup = at("/o/acme/invoices/commissions", () => header());
    const { list, crumbs, separators } = breadcrumb(markup);
    expect(crumbs.map((crumb) => crumb.words)).toEqual(["Acme Studio", "Bills & receivables", "Commissions"]);
    expect(list).toMatch(/<a[^>]*href="\/o\/acme\/invoices"[^>]*>Bills &amp; receivables<\/a>/);
    expect(list).toMatch(/<li aria-current="page"[^>]*>Commissions<\/li>/);
    // Only the last crumb is the current page; the chevrons between them are drawn, not read.
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(crumbs.slice(0, 2).every((crumb) => !crumb.attributes.includes("aria-current"))).toBe(true);
    expect(separators).toHaveLength(2);
  });

  it("names the record a page inside a section shows, and its kind while the record is not known", () => {
    const deal = `/o/acme/invoices/deals/${ID}`;
    const named = breadcrumb(at(deal, () => header(false, PAGE, "Northwind retainer"))).crumbs.at(-1);
    expect(named?.words).toBe("Northwind retainer");
    expect(named?.attributes).toContain('aria-current="page"');
    expect(named?.attributes).toContain('title="Northwind retainer"');
    // The loading and error states draw the header without the page's props.
    expect(breadcrumb(at(deal, () => header(false, null))).crumbs.map((crumb) => crumb.words)).toEqual(["Acme Studio", "Bills & receivables", "Deal"]);
    expect(breadcrumb(at(deal, () => header(false, PAGE, "  "))).crumbs.at(-1)?.words).toBe("Deal");
    expect(breadcrumb(at(`/o/acme/projects/${ID}`, () => header(false, PAGE, "Office fit-out"))).crumbs.map((crumb) => crumb.words)).toEqual([
      "Acme Studio",
      "Projects",
      "Office fit-out",
    ]);
    expect(breadcrumb(at(`/o/acme/evidence/milestone/${ID}`, () => header(false, null))).crumbs.map((crumb) => crumb.words)).toEqual([
      "Acme Studio",
      "Contractors",
      "Payment evidence",
    ]);
  });

  it("cuts a long name short with an ellipsis, whole in its title, rather than push the chips aside", () => {
    const name = "Northwind Traders annual retainer with quarterly milestones and a deposit paid in two parts";
    const { crumbs } = breadcrumb(at(`/o/acme/invoices/deals/${ID}`, () => header(false, PAGE, name)));
    const classes = (attributes: string | undefined) => /class="([^"]*)"/.exec(attributes ?? "")?.[1].split(" ") ?? [];
    expect(crumbs.at(-1)?.attributes).toContain(`title="${name}"`);
    expect(classes(crumbs.at(-1)?.attributes)).toEqual(expect.arrayContaining(["min-w-0", "max-w-40", "xl:max-w-64", "truncate"]));
    // Where room is short the workspace's name gives way first; the section's stays whole.
    expect(classes(crumbs[0].attributes)).toEqual(expect.arrayContaining(["min-w-0", "shrink-3"]));
    expect(classes(crumbs[1].attributes)).toContain("shrink-0");
  });

  it("keeps a page's kind whole, with no title to repeat it", () => {
    const current = breadcrumb(at("/o/acme/invoices/commissions", () => header())).crumbs.at(-1);
    expect(current?.attributes).toContain("shrink-0");
    expect(current?.attributes).not.toContain("truncate");
    expect(current?.attributes).not.toContain("title=");
  });

  it("keeps a section's own page the current crumb, whatever name it is handed", () => {
    const { crumbs, separators } = breadcrumb(at("/o/acme/invoices", () => header(false, PAGE, "Not a subpage")));
    expect(crumbs.map((crumb) => crumb.words)).toEqual(["Acme Studio", "Bills & receivables"]);
    expect(crumbs[1].attributes).toContain('aria-current="page"');
    expect(separators).toHaveLength(1);
  });

  it("names the sidebar toggle by what it will do, and ties it to the sidebar", () => {
    expect(header(false)).toMatch(/<button[^>]*aria-label="Collapse sidebar"[^>]*>/);
    expect(header(false)).toContain('aria-controls="workspace-sidebar"');
    expect(header(false)).toContain('aria-expanded="true"');
    expect(header(true)).toMatch(/<button[^>]*aria-label="Expand sidebar"[^>]*>/);
    expect(header(true)).toContain('aria-expanded="false"');
  });

  it("puts the three chips in one button that says them all, and opens the panel only on demand", () => {
    const markup = header();
    expect(markup).toContain('aria-label="Workspace status: Arc testnet, Shadow mode, Agent on"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(text(markup)).toContain("Arc testnet Shadow mode Agent on");
    expect(markup).not.toContain("Each agent decision waits");
  });

  it("keeps the agent's activity mounted, so its toasts come at every width", () => {
    expect(text(header())).toContain("Last cycle");
  });

  it("says less, not a guess, while the page's own status is still loading", () => {
    expect(header(false, null)).toContain('aria-label="Workspace status: Arc testnet, Payments, Agent on"');
  });
});

describe("the phone bar", () => {
  const titles = (markup: string) => [...markup.matchAll(/<p class="truncate [^"]*">([^<]*)<\/p>/g)].map(([, words]) => words.replace(/&amp;/g, "&"));

  it("names the section, and the workspace under it", () => {
    expect(titles(phoneBar())).toEqual(["Approvals", "Acme Studio"]);
  });

  it("names a page inside a section after it, as the breadcrumb does, and its section under it", () => {
    expect(at("/o/acme/invoices/commissions", phoneBar).match(/<p class="truncate [^"]*">[^<]*<\/p>/g)).toHaveLength(2);
    expect(titles(at("/o/acme/invoices/commissions", phoneBar))).toEqual(["Commissions", "Bills & receivables"]);
    expect(titles(at(`/o/acme/invoices/deals/${ID}`, phoneBar))).toEqual(["Deal", "Bills & receivables"]);
    expect(titles(at(`/o/acme/projects/${ID}`, phoneBar))).toEqual(["Project", "Projects"]);
    expect(titles(at(`/o/acme/evidence/milestone/${ID}`, phoneBar))).toEqual(["Payment evidence", "Contractors"]);
  });
});

describe("the sidebar folded to its icon rail", () => {
  it("keeps every section's name for a screen reader, and marks the current one", () => {
    const markup = panel(true);
    for (const item of NAV_ITEMS) expect(markup).toContain(`<span class="sr-only">${item.label.replace("&", "&amp;")}</span>`);
    expect(markup).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/o\/acme\/approvals"|<a[^>]*href="\/o\/acme\/approvals"[^>]*aria-current="page"/);
  });

  it("marks the section a page sits inside as current, not as the page itself (evidence chain E1)", () => {
    route.pathname = "/o/acme/evidence/milestone/5f1e2d3c-0000-4000-8000-000000000002";
    try {
      const markup = panel(false);
      expect(markup).toMatch(/<a[^>]*aria-current="true"[^>]*href="\/o\/acme\/contractors"|<a[^>]*href="\/o\/acme\/contractors"[^>]*aria-current="true"/);
      expect(markup).not.toContain('aria-current="page"');
    } finally {
      route.pathname = "/o/acme/approvals";
    }
  });

  it("names its icon-only controls", () => {
    const markup = panel(true);
    expect(markup).toContain('aria-label="Switch workspace: Acme Studio"');
    expect(markup).toContain('aria-label="Search or jump to"');
    expect(markup).toContain('aria-label="Account: ada@example.com"');
  });

  it("hides group headings visually but keeps them as the lists' names", () => {
    const markup = panel(true);
    for (const label of ["Operations", "Controls", "Analytics", "Workspace"]) expect(markup).toContain(`class="sr-only">${label}</p>`);
  });

  it("shows labels and group headings when unfolded, and names the first group only for a screen reader", () => {
    const markup = panel(false);
    expect(markup).toMatch(/class="sr-only">Home<\/p>/);
    expect(markup).toMatch(/class="px-3 [^"]*">Operations<\/p>/);
    expect(text(markup)).toContain("Bills & receivables");
  });
});
