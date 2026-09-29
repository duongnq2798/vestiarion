import { findPage } from "./nav";
import { pageHeadings, publishedPages } from "./content";
import { fencedLines, headingText, stripFences } from "./headings";
import { pageMarkdown } from "./markdown";
import { publicOrigin } from "@/lib/public-origin";
import type { SearchEntry } from "./search";

export type { SearchEntry } from "./search";

/**
 * The search index, built on the server when the docs are built: one entry
 * per published page and one per `##`/`###` heading on it. The text of each
 * comes from the page's Markdown view, so search reads what the page says;
 * the anchors come from `pageHeadings`, so a result lands on the heading the
 * page renders.
 */

const TEXT_LENGTH = 200;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/** Markdown read as the words on the page: no code blocks, markers, link targets or table rules. */
export function plainText(markdown: string): string {
  return stripFences(markdown)
    .split("\n")
    .map((line) =>
      line
        .replace(/^ {0,3}\[[^\]]+\]:.*$/, "")
        .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/, "")
        .replace(/^(?:\s*>)+/, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
        .replace(/^\s*#{1,6}\s+/, "")
    )
    .join(" ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/\|/g, " ")
    .replace(/`+/g, "")
    .replace(/\*\*|__|~~|\*/g, "")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(markdown: string): string {
  return plainText(markdown).slice(0, TEXT_LENGTH).trimEnd();
}

/** The Markdown split at its `##` and `###` headings: the part before the first, then each heading's text and what follows it. */
function sections(markdown: string): { intro: string; parts: Array<{ text: string; body: string }> } {
  const lines = markdown.split("\n");
  const inFence = fencedLines(lines);
  const intro: string[] = [];
  const parts: Array<{ text: string; body: string[] }> = [];
  lines.forEach((line, index) => {
    const heading = inFence[index] ? null : ATX.exec(line);
    const depth = heading?.[1].length;
    if (depth === 1) return;
    if (heading && (depth === 2 || depth === 3)) {
      parts.push({ text: headingText((heading[2] ?? "").replace(/[ \t]+#+$/, "")), body: [] });
      return;
    }
    (parts.at(-1)?.body ?? intro).push(line);
  });
  return { intro: intro.join("\n"), parts: parts.map((part) => ({ text: part.text, body: part.body.join("\n") })) };
}

/**
 * The index, by origin, built the first time the layout asks for it rather
 * than on every render (a request-time 404 renders the layout too). Skipped
 * in development, so an edited page is searchable without a restart.
 */
const INDEX_CACHE = new Map<string, SearchEntry[]>();

/**
 * One entry per published page and per heading on it, in nav order. A
 * heading the Markdown view does not carry ("Try it", the reference page's
 * form) is indexed by its title with no text. Every caller gets the same
 * array, so none may change it.
 */
export function buildSearchIndex(origin: string = publicOrigin()): SearchEntry[] {
  if (process.env.NODE_ENV === "development") return indexPages(origin);
  let index = INDEX_CACHE.get(origin);
  if (!index) {
    index = indexPages(origin);
    INDEX_CACHE.set(origin, index);
  }
  return index;
}

function indexPages(origin: string): SearchEntry[] {
  return publishedPages().flatMap((page) => {
    const section = findPage(page.slug)?.section ?? "";
    const markdown = pageMarkdown(page.slug, origin) ?? "";
    const { intro, parts } = sections(markdown);
    const base = { slug: page.slug, title: page.title, section };

    let cursor = 0;
    const headings = pageHeadings(page.slug).map((heading): SearchEntry => {
      const found = parts.findIndex((part, index) => index >= cursor && part.text === heading.text);
      if (found >= 0) cursor = found + 1;
      return { ...base, heading: heading.text, anchor: heading.id, text: found >= 0 ? excerpt(parts[found].body) : "" };
    });
    return [{ ...base, text: excerpt(intro) || page.description.slice(0, TEXT_LENGTH) }, ...headings];
  });
}
