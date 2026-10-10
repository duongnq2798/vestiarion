"use client";

import { useEffect } from "react";
import { firstTouchCookie, firstTouchFrom, hasFirstTouch } from "@/lib/growth/attribution";

/**
 * Keeps a visit's first touch: when the address carries a campaign tag and no first touch is kept yet, writes the
 * first-party `vx_ft` cookie (src/lib/growth/attribution.ts) with the tags, the landing path, the referring site's host
 * and the time. The onboarding action reads it once, when this browser's person creates a workspace. Renders nothing,
 * sends nothing, and leaves every visit without a tag alone.
 */
export function FirstTouch() {
  useEffect(() => {
    try {
      if (hasFirstTouch(document.cookie)) return;
      const touch = firstTouchFrom(window.location, document.referrer, new Date());
      if (touch) document.cookie = firstTouchCookie(touch, window.location.protocol === "https:");
    } catch {
      // A browser that refuses cookies keeps no first touch; the page is unaffected.
    }
  }, []);
  return null;
}
