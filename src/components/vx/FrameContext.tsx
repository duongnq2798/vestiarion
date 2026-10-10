"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { isSidebarShortcut, sidebarCollapsedInCookies, sidebarCookie } from "./sidebar-preference";
import type { WorkspaceSummary } from "./workspace";
import type { PlatformStatus } from "./workspace-status";

/**
 * What every part of the workspace frame shares: the workspace and the platform's facts the layout read, the banners
 * it drew, and whether the sidebar is collapsed (workspace shell design S3, S4). The header that shows them is drawn by
 * each page's `ProductShell`, so it reads them here rather than through props.
 */
interface FrameValue {
  workspace: WorkspaceSummary;
  platform: PlatformStatus;
  /** The layout's banners (Arc mainnet, payments off, agent paused), drawn under the header. */
  banners: ReactNode;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

const FrameContext = createContext<FrameValue | null>(null);

/** The frame, or null outside one: the /design gallery draws the navigation without a workspace frame. */
export function useOptionalFrame(): FrameValue | null {
  return useContext(FrameContext);
}

export function useFrame(): FrameValue {
  const value = useContext(FrameContext);
  if (!value) throw new Error("useFrame must be used inside FrameProvider");
  return value;
}

/** Anything open that takes the keyboard while it is: the sidebar shortcut leaves it alone. */
const OPEN_OVERLAY = ["dialog", "alertdialog", "menu", "listbox"].map((role) => `[role=${role}][data-state=open]`).join(", ");

/** Matches Tailwind's `lg`, where the sidebar replaces the drawer: below it there is nothing to collapse. */
export const WIDE = "(min-width: 64rem)";

function subscribeWide(listener: () => void) {
  const wide = window.matchMedia(WIDE);
  wide.addEventListener("change", listener);
  return () => wide.removeEventListener("change", listener);
}

/** Whether the window is at least `lg` wide, where the sidebar is; the server, which cannot know, says yes. */
export function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => true);
}

// The preference lives in the cookie; this store tells every subscriber when this page changes it.
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function readCookie(): boolean {
  try {
    return sidebarCollapsedInCookies(document.cookie);
  } catch {
    return false;
  }
}

export function FrameProvider({
  workspace,
  platform,
  banners,
  initialSidebarCollapsed,
  children,
}: {
  workspace: WorkspaceSummary;
  platform: PlatformStatus;
  banners: ReactNode;
  /** The cookie as the server read it: the first paint, and the value until hydration. */
  initialSidebarCollapsed: boolean;
  children: ReactNode;
}) {
  // Read from the cookie on the client, so a layout served from the router's cache, with the value it had when it was
  // fetched, never undoes a toggle made since.
  const sidebarCollapsed = useSyncExternalStore(subscribe, readCookie, () => initialSidebarCollapsed);

  // From what this tab shows, not the cookie: another tab may have changed the cookie since, unseen here.
  const toggleSidebar = useCallback(() => {
    try {
      document.cookie = sidebarCookie(!sidebarCollapsed, window.location.protocol === "https:");
    } catch {
      // A browser that refuses cookies cannot keep the choice; the toggle then does nothing.
    }
    for (const listener of listeners) listener();
  }, [sidebarCollapsed]);

  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat || !wide.matches || !isSidebarShortcut(event, event.target instanceof HTMLElement ? event.target : null)) return;
      // A dialog, confirmation, menu or list that is open owns the keyboard: `[` there may be typeahead.
      if (document.querySelector(OPEN_OVERLAY)) return;
      event.preventDefault();
      toggleSidebar();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);

  const value = useMemo(() => ({ workspace, platform, banners, sidebarCollapsed, toggleSidebar }), [workspace, platform, banners, sidebarCollapsed, toggleSidebar]);
  return <FrameContext.Provider value={value}>{children}</FrameContext.Provider>;
}

/** The banners the layout drew, where the page puts them: under the header, above its title. */
export function FrameBanners() {
  const { banners } = useFrame();
  return banners ? <div className="mb-6 space-y-3 empty:hidden">{banners}</div> : null;
}

/** The column beside the sidebar: its left padding follows the sidebar's width. */
export function FrameColumn({ children }: { children: ReactNode }) {
  const { sidebarCollapsed } = useFrame();
  return (
    <div data-workspace-frame data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"} className="min-h-dvh transition-[padding] duration-200 ease-standard lg:pl-58 lg:data-[sidebar=collapsed]:pl-16">
      {children}
    </div>
  );
}
