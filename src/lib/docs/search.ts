import { docsHref } from "./paths";

/**
 * Docs search in the browser: the entry shape, the filter the search dialog
 * runs over the index, and its keyboard shortcut. Free of Node and of the
 * operations' schemas, so the client bundle carries only this; the index is
 * built on the server (`./search-index`) and handed over as a prop.
 */

export interface SearchEntry {
  slug: string;
  /** The page's title. */
  title: string;
  /** The nav section the page is in. */
  section: string;
  /** A `##` or `###` heading; absent on the entry for the page itself. */
  heading?: string;
  /** The heading's anchor on the page. */
  anchor?: string;
  /** The first 200 characters of plain text after the title or heading. */
  text: string;
}

/** Where a result goes: the page, at its heading when it has one. */
export function searchHref(entry: SearchEntry): string {
  return `${docsHref(entry.slug)}${entry.anchor ? `#${entry.anchor}` : ""}`;
}

/**
 * The entries matching every word of `query`, anywhere in the title, heading
 * or text, case aside. A word in a heading counts most, then in a title,
 * then in the text; a page outranks its own headings on a title match, and
 * the whole query in a heading or title counts extra. Ties keep index order,
 * which is nav order. An empty query matches nothing.
 */
export function searchDocs(entries: readonly SearchEntry[], query: string, limit = 20): SearchEntry[] {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  const words = phrase.split(" ").filter(Boolean);
  if (words.length === 0) return [];

  const scored: Array<{ entry: SearchEntry; score: number; order: number }> = [];
  entries.forEach((entry, order) => {
    const title = entry.title.toLowerCase();
    const heading = entry.heading?.toLowerCase() ?? "";
    const text = entry.text.toLowerCase();
    let score = 0;
    for (const word of words) {
      const points = (heading.includes(word) ? 6 : 0) + (title.includes(word) ? 4 : 0) + (text.includes(word) ? 1 : 0);
      if (points === 0) return;
      score += points;
    }
    if (!entry.heading && words.every((word) => title.includes(word))) score += 3;
    if ((entry.heading ? heading : title).includes(phrase)) score += 5;
    scored.push({ entry, score, order });
  });

  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

type ShortcutEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "target">;

/**
 * Whether a keydown opens search: Ctrl K, or ⌘K on a Mac. A plain `k` never
 * does, so typing in an `input`, `textarea`, `select` or content-editable
 * element is left alone; with Ctrl or ⌘ held it opens from a field too, as
 * the console's palette does. Shift and Alt chords belong to the browser.
 */
export function isSearchShortcut(event: ShortcutEvent): boolean {
  if (typeof event.key !== "string" || event.key.toLowerCase() !== "k") return false;
  if (!(event.ctrlKey || event.metaKey)) return false;
  return !event.altKey && !event.shiftKey;
}
