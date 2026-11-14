"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useBusyIndicator } from "./busy";

/** A navigation that never lands (the person stopped it, or the network did) stops being shown after this. */
export const NAVIGATION_GIVE_UP_MS = 15_000;
/** How long the bar takes to fill and fade once the page has landed. */
const FINISH_MS = 350;

const NAVIGATION_EVENT = "vestiarion:navigation-start";

/**
 * Shows the bar for a navigation started from code, `router.push` or `router.replace`, or by a server action that
 * redirects, which no link click announces: call it just before. The bar ends once the address changes, like a link's.
 * Given the address it goes to, it stays quiet when that is the page already open, which would never land.
 */
export function announceNavigation(href?: string) {
  if (href !== undefined) {
    const here = new URL(window.location.href);
    const to = new URL(href, here);
    if (to.origin !== here.origin || samePage(to, here)) return;
  }
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

function samePage(to: URL, here: URL): boolean {
  return to.pathname === here.pathname && to.search === here.search;
}

/**
 * Whether a click opens another page of this site in this tab, by a link the browser or Next follows: the
 * primary button with no modifier, to an address on this origin, other than the page itself or a place in it.
 */
export function leavesThePage(event: MouseEvent, here: URL): string | null {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download")) return null;
  if (link.target && link.target !== "_self") return null;
  const to = new URL(link.getAttribute("href") ?? "", here);
  if (to.origin !== here.origin) return null;
  if (samePage(to, here)) return null;
  return to.pathname + to.search;
}

/**
 * A thin bar along the top of the window while a link is followed (docs/superpowers/specs/2026-11-14-loading-states-design.md
 * L4): it shows only when the next page takes longer than a moment, fills slowly while it is on its way, and fills and
 * fades once it lands. A section with a loading screen shows that at once as well; a filter, a tab or a page with none
 * shows only this, so a click never looks as if nothing happened. It is decorative: the page that lands, or its loading
 * screen, says what it is.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? "";
  const current = search ? `${pathname}?${search}` : pathname;
  // The address a navigation left from: it is under way for as long as the page is still that one.
  const [leftFrom, setLeftFrom] = useState<string | null>(null);
  const navigating = leftFrom !== null && leftFrom === current;
  const shown = useBusyIndicator(navigating, { holdMs: FINISH_MS });

  useEffect(() => {
    // Written as `current` is, from the query's parsed form, so the two compare whatever the address's own encoding.
    const leaving = () => {
      const query = new URLSearchParams(window.location.search).toString();
      setLeftFrom(query ? `${window.location.pathname}?${query}` : window.location.pathname);
    };
    const onClick = (event: MouseEvent) => {
      if (leavesThePage(event, new URL(window.location.href))) leaving();
    };
    document.addEventListener("click", onClick);
    window.addEventListener(NAVIGATION_EVENT, leaving);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener(NAVIGATION_EVENT, leaving);
    };
  }, []);

  useEffect(() => {
    if (!navigating) return;
    const giveUp = setTimeout(() => setLeftFrom(null), NAVIGATION_GIVE_UP_MS);
    return () => clearTimeout(giveUp);
  }, [navigating]);

  return <div aria-hidden data-navigation={shown ? (navigating ? "running" : "done") : "idle"} className="navigation-progress" />;
}
