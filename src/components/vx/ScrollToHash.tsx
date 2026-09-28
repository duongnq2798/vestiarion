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
    if (id) document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "instant" });
  }, []);
  return null;
}
