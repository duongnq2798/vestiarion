/**
 * The address of a panel opened over Bills & receivables (docs/superpowers/specs/2026-10-12-bills-tabs-design.md B3, B7):
 * `open=<id>` for a bill's detail, `review=<list>` for a review list. Opening pushes the parameter onto the history, so
 * Back closes the panel; closing goes back when this page pushed it, and otherwise (a link that arrived with it) takes
 * it out of the address. Next.js follows `history.pushState` without reading the page again.
 */

export type PanelKey = "open" | "review";

/** The search with one parameter set, or taken out (`null`): `?a=1&b=2`, or "" with none left. */
export function withParam(search: string, key: string, value: string | null): string {
  const params = new URLSearchParams(search);
  if (value === null) params.delete(key);
  else params.set(key, value);
  const query = params.toString();
  return query ? `?${query}` : "";
}

const pushedHere: Record<PanelKey, boolean> = { open: false, review: false };
let opener: HTMLElement | null = null;

/** Opens a panel: its parameter in the address, the element that opened it kept to take focus back. */
export function openPanel(key: PanelKey, value: string, from?: HTMLElement | null): void {
  opener = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  pushedHere[key] = true;
  window.history.pushState(null, "", `${window.location.pathname}${withParam(window.location.search, key, value)}`);
}

/** Closes a panel: back, when this page opened it; else its parameter (and a section's fragment) out of the address. */
export function closePanel(key: PanelKey): void {
  if (pushedHere[key]) {
    pushedHere[key] = false;
    window.history.back();
    return;
  }
  window.history.replaceState(null, "", `${window.location.pathname}${withParam(window.location.search, key, null)}`);
}

/** The element that opened the last panel, once, if it is still on the page. */
export function takeOpener(): HTMLElement | null {
  const element = opener;
  opener = null;
  return element?.isConnected ? element : null;
}
