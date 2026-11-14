"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { startAutoRefresh } from "@/lib/auto-refresh";

/**
 * Re-reads the current page's server data every `intervalMs` while the tab is
 * visible, and when the person comes back to it (see `startAutoRefresh`).
 * `router.refresh()` re-renders the server components and merges the result
 * without losing client state, so an open dialog or a half-typed form stays
 * as it is. A refresh still on its way when the next is due is let finish
 * rather than started again, so a slow server is not asked twice. Renders
 * nothing.
 */
export function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const inFlight = useRef(false);

  useEffect(() => {
    inFlight.current = refreshing;
  }, [refreshing]);

  useEffect(
    () =>
      startAutoRefresh({
        refresh: () => {
          if (inFlight.current) return;
          inFlight.current = true;
          startRefresh(() => router.refresh());
        },
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
