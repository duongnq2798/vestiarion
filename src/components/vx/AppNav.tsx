"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { orgHref } from "@/lib/auth/org-paths";
import type { OrgRole } from "@/lib/auth/roles";
import { BrandMark } from "./Brand";
import { CheckGlyph, CloseGlyph, MenuGlyph, NavGlyph, SelectorGlyph } from "./Glyphs";
import { HOME_PATH, NAV_GROUPS, navItemForPathname } from "./nav";

/**
 * The client half of the workspace frame: what has to know the current URL
 * or hold open/closed state. Everything here renders from the viewer's
 * memberships, which are platform data — never an organization's own rows.
 */

export interface WorkspaceSummary {
  slug: string;
  name: string;
  mode: "sandbox" | "live";
  role: OrgRole;
}

/** Matches Tailwind's `lg`, where the sidebar replaces the drawer. */
const WIDE = "(min-width: 64rem)";

export function SectionNav({ orgSlug }: { orgSlug: string }) {
  const active = navItemForPathname(usePathname())?.key;
  const id = useId();

  return (
    <nav aria-label="Workspace sections" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4 pt-1">
      {NAV_GROUPS.map((group, index) => (
        <div key={group.label} className={index === 0 ? "" : "mt-5"}>
          <p id={`${id}-${index}`} className="px-3 pb-1.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-ink-3">
            {group.label}
          </p>
          <ul aria-labelledby={`${id}-${index}`} className="space-y-0.5">
            {group.items.map((item) => {
              const current = item.key === active;
              return (
                <li key={item.key}>
                  <Link
                    href={orgHref(orgSlug, item.path)}
                    aria-current={current ? "page" : undefined}
                    className={`relative flex h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors lg:h-10 ${
                      current ? "bg-agent-soft font-semibold text-agent" : "text-ink-2 hover:bg-raised/70 hover:text-ink"
                    }`}
                  >
                    {current && <span aria-hidden className="absolute inset-y-2.5 -left-3 w-1 rounded-r-full bg-agent" />}
                    <NavGlyph section={item.key} className="size-[1.125rem]" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <PendingHint />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** A fixed-size dot that lights while its link's page is loading, so nothing shifts. */
function PendingHint() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={`size-1.5 shrink-0 rounded-full bg-agent transition-opacity duration-200 ${pending ? "opacity-100 motion-safe:animate-pulse" : "opacity-0"}`}
    />
  );
}

function WorkspaceBadge({ workspace, className = "size-9" }: { workspace: WorkspaceSummary; className?: string }) {
  return (
    <span aria-hidden className={`grid shrink-0 place-items-center rounded-lg border border-agent-line bg-agent-soft text-sm font-semibold text-agent ${className}`}>
      {workspace.name.trim().charAt(0).toUpperCase() || "W"}
    </span>
  );
}

function WorkspaceMeta({ workspace }: { workspace: WorkspaceSummary }) {
  const live = workspace.mode === "live";
  return (
    <span className="flex items-center gap-1.5 text-xs text-ink-3">
      <span aria-hidden className={`size-1.5 rounded-full ${live ? "bg-proof" : "border border-dashed border-ink-3"}`} />
      <span className={live ? "text-proof" : undefined}>{live ? "Live" : "Sandbox"}</span>
      <span aria-hidden>·</span>
      <span className="capitalize">{workspace.role}</span>
    </span>
  );
}

/**
 * The workspace in view and, for someone in several, a list to move between
 * them — landing on the same section of the other workspace.
 */
export function WorkspaceSwitcher({ current, workspaces }: { current: WorkspaceSummary; workspaces: WorkspaceSummary[] }) {
  const pathname = usePathname();
  // Opened for one URL: navigating anywhere closes it without an effect.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpenAt(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const summary = (
    <>
      <WorkspaceBadge workspace={current} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-semibold text-ink">{current.name}</span>
        <WorkspaceMeta workspace={current} />
      </span>
    </>
  );

  if (workspaces.length < 2) {
    return <div className="flex items-center gap-3 rounded-xl border border-line bg-surface/80 px-2.5 py-2">{summary}</div>;
  }

  const section = navItemForPathname(pathname)?.path ?? HOME_PATH;
  // The current workspace's own link leads to the URL already open, which would not close it.
  const close = () => setOpenAt(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !open) return;
    // Inside the drawer, Escape would also close the drawer; one press closes one thing.
    event.preventDefault();
    event.stopPropagation();
    close();
    button.current?.focus();
  }

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpenAt(open ? null : pathname)}
        className={`flex w-full items-center gap-3 rounded-xl border px-2.5 py-2 transition-colors ${open ? "border-agent-line bg-surface" : "border-line bg-surface/80 hover:border-line-strong hover:bg-surface"}`}
      >
        {summary}
        <SelectorGlyph className="size-4 text-ink-3" />
        <span className="sr-only">Switch workspace</span>
      </button>
      <div
        id={listId}
        hidden={!open}
        className="surface-shadow absolute inset-x-0 top-full z-50 mt-1.5 rounded-xl border border-line bg-surface p-1.5 motion-safe:animate-arrive"
      >
        <p className="px-2.5 pb-1 pt-1.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-ink-3">Workspaces</p>
        <ul className="max-h-64 overflow-y-auto">
          {workspaces.map((workspace) => {
            const isCurrent = workspace.slug === current.slug;
            return (
              <li key={workspace.slug}>
                <Link
                  href={orgHref(workspace.slug, section)}
                  onClick={close}
                  className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm hover:bg-raised/70 ${isCurrent ? "text-ink" : "text-ink-2 hover:text-ink"}`}
                >
                  <WorkspaceBadge workspace={workspace} className="size-7 text-xs" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{workspace.name}</span>
                    <WorkspaceMeta workspace={workspace} />
                  </span>
                  {isCurrent && (
                    <>
                      <CheckGlyph className="size-4 text-agent" />
                      <span className="sr-only">(current)</span>
                    </>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="mt-1 border-t border-line pt-1">
          <Link href="/onboarding" onClick={close} className="flex items-center rounded-lg px-2.5 py-2 text-sm text-agent hover:bg-raised/70">
            All workspaces
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Below `lg`: a compact bar naming the section and workspace, and a drawer
 * holding the same navigation the sidebar shows. The drawer is a modal
 * <dialog>, so the browser supplies the focus trap, the inert page behind it,
 * Escape to close and focus returning to the menu button.
 */
export function MobileNav({ home, workspaceName, children }: { home: string; workspaceName: string; children: ReactNode }) {
  const drawer = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();
  const section = navItemForPathname(pathname);
  const drawerId = useId();

  useEffect(() => {
    drawer.current?.close();
  }, [pathname]);

  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    const closeWhenWide = () => {
      if (wide.matches) drawer.current?.close();
    };
    wide.addEventListener("change", closeWhenWide);
    return () => wide.removeEventListener("change", closeWhenWide);
  }, []);

  function onDrawerClick(event: MouseEvent<HTMLDialogElement>) {
    const target = event.target as Element;
    // A click on the dialog itself landed on its backdrop; a click on a link is a navigation.
    if (target === event.currentTarget || target.closest("a[href]")) event.currentTarget.close();
  }

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line/80 bg-surface/90 backdrop-blur-xl lg:hidden">
        <div className="flex h-14 items-center gap-1 px-2 sm:px-4">
          <button
            type="button"
            aria-label="Open navigation"
            aria-haspopup="dialog"
            aria-controls={drawerId}
            onClick={() => drawer.current?.showModal()}
            className="grid size-11 shrink-0 place-items-center rounded-xl text-ink-2 transition-colors hover:bg-raised hover:text-ink"
          >
            <MenuGlyph className="size-[1.375rem]" />
          </button>
          <Link href={home} className="grid size-11 shrink-0 place-items-center rounded-xl">
            <BrandMark className="size-7 text-agent" />
            <span className="sr-only">Vestiarion — {workspaceName} home</span>
          </Link>
          <div className="min-w-0 flex-1 pl-1">
            <p className="truncate text-[0.9375rem] font-semibold leading-5 text-ink">{section?.label ?? workspaceName}</p>
            {section && <p className="truncate text-xs leading-4 text-ink-3">{workspaceName}</p>}
          </div>
        </div>
      </header>
      <dialog ref={drawer} id={drawerId} aria-label="Navigation" className="nav-drawer" onClick={onDrawerClick}>
        <div className="relative h-full">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => drawer.current?.close()}
            className="absolute right-3 top-3 z-10 grid size-10 place-items-center rounded-xl text-ink-2 transition-colors hover:bg-raised hover:text-ink"
          >
            <CloseGlyph />
          </button>
          {children}
        </div>
      </dialog>
    </>
  );
}
