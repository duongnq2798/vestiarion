/**
 * Approvals' keys for a selection (docs/superpowers/specs/2026-10-30-approve-many-design.md AM12): `j` and `k` move to
 * the next and previous card, `x` ticks the card in focus, `a` opens the confirmation, `Escape` clears the selection. A
 * plain module, so the rule can be tested without a page.
 */

export type SelectionKey = "next" | "previous" | "toggle" | "approve" | "clear";

const KEYS: Record<string, SelectionKey> = { j: "next", k: "previous", x: "toggle", a: "approve", Escape: "clear" };

/** A dialog, confirmation, menu or list that is open owns the keyboard, as the sidebar's `[` leaves it (FrameContext). */
export const OPEN_OVERLAY = ["dialog", "alertdialog", "menu", "listbox"].map((role) => `[role=${role}][data-state=open]`).join(", ");

/**
 * What a key press asks of the selection, or null: nothing while typing in a field, with Ctrl, Meta or Alt held, while
 * an overlay is open, or once another control took the key (an open dialog's Escape closes it first, and marks it so).
 * Holding a key moves on through the cards, and never ticks or opens anything twice. No key pays: the confirmation's
 * button does (AM12).
 */
export function selectionKey(
  event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; defaultPrevented: boolean; repeat?: boolean; isComposing?: boolean },
  target: { tagName?: string; isContentEditable?: boolean } | null,
  overlayOpen: boolean
): SelectionKey | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || event.isComposing || overlayOpen) return null;
  if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes((target?.tagName ?? "").toUpperCase())) return null;
  const key = Object.hasOwn(KEYS, event.key) ? KEYS[event.key] : null;
  if (!key || (event.repeat && key !== "next" && key !== "previous")) return null;
  return key;
}
