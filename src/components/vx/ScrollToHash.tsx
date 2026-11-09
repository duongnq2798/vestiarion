"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Opens the element a fragment (`#seq-42`) names and brings it into view. A row folded away (a counterparty's, which
 * "Edit limit" links to; a milestone's, which a toast links to) opens, and so does any fold around it. A fragment that
 * names nothing on the page does nothing.
 */
export function openFragment(fragment: string): void {
  const id = decodeURIComponent(fragment.replace(/^#/, ""));
  const target = id ? document.getElementById(id) : null;
  if (!target) return;
  for (let fold = target.closest("details"); fold; fold = fold.parentElement?.closest("details") ?? null) fold.open = true;
  target.scrollIntoView({ block: "start", behavior: "instant" });
}

/**
 * Follows a link with the router and opens the part of the page it names. A link to the page already open (a toast's
 * milestone row, clicked on Contractors) changes only the fragment: nothing on the page mounts again, and neither the
 * path nor the query that `ScrollToHash` watches changes, so the part is opened here; the router then scrolls to it.
 */
export function followLink(router: { push(href: string): void }, href: string): void {
  const url = new URL(href, window.location.href);
  const samePage = url.pathname === window.location.pathname && url.search === window.location.search;
  router.push(href);
  if (samePage && url.hash) openFragment(url.hash);
}

/**
 * Brings the element the URL's fragment names into view once the page's content is on screen — `/audit#seq-42` lands
 * on entry 42. A browser does this itself for a document that arrives whole, but workspace pages stream in behind
 * their loading state, after the browser has already looked for the fragment and not found it. It looks again after a
 * navigation that changes the page's query without mounting it again (a toast's `?history=all#milestone-<id>` followed
 * on Contractors), and when a plain link changes only the fragment (`hashchange`). A refresh changes neither, so a row
 * someone has closed stays closed.
 */
export function ScrollToHash() {
  const pathname = usePathname();
  const query = useSearchParams()?.toString() ?? "";
  useEffect(() => {
    const open = () => openFragment(window.location.hash);
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [pathname, query]);
  return null;
}
