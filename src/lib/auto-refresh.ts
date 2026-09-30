/**
 * When a page that shows other people's changes re-reads itself: on an
 * interval while it is visible, and as soon as the person comes back to it,
 * but never twice within `minGapMs`, and never while the tab is hidden, so a
 * page left open in the background costs nothing. `<AutoRefresh>` wires this
 * to `router.refresh()` and the document's visibility and focus events; it is
 * kept apart from them so the timing can be tested without a browser.
 */
export function startAutoRefresh(options: {
  refresh: () => void;
  intervalMs: number;
  isVisible: () => boolean;
  /** Calls `onChange` when the page may have become visible again; returns the unsubscribe. */
  subscribe: (onChange: () => void) => () => void;
  minGapMs?: number;
}): () => void {
  const { refresh, intervalMs, isVisible, subscribe, minGapMs = 5_000 } = options;
  let lastAt = Date.now();

  const run = () => {
    lastAt = Date.now();
    refresh();
  };

  const timer = setInterval(() => {
    if (isVisible()) run();
  }, intervalMs);

  const unsubscribe = subscribe(() => {
    if (isVisible() && Date.now() - lastAt >= minGapMs) run();
  });

  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}
