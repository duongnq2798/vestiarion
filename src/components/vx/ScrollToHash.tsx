"use client";

import { useEffect } from "react";

/**
 * Brings the element the URL's fragment names into view once the page's
 * content is on screen — `/audit#seq-42` lands on entry 42. A browser does
 * this itself for a document that arrives whole, but workspace pages stream in
 * behind their loading state, after the browser has already looked for the
 * fragment and not found it.
 */
export function ScrollToHash() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    const target = id ? document.getElementById(id) : null;
    if (!target) return;
    // A row folded away (a counterparty's, which "Edit limit" links to) opens, and so does any fold around it.
    for (let fold = target.closest("details"); fold; fold = fold.parentElement?.closest("details") ?? null) fold.open = true;
    target.scrollIntoView({ block: "start", behavior: "instant" });
  }, []);
  return null;
}
