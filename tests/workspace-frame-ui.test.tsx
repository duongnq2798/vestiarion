import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { NavPanel } from "@/components/vx/AppNav";
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
vi.mock("next/navigation", () => ({
  usePathname: () => "/o/acme/approvals",
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
const header = (collapsed = false, page: PageStatus | null = PAGE): string => frame(<WorkspaceHeader page={page ?? undefined} activity={<span>Last cycle</span>} />, collapsed);
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

describe("the sidebar folded to its icon rail", () => {
  it("keeps every section's name for a screen reader, and marks the current one", () => {
    const markup = panel(true);
    for (const item of NAV_ITEMS) expect(markup).toContain(`<span class="sr-only">${item.label.replace("&", "&amp;")}</span>`);
    expect(markup).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/o\/acme\/approvals"|<a[^>]*href="\/o\/acme\/approvals"[^>]*aria-current="page"/);
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
