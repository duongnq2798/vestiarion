"use client";

import { BookOpen, Check, ChevronsUpDown, LayoutGrid, Menu, Plus, Search } from "lucide-react";
import { LayoutGroup, m } from "motion/react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState, type ReactElement } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { Kbd } from "@/components/ui/Kbd";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/Sheet";
import { Tooltip } from "@/components/ui/Tooltip";
import { MOTION } from "@/components/ui/tokens";
import { orgHref } from "@/lib/auth/org-paths";
import { AccountMenu } from "./AccountMenu";
import { BrandMark } from "./Brand";
import { useCommandPalette, useShortcutLabel } from "./CommandPalette";
import { useFrame, WIDE } from "./FrameContext";
import { DOCS_LINK, NAV_GROUPS, navItemForPathname, sectionPathOf } from "./nav";
import { NAV_ICONS } from "./nav-icons";
import type { WorkspaceSummary } from "./workspace";
import { WorkspaceMeta } from "./WorkspaceMeta";

/**
 * The client half of the workspace frame: what has to know the current URL
 * or hold open/closed state. Everything here renders from the viewer's
 * memberships, which are platform data — never an organization's own rows.
 *
 * `collapsed` is the sidebar's icon rail (workspace shell design S3): every
 * control keeps its name for a screen reader, and shows it in a tooltip on
 * hover or keyboard focus. The drawer is never collapsed.
 */

/**
 * A control's name beside it when expanded, in a tooltip on the rail. Always the same element either way, only kept
 * closed when expanded, so folding the sidebar never re-creates the control under someone's keyboard focus.
 */
function RailTip({ collapsed, label, children }: { collapsed: boolean; label: string; children: ReactElement }) {
  return (
    <Tooltip content={label} side="right" disabled={!collapsed}>
      {children}
    </Tooltip>
  );
}

/**
 * The sections, grouped. The current one sits on a marker that glides to the
 * next section when the page changes; each copy of the navigation (sidebar,
 * drawer) has its own `layoutId` group, so the marker never flies between them.
 */
export function SectionNav({ orgSlug, layoutId, collapsed = false }: { orgSlug: string; layoutId: string; collapsed?: boolean }) {
  const active = navItemForPathname(usePathname())?.key;
  const id = useId();

  return (
    <LayoutGroup id={layoutId}>
      <nav aria-label="Workspace sections" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 pb-4 pt-1">
        {NAV_GROUPS.map((group, index) => (
          <div key={group.label} className={index === 0 ? undefined : collapsed ? "mt-3 border-t border-line pt-3" : "mt-5"}>
            <p
              id={`${id}-${index}`}
              className={group.hideLabel || collapsed ? "sr-only" : "px-3 pb-1.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-ink-3"}
            >
              {group.label}
            </p>
            <ul aria-labelledby={`${id}-${index}`} className="space-y-0.5">
              {group.items.map((item) => {
                const current = item.key === active;
                const Icon = NAV_ICONS[item.key];
                return (
                  <li key={item.key}>
                    <RailTip collapsed={collapsed} label={item.label}>
                      <Link
                        href={orgHref(orgSlug, item.path)}
                        aria-current={current ? "page" : undefined}
                        className={cn(
                          "relative flex items-center rounded-lg text-sm transition-colors duration-150 ease-standard",
                          // The icon sits 23px from the panel's edge in both widths, so it stays put as the rail folds.
                          collapsed ? "size-10 justify-center" : "h-11 gap-3 px-[0.6875rem] lg:h-9",
                          current ? "font-semibold text-agent" : "text-ink-2 hover:bg-raised/70 hover:text-ink"
                        )}
                      >
                        {current && (
                          <>
                            <m.span layoutId="current-section" transition={MOTION.spring} aria-hidden className="absolute inset-0 rounded-lg bg-agent-soft" />
                            <m.span layoutId="current-section-bar" transition={MOTION.spring} aria-hidden className="absolute inset-y-2.5 -left-3 w-1 rounded-r-full bg-agent" />
                          </>
                        )}
                        <Icon aria-hidden strokeWidth={1.75} className="relative size-[1.125rem] shrink-0" />
                        <span className={collapsed ? "sr-only" : "relative min-w-0 flex-1 truncate"}>{item.label}</span>
                        {!collapsed && <PendingHint />}
                      </Link>
                    </RailTip>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </LayoutGroup>
  );
}

/** A fixed-size dot that lights while its link's page is loading, so nothing shifts. */
function PendingHint() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={cn("relative size-1.5 shrink-0 rounded-full bg-agent transition-opacity duration-200", pending ? "opacity-100 motion-safe:animate-pulse" : "opacity-0")}
    />
  );
}

/**
 * The workspace in view, and a menu to move between workspaces — landing on
 * the same section of the other one — or to create another. Open even with a
 * single workspace: creating the second one starts here. On the rail it is the
 * workspace's avatar, and its menu opens to the right.
 */
export function WorkspaceSwitcher({ current, workspaces, collapsed = false }: { current: WorkspaceSummary; workspaces: WorkspaceSummary[]; collapsed?: boolean }) {
  const section = sectionPathOf(usePathname());

  return (
    <DropdownMenu>
      <RailTip collapsed={collapsed} label={current.name}>
        <DropdownMenuTrigger asChild>
          {collapsed ? (
            <Button variant="ghost" size="icon" aria-label={`Switch workspace: ${current.name}`} className="rounded-lg sm:size-10 aria-expanded:bg-raised/70">
              <Avatar name={current.name} tone="agent" shape="square" size="md" />
            </Button>
          ) : (
            <Button
              variant="secondary"
              className="h-auto w-full justify-start gap-3 px-2.5 py-2 text-left font-normal shadow-none hover:text-ink active:scale-100 sm:h-auto aria-expanded:border-agent-line"
            >
              <Avatar name={current.name} tone="agent" shape="square" size="lg" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-ink" title={current.name}>
                  {current.name}
                </span>
                <WorkspaceMeta mode={current.mode} network={current.network} role={current.role} />
              </span>
              <ChevronsUpDown aria-hidden className="text-ink-3" />
              <span className="sr-only">Switch workspace</span>
            </Button>
          )}
        </DropdownMenuTrigger>
      </RailTip>
      <DropdownMenuContent
        side={collapsed ? "right" : "bottom"}
        className={collapsed ? "w-72 max-w-[calc(100vw-5rem)]" : "w-(--radix-dropdown-menu-trigger-width) min-w-64"}
      >
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.map((workspace) => {
          const isCurrent = workspace.slug === current.slug;
          return (
            <DropdownMenuItem key={workspace.slug} asChild>
              <Link href={orgHref(workspace.slug, section)} aria-current={isCurrent ? "page" : undefined} className="py-2">
                <Avatar name={workspace.name} tone="agent" shape="square" size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{workspace.name}</span>
                  <WorkspaceMeta mode={workspace.mode} network={workspace.network} role={workspace.role} />
                </span>
                {isCurrent && (
                  <span aria-hidden className="text-agent">
                    <Check />
                  </span>
                )}
              </Link>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          {/* `?create` keeps /onboarding from sending a one-workspace person straight back here. */}
          <Link href="/onboarding?create#create-workspace" className="text-agent [&>svg]:text-agent">
            <Plus aria-hidden />
            Create workspace
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/onboarding?new">
            <LayoutGrid aria-hidden />
            All workspaces
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SearchButton({ collapsed }: { collapsed: boolean }) {
  const palette = useCommandPalette();
  const shortcut = useShortcutLabel();
  return (
    <RailTip collapsed={collapsed} label={`Search or jump to · ${shortcut}`}>
      <Button
        variant={collapsed ? "ghost" : "secondary"}
        size={collapsed ? "icon" : "md"}
        aria-label={collapsed ? "Search or jump to" : undefined}
        onClick={palette.open}
        className={collapsed ? "rounded-lg sm:size-10" : "w-full justify-start gap-2.5 px-3 font-normal text-ink-3 shadow-none hover:text-ink"}
      >
        <Search aria-hidden />
        {!collapsed && (
          <>
            <span className="flex-1 text-left">Search…</span>
            <Kbd className="hidden lg:inline-flex">{shortcut}</Kbd>
          </>
        )}
      </Button>
    </RailTip>
  );
}

/** Everything in the sidebar — and, below `lg`, in the drawer. */
export function NavPanel({
  home,
  workspace,
  workspaces,
  email,
  layoutId,
  collapsed = false,
}: {
  home: string;
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  email: string | null;
  layoutId: string;
  /** The icon rail: only the sidebar, from `lg`, when the person has folded it. */
  collapsed?: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      {/* The rail's controls keep the left inset the section icons have, so nothing slides while the width eases. */}
      <div className="flex h-14 shrink-0 items-center px-4">
        <RailTip collapsed={collapsed} label="Vestiarion · Treasury">
          <Link
            href={home}
            className="group inline-flex items-center gap-2.5 rounded-lg font-mono text-[0.8125rem] font-semibold uppercase tracking-[0.2em] text-ink hover:text-agent"
          >
            <BrandMark className="size-8 shrink-0 text-agent drop-shadow-logo transition-transform duration-150 ease-standard group-hover:-rotate-6 group-hover:scale-105" />
            <span className={collapsed ? "sr-only" : undefined}>Vestiarion</span>
          </Link>
        </RailTip>
      </div>
      <div className={cn("shrink-0 px-3 pb-4", collapsed ? "space-y-1" : "space-y-2")}>
        <WorkspaceSwitcher current={workspace} workspaces={workspaces} collapsed={collapsed} />
        <SearchButton collapsed={collapsed} />
      </div>
      <SectionNav orgSlug={workspace.slug} layoutId={layoutId} collapsed={collapsed} />
      <div className="shrink-0 space-y-1 border-t border-line p-3">
        <RailTip collapsed={collapsed} label={DOCS_LINK.label}>
          <Link
            href={DOCS_LINK.href}
            className={cn(
              "flex items-center rounded-lg text-xs text-ink-3 transition-colors duration-150 ease-standard hover:bg-raised/70 hover:text-ink",
              collapsed ? "size-10 justify-center" : "h-9 gap-2.5 px-2.5"
            )}
          >
            <BookOpen aria-hidden strokeWidth={1.75} className="size-4 shrink-0" />
            <span className={collapsed ? "sr-only" : undefined}>{DOCS_LINK.label}</span>
          </Link>
        </RailTip>
        <AccountMenu email={email} placement={collapsed ? "rail" : "sidebar"} railTip={collapsed}>
          <DropdownMenuItem asChild>
            <Link href="/onboarding?create#create-workspace">
              <Plus aria-hidden />
              Create workspace
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/onboarding?new">
              <LayoutGrid aria-hidden />
              All workspaces
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </AccountMenu>
      </div>
    </div>
  );
}

/**
 * The fixed sidebar from `lg` up: 14.5rem, or a 4rem icon rail when folded.
 * Its width eases between the two, and the column beside it follows
 * (`FrameColumn`); under reduced motion both simply change.
 */
export function Sidebar({ home, workspaces, email }: { home: string; workspaces: WorkspaceSummary[]; email: string | null }) {
  const { workspace, sidebarCollapsed } = useFrame();
  return (
    <div
      id="workspace-sidebar"
      data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"}
      className="fixed inset-y-0 left-0 z-30 hidden w-58 overflow-hidden border-r border-line/80 bg-surface/80 backdrop-blur-xl transition-[width] duration-200 ease-standard data-[sidebar=collapsed]:w-16 lg:block"
    >
      <NavPanel home={home} workspace={workspace} workspaces={workspaces} email={email} layoutId="sidebar" collapsed={sidebarCollapsed} />
    </div>
  );
}

/**
 * Below `lg`: a compact bar naming the section and workspace, a drawer with
 * the same panel the sidebar shows, and the command palette's search button.
 * The drawer is open for one URL: following any link closes it without an
 * effect, and so does growing the window past `lg`.
 */
export function MobileNav({
  home,
  workspace,
  workspaces,
  email,
}: {
  home: string;
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  email: string | null;
}) {
  const pathname = usePathname();
  const section = navItemForPathname(pathname);
  const palette = useCommandPalette();
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;

  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    const closeWhenWide = () => {
      if (wide.matches) setOpenAt(null);
    };
    wide.addEventListener("change", closeWhenWide);
    return () => wide.removeEventListener("change", closeWhenWide);
  }, []);

  return (
    <header className="sticky top-0 z-40 border-b border-line/80 bg-surface/90 backdrop-blur-xl lg:hidden">
      <div className="flex h-14 items-center gap-1 px-2 sm:px-4">
        <Sheet open={open} onOpenChange={(next) => setOpenAt(next ? pathname : null)}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            title="Navigation"
            hideHeader
            onClick={(event) => {
              // A link to the page already open changes no URL; close anyway.
              if ((event.target as Element).closest("a[href]")) setOpenAt(null);
            }}
          >
            <NavPanel home={home} workspace={workspace} workspaces={workspaces} email={email} layoutId="drawer" />
          </SheetContent>
        </Sheet>
        <Link href={home} className="grid size-11 shrink-0 place-items-center rounded-xl">
          <BrandMark className="size-7 text-agent" />
          <span className="sr-only">Vestiarion — {workspace.name} home</span>
        </Link>
        <div className="min-w-0 flex-1 pl-1">
          <p className="truncate text-[0.9375rem] font-semibold leading-5 text-ink">{section?.label ?? workspace.name}</p>
          {section && <p className="truncate text-xs leading-4 text-ink-3">{workspace.name}</p>}
        </div>
        <Button variant="ghost" size="icon" aria-label="Search or jump to" onClick={palette.open}>
          <Search />
        </Button>
      </div>
    </header>
  );
}
