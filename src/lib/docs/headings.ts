import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { decodeNumericCharacterReference } from "micromark-util-decode-numeric-character-reference";

/**
 * The `##` and `###` headings of a docs page, with the ids their anchors use.
 *
 * One function gives the ids to everything that needs them: the rendered
 * headings, the table of contents, search and the link checker. Each reads
 * the page's MDX source, so they cannot disagree about `example-2`. The text
 * is what MDX renders, so the rendered heading's text slugifies to the same
 * id; `headingComponents` refuses to render a heading when it does not.
 *
 * The two decoders are the ones MDX's parser (micromark) uses, reached
 * through @mdx-js/loader and remark-gfm.
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

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const DEFINITION = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:/;

/**
 * The markdown with every fenced code block blanked: each line inside a
 * fence, the fences included, becomes empty, so line numbers still line up.
 * An unclosed fence runs to the end, as in CommonMark.
 */
export function stripFences(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const fenced = fencedLines(lines);
  return lines.map((line, index) => (fenced[index] ? "" : line)).join("\n");
}

/**
 * Which of `lines` belong to a fenced code block, the fences included. An
 * unclosed fence runs to the end, as in CommonMark.
 */
export function fencedLines(lines: string[]): boolean[] {
  let fence: { char: string; length: number } | null = null;
  return lines.map((line) => {
    const match = FENCE.exec(line);
    if (fence) {
      // A closing fence is the same character, at least as long, and carries no info string.
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && match[2].trim() === "") fence = null;
      return true;
    }
    // A backtick fence's info string may not contain a backtick; that line is a code span instead.
    if (match && !(match[1][0] === "`" && match[2].includes("`"))) {
      fence = { char: match[1][0], length: match[1].length };
      return true;
    }
    return false;
  });
}

/** A piece of inline markdown: text, or a code span's content (already normalised, as MDX renders it). */
type Piece = { code: boolean; text: string };

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Splits inline markdown into code spans and the text around them, per CommonMark's backtick rules. */
export function splitCodeSpans(inline: string): Piece[] {
  const pieces: Piece[] = [];
  let text = "";
  let i = 0;
  while (i < inline.length) {
    const char = inline[i];
    if (char === "\\" && ASCII_PUNCTUATION.test(inline[i + 1] ?? "")) {
      // An escaped backtick opens nothing.
      text += inline.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char !== "`") {
      text += char;
      i += 1;
      continue;
    }
    let run = 1;
    while (inline[i + run] === "`") run += 1;
    // The span closes at the next run of exactly as many backticks.
    let close = -1;
    for (let j = i + run; j < inline.length; ) {
      if (inline[j] !== "`") {
        j += 1;
        continue;
      }
      let length = 1;
      while (inline[j + length] === "`") length += 1;
      if (length === run) {
        close = j;
        break;
      }
      j += length;
    }
    if (close < 0) {
      text += "`".repeat(run);
      i += run;
      continue;
    }
    let content = inline.slice(i + run, close).replace(/\r?\n/g, " ");
    if (content.length > 1 && content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") content = content.slice(1, -1);
    if (text) pieces.push({ code: false, text });
    pieces.push({ code: true, text: content });
    text = "";
    i = close + run;
  }
  if (text) pieces.push({ code: false, text });
  return pieces;
}

/** A link label as MDX matches it against definitions: case-folded, whitespace collapsed. */
function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The reference-link labels a document defines: `[r]: /docs/api`. */
export function linkDefinitions(markdown: string): Set<string> {
  const labels = new Set<string>();
  for (const line of stripFences(markdown).split("\n")) {
    const match = DEFINITION.exec(line);
    if (match) labels.add(normalizeLabel(match[1]));
  }
  return labels;
}

/** Decodes `&amp;`, `&#35;` and `&#x41;` as MDX does; an unknown name stays as written. */
function decodeReferences(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/g, (match, decimal, hex, name) => {
    if (decimal) return decodeNumericCharacterReference(decimal, 10);
    if (hex) return decodeNumericCharacterReference(hex, 16);
    const decoded = decodeNamedCharacterReference(name);
    return decoded === false ? match : decoded;
  });
}

/**
 * A heading's visible text, as MDX renders it: code spans verbatim; outside
 * them, a link as its label (a reference link only when its reference is
 * defined), no images, JSX tags, emphasis or strikethrough markers, escapes
 * resolved and character references decoded.
 */
export function headingText(raw: string, isDefined: (label: string) => boolean = () => true): string {
  const codes: string[] = [];
  const escapes: string[] = [];
  // Code spans and escaped characters are held out as placeholders, so no rule below can touch them.
  let text = splitCodeSpans(raw)
    .map((piece) => (piece.code ? `${codes.push(piece.text) - 1}` : piece.text))
    .join("")
    .replace(/\\([!-/:-@[-`{-~])/g, (_match, char: string) => `${escapes.push(char) - 1}`);

  const defined = (label: string) => isDefined(normalizeLabel(label));
  text = text
    .replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])?/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (match, label: string, ref: string) => (defined(ref || label) ? label : match))
    .replace(/\[([^\]]+)\](?![[(:])/g, (match, label: string) => (defined(label) ? label : match))
    .replace(/<\/?(?:[A-Za-z][^<>]*)?>/g, "")
    .replace(/(\*\*\*|___)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/\*(\S(?:.*?\S)?)\*/g, "$1")
    .replace(/(^|[^A-Za-z0-9_])_(\S(?:.*?\S)?)_(?![A-Za-z0-9_])/g, "$1$2")
    .replace(/(~~?)(\S(?:.*?\S)?)\1/g, "$2");

  return decodeReferences(text)
    .replace(/(\d+)/g, (_match, index: string) => escapes[Number(index)])
    .replace(/(\d+)/g, (_match, index: string) => codes[Number(index)])
    .replace(/\s+/g, " ")
    .trim();
}

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
  const definitions = linkDefinitions(markdown);

  for (const line of stripFences(markdown).split("\n")) {
    const heading = ATX.exec(line);
    if (!heading) continue;
    const depth = heading[1].length;
    if (depth !== 2 && depth !== 3) continue;

    // An optional closing sequence of `#`s is not part of the text.
    const raw = (heading[2] ?? "").replace(/[ \t]+#+$/, "").replace(/^#+$/, "");
    const text = headingText(raw, (label) => definitions.has(label));
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
