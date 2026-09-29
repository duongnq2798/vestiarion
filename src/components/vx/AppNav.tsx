"use client";

import { Check, ChevronsUpDown, LayoutGrid, LogOut, Menu, Plus, Search } from "lucide-react";
import { LayoutGroup, m } from "motion/react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { startTransition, useEffect, useId, useState } from "react";
import { signOut } from "@/app/login/actions";
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
import { MOTION } from "@/components/ui/tokens";
import { orgHref } from "@/lib/auth/org-paths";
import { BrandMark } from "./Brand";
import { useCommandPalette, useShortcutLabel } from "./CommandPalette";
import { NAV_GROUPS, navItemForPathname, sectionPathOf } from "./nav";
import { NAV_ICONS } from "./nav-icons";
import type { WorkspaceSummary } from "./workspace";

/**
 * The client half of the workspace frame: what has to know the current URL
 * or hold open/closed state. Everything here renders from the viewer's
 * memberships, which are platform data — never an organization's own rows.
 */

/** Matches Tailwind's `lg`, where the sidebar replaces the drawer. */
const WIDE = "(min-width: 64rem)";

/**
 * The sections, grouped. The current one sits on a marker that glides to the
 * next section when the page changes; each copy of the navigation (sidebar,
 * drawer) has its own `layoutId` group, so the marker never flies between them.
 */
export function SectionNav({ orgSlug, layoutId }: { orgSlug: string; layoutId: string }) {
  const active = navItemForPathname(usePathname())?.key;
  const id = useId();

  return (
    <LayoutGroup id={layoutId}>
      <nav aria-label="Workspace sections" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4 pt-1">
        {NAV_GROUPS.map((group, index) => (
          <div key={group.label} className={index === 0 ? undefined : "mt-5"}>
            <p id={`${id}-${index}`} className="px-3 pb-1.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-ink-3">
              {group.label}
            </p>
            <ul aria-labelledby={`${id}-${index}`} className="space-y-0.5">
              {group.items.map((item) => {
                const current = item.key === active;
                const Icon = NAV_ICONS[item.key];
                return (
                  <li key={item.key}>
                    <Link
                      href={orgHref(orgSlug, item.path)}
                      aria-current={current ? "page" : undefined}
                      className={cn(
                        "relative flex h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors duration-150 ease-standard lg:h-10",
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
                      <span className="relative min-w-0 flex-1 truncate">{item.label}</span>
                      <PendingHint />
                    </Link>
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

function WorkspaceMeta({ workspace }: { workspace: WorkspaceSummary }) {
  const live = workspace.mode === "live";
  return (
    <span className="flex items-center gap-1.5 text-xs font-normal text-ink-3">
      <span aria-hidden className={cn("size-1.5 rounded-full", live ? "bg-proof" : "border border-dashed border-ink-3")} />
      <span className={live ? "text-proof" : undefined}>{live ? "Live" : "Sandbox"}</span>
      <span aria-hidden>·</span>
      <span className="capitalize">{workspace.role}</span>
    </span>
  );
}

/**
 * The workspace in view, and a menu to move between workspaces — landing on
 * the same section of the other one — or to create another. Open even with a
 * single workspace: creating the second one starts here.
 */
export function WorkspaceSwitcher({ current, workspaces }: { current: WorkspaceSummary; workspaces: WorkspaceSummary[] }) {
  const section = sectionPathOf(usePathname());

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          className="h-auto w-full justify-start gap-3 px-2.5 py-2 text-left font-normal shadow-none hover:text-ink active:scale-100 sm:h-auto data-[state=open]:border-agent-line"
        >
          <Avatar name={current.name} tone="agent" shape="square" size="lg" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-ink">{current.name}</span>
            <WorkspaceMeta workspace={current} />
          </span>
          <ChevronsUpDown aria-hidden className="text-ink-3" />
          <span className="sr-only">Switch workspace</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.map((workspace) => {
          const isCurrent = workspace.slug === current.slug;
          return (
            <DropdownMenuItem key={workspace.slug} asChild>
              <Link href={orgHref(workspace.slug, section)} aria-current={isCurrent ? "page" : undefined} className="py-2">
                <Avatar name={workspace.name} tone="agent" shape="square" size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{workspace.name}</span>
                  <WorkspaceMeta workspace={workspace} />
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
          {/* `?new` keeps /onboarding from sending a one-workspace person straight back here. */}
          <Link href="/onboarding?new#create-workspace" className="text-agent [&>svg]:text-agent">
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

/** Who is signed in, and the way out. */
export function AccountMenu({ email }: { email: string | null }) {
  const label = email ?? "this account";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-auto w-full justify-start gap-3 px-2 py-1.5 text-left font-normal sm:h-auto">
          <Avatar name={email ?? "?"} />
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-ink-3">Signed in as</span>
            <span className="block truncate text-sm font-medium text-ink" title={email ?? undefined}>
              {label}
            </span>
          </span>
          <ChevronsUpDown aria-hidden className="text-ink-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuLabel className="truncate font-sans text-xs font-normal normal-case tracking-normal">{label}</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link href="/onboarding?new">
            <LayoutGrid aria-hidden />
            All workspaces
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/onboarding?new#create-workspace">
            <Plus aria-hidden />
            Create workspace
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          tone="danger"
          onSelect={() =>
            startTransition(async () => {
              await signOut();
            })
          }
        >
          <LogOut aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SearchButton() {
  const palette = useCommandPalette();
  const shortcut = useShortcutLabel();
  return (
    <Button variant="secondary" onClick={palette.open} className="w-full justify-start gap-2.5 px-3 font-normal text-ink-3 shadow-none hover:text-ink">
      <Search aria-hidden />
      <span className="flex-1 text-left">Search or jump to…</span>
      <Kbd className="hidden lg:inline-flex">{shortcut}</Kbd>
    </Button>
  );
}

/** Everything in the sidebar — and, below `lg`, in the drawer. */
export function NavPanel({
  home,
  workspace,
  workspaces,
  email,
  layoutId,
}: {
  home: string;
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  email: string | null;
  layoutId: string;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Link href={home} className="group inline-flex items-center gap-2.5 font-mono text-[0.8125rem] font-semibold uppercase tracking-[0.2em] text-ink hover:text-agent">
          <BrandMark className="size-8 shrink-0 text-agent drop-shadow-logo transition-transform duration-150 ease-standard group-hover:-rotate-6 group-hover:scale-105" />
          <span>Vestiarion</span>
        </Link>
      </div>
      <div className="shrink-0 space-y-2 px-3 pb-4">
        <WorkspaceSwitcher current={workspace} workspaces={workspaces} />
        <SearchButton />
      </div>
      <SectionNav orgSlug={workspace.slug} layoutId={layoutId} />
      <div className="shrink-0 border-t border-line p-3">
        <AccountMenu email={email} />
      </div>
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
