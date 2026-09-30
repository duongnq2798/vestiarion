"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { startAutoRefresh } from "@/lib/auto-refresh";

/**
 * Re-reads the current page's server data every `intervalMs` while the tab is
 * visible, and when the person comes back to it (see `startAutoRefresh`).
 * `router.refresh()` re-renders the server components and merges the result
 * without losing client state, so an open dialog or a half-typed form stays
 * as it is. Renders nothing.
 */
export function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();

  useEffect(
    () =>
      startAutoRefresh({
        refresh: () => router.refresh(),
        intervalMs,
        isVisible: () => document.visibilityState === "visible",
        subscribe: (onChange) => {
          document.addEventListener("visibilitychange", onChange);
          window.addEventListener("focus", onChange);
          return () => {
            document.removeEventListener("visibilitychange", onChange);
            window.removeEventListener("focus", onChange);
          };
        },
      }),
    [router, intervalMs]
  );

  return null;
}
