/**
 * The `##` and `###` headings of a docs page, with the ids their anchors use.
 *
 * One function gives the ids to everything that needs them: the rendered
 * headings, the table of contents, search and the link checker. Each reads
 * the page's MDX source, so they cannot disagree about `example-2`.
 */

export interface Heading {
  depth: 2 | 3;
  text: string;
  id: string;
}

/** Lowercase, every run of other characters one `-`, no `-` at either end. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A heading's visible text: inline code without its backticks, a link as its
 * label, and no emphasis markers or JSX tags. What a reader sees, which is
 * also what the rendered heading's text content is.
 */
export function headingText(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * The page's `##` and `###` headings in document order. Headings inside a
 * fenced code block are code, not headings. A repeated id gets `-2`, `-3` and
 * so on, counted across both depths, the way the anchors are rendered.
 */
export function slugifyHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  /** How many suffixes each base has handed out, so the next one starts past them. */
  const seen = new Map<string, number>();
  const used = new Set<string>();
  let fence: { char: string; length: number } | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      // A closing fence is the same character, at least as long, and carries no info string.
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && fenceMatch[2].trim() === "") {
        fence = null;
      }
      continue;
    }
    if (fenceMatch && !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }

    const heading = ATX.exec(line);
    if (!heading) continue;
    const depth = heading[1].length;
    if (depth !== 2 && depth !== 3) continue;

    // An optional closing sequence of `#`s is not part of the text.
    const text = headingText((heading[2] ?? "").replace(/[ \t]+#+$/, "").replace(/^#+$/, ""));
    const base = slugify(text);
    let count = seen.get(base) ?? 0;
    let id = base;
    // "Example", "Example 2", "Example" must not give "example-2" twice.
    while (used.has(id)) id = `${base}-${++count + 1}`;
    seen.set(base, count);
    used.add(id);
    headings.push({ depth, text, id });
  }

  return headings;
}
