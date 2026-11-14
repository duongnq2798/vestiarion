"use client";

import { useEffect, useRef, useState } from "react";

/**
 * How long work runs before it is shown as running, and how long it stays shown once it is
 * (docs/superpowers/specs/2026-11-14-loading-states-design.md L2). Most actions answer within the
 * first: they show no spinner at all, so nothing blinks. Work shown is kept on screen for the
 * second, so a spinner that appears never vanishes a moment later.
 */
export const BUSY_DELAY_MS = 150;
export const BUSY_MIN_MS = 500;

/**
 * Whether to show that work is running, given whether it is. Work running on the first render was
 * already under way, so it shows at once; work that starts later shows after `BUSY_DELAY_MS`, and
 * once shown stays for at least `BUSY_MIN_MS`, and for `holdMs` after the work ends, the time an
 * indicator takes to show it finished.
 */
export function useBusyIndicator(active: boolean, { delayMs = BUSY_DELAY_MS, minMs = BUSY_MIN_MS, holdMs = 0 } = {}): boolean {
  const [shown, setShown] = useState(active);
  const shownAt = useRef<number | null>(active ? 0 : null);

  useEffect(() => {
    if (active) {
      if (shown) return;
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, delayMs);
      return () => clearTimeout(timer);
    }
    if (!shown) return;
    const left = Math.max(holdMs, (shownAt.current ?? 0) + minMs - Date.now());
    const timer = setTimeout(() => {
      shownAt.current = null;
      setShown(false);
    }, left);
    return () => clearTimeout(timer);
  }, [active, shown, delayMs, minMs, holdMs]);

  return shown;
}

/**
 * Whether work has run for longer than `afterMs`: the moment to say it is taking longer than usual
 * (L5). False again as soon as the work ends.
 */
export function useSlowWork(active: boolean, afterMs: number): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setSlow(true), afterMs);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [active, afterMs]);
  return active && slow;
}
