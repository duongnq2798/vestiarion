import { STATUS_FOR } from "@/lib/api/contract";
import { jsonSchema, operationById, type DocOperation, type DocParam } from "@/lib/api/openapi";
import { hasSource, notesSource, publishedPages, readSource } from "./content";
import { fencedLines } from "./headings";
import { findPage, operationsByTag } from "./nav";
import { docsHref, docsMarkdownPath } from "./paths";
import { ERROR_MEANINGS, REFERENCE_SECTIONS } from "./reference";
import { sampleRequest } from "./samples";
import { schemaTree, type SchemaNode } from "./schema-tree";

/**
 * Every docs page as Markdown: the `.md` view of each page, "Copy page",
 * `/llms.txt` and `/llms-full.txt`. A written page is its MDX with the
 * components turned into Markdown; a generated reference page is written
 * from its operation, as its page is rendered. Links to the site are made
 * absolute on `origin`, so the text still points somewhere once it is pasted
 * elsewhere.
 */

/** A JSX attribute's value: a string (from `"…"`, `'…'` or a string literal in `{…}`), the raw expression otherwise, or `true` when bare. */
export type JsxAttributes = Record<string, string | true>;

export interface ConvertContext {
  origin: string;
  /** Converts MDX (a component's children) with the same rules, components included. */
  convert: (mdx: string) => string;
}

/**
 * How each MDX component the docs use is written in Markdown: its attributes
 * and its children (MDX, still to convert) in, Markdown out. A component the
 * pages use must have an entry here; `mdxToMarkdown` refuses one that does
 * not, so a page never serves leftover JSX.
 */
export const MDX_TO_MARKDOWN: Record<string, (attributes: JsxAttributes, children: string, context: ConvertContext) => string> = {
  Callout: (attributes, children, { convert }) => quote(typeof attributes.title === "string" ? attributes.title : undefined, convert(children)),
  EndpointTable: (_attributes, _children, { origin }) => endpointTables(origin),
};

// Private-use characters hold code out of the conversion; the docs never contain them.
const FENCE_TOKEN = "";
const CODE_TOKEN = "";

/** A line the next block of text must not be glued onto: a list item, a heading, a table, a quote or a fence. */
const BLOCK_START = new RegExp(`^(?:[-*+]\\s|\\d+[.)]\\s|#|\\||>|${FENCE_TOKEN})`);

/** `> **Title** body`: a callout as a quote, its title in bold before the first line, or on a line of its own before a block. */
function quote(title: string | undefined, body: string): string {
  const lines = body.trim() ? body.trim().split("\n") : [];
  if (title) {
    if (lines.length === 0) lines.push(`**${title}**`);
    else if (BLOCK_START.test(lines[0])) lines.unshift(`**${title}**`, "");
    else lines[0] = `**${title}** ${lines[0]}`;
  }
  return lines.map((line) => (line.trim() ? `> ${line}` : ">")).join("\n");
}

/** A table cell: one line, its pipes escaped. */
function cell(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

function table(head: string[], rows: string[][]): string {
  return [head, head.map(() => "---"), ...rows].map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n");
}

function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  return /^`|`$/.test(text) ? `${ticks} ${text} ${ticks}` : `${ticks}${text}${ticks}`;
}

function fenced(lang: string, text: string): string {
  const longest = Math.max(2, ...(text.match(/^`{3,}/gm) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

/** The endpoint overview's tables: one per tag, each path linked to its reference page. */
function endpointTables(origin: string): string {
  return operationsByTag()
    .map(({ tag, operations }) =>
      [
        `**${tag}**`,
        table(
          ["Endpoint", "Summary"],
          operations.map((op) => [`[${code(`${op.method.toUpperCase()} ${op.path}`)}](${origin}${docsHref(`api/${op.id}`)})`, op.summary])
        ),
      ].join("\n\n")
    )
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// MDX to Markdown

/** Fenced blocks and code spans, held out of the conversion and put back at the end. */
interface Held {
  fences: string[][];
  codes: string[];
}

/** Replaces each code span in a block of text with a token. Backslash escapes outside a span are skipped, as CommonMark reads them. */
function holdCodeSpans(block: string, held: Held): string {
  let out = "";
  let i = 0;
  while (i < block.length) {
    const char = block[i];
    if (char === "\\") {
      out += block.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char !== "`") {
      out += char;
      i += 1;
      continue;
    }
    let run = 1;
    while (block[i + run] === "`") run += 1;
    let close = -1;
    for (let j = i + run; j < block.length; ) {
      if (block[j] !== "`") {
        j += 1;
        continue;
      }
      let length = 1;
      while (block[j + length] === "`") length += 1;
      if (length === run) {
        close = j;
        break;
      }
      j += length;
    }
    if (close < 0) {
      out += "`".repeat(run);
      i += run;
      continue;
    }
    out += `${CODE_TOKEN}${held.codes.push(block.slice(i, close + run)) - 1}${CODE_TOKEN}`;
    i = close + run;
  }
  return out;
}

/** The source with every fenced block a one-line token and every code span a token. */
function hold(source: string, held: Held): string {
  const lines = source.split("\n");
  const inFence = fencedLines(lines);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!inFence[i]) {
      out.push(lines[i]);
      continue;
    }
    const block: string[] = [];
    while (i < lines.length && inFence[i]) block.push(lines[i++]);
    i -= 1;
    out.push(`${FENCE_TOKEN}${held.fences.push(block) - 1}${FENCE_TOKEN}`);
  }
  return out
    .join("\n")
    .split(/(\n[ \t]*\n)/)
    .map((block) => holdCodeSpans(block, held))
    .join("");
}

/** Puts the code back. A fence token behind a quote marker gets the marker on every line of its block. */
function release(text: string, held: Held): string {
  return text
    .replace(new RegExp(`^(.*?)${FENCE_TOKEN}(\\d+)${FENCE_TOKEN}[ \\t]*$`, "gm"), (_match, prefix: string, index: string) =>
      held.fences[Number(index)].map((line) => (line ? prefix + line : prefix.trimEnd())).join("\n")
    )
    .replace(new RegExp(`${CODE_TOKEN}(\\d+)${CODE_TOKEN}`, "g"), (_match, index: string) => held.codes[Number(index)]);
}

/** Drops ESM: an `import` or `export` at the start of a line, through the end of its paragraph. */
function withoutEsm(text: string): string {
  let skipping = false;
  return text
    .split("\n")
    .filter((line) => {
      if (/^(?:import|export)\s/.test(line)) skipping = true;
      else if (line.trim() === "") skipping = false;
      return !skipping;
    })
    .join("\n");
}

/** The index just past the `}` that closes the `{` at `start`, skipping strings. */
function closingBrace(text: string, start: number, name: string): number {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' || char === "'" || char === "`") {
      const end = text.indexOf(char, i + 1);
      if (end < 0) break;
      i = end;
    } else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return i + 1;
  }
  throw new Error(`<${name}> has an unclosed {…} expression`);
}

function expressionValue(expression: string): string {
  const literal = /^\s*(["'`])([\s\S]*)\1\s*$/.exec(expression);
  return literal ? literal[2] : expression.trim();
}

/** Reads the attributes of the tag `<name` whose name ends at `from`, up to its `>` or `/>`. */
function openTag(text: string, from: number, name: string): { attributes: JsxAttributes; end: number; selfClosing: boolean } {
  const attributes: JsxAttributes = {};
  let i = from;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };
  for (;;) {
    skipSpace();
    if (i >= text.length) throw new Error(`<${name}> is never closed`);
    if (text.startsWith("/>", i)) return { attributes, end: i + 2, selfClosing: true };
    if (text[i] === ">") return { attributes, end: i + 1, selfClosing: false };
    if (text[i] === "{") {
      // A spread, `{...props}`: nothing Markdown can use.
      i = closingBrace(text, i, name);
      continue;
    }
    const attribute = /^[A-Za-z_$][\w$:.-]*/.exec(text.slice(i))?.[0];
    if (!attribute) throw new Error(`<${name}> has an attribute Markdown cannot read`);
    i += attribute.length;
    skipSpace();
    if (text[i] !== "=") {
      attributes[attribute] = true;
      continue;
    }
    i += 1;
    skipSpace();
    const quoteChar = text[i];
    if (quoteChar === '"' || quoteChar === "'") {
      const end = text.indexOf(quoteChar, i + 1);
      if (end < 0) throw new Error(`<${name}> has an unclosed ${attribute} value`);
      attributes[attribute] = text.slice(i + 1, end);
      i = end + 1;
    } else if (quoteChar === "{") {
      const end = closingBrace(text, i, name);
      attributes[attribute] = expressionValue(text.slice(i + 1, end - 1));
      i = end;
    } else {
      throw new Error(`<${name}> has an attribute Markdown cannot read`);
    }
  }
}

/** Where the `</name>` closing the element opened before `from` starts and ends, nested elements of the same name counted. */
function closeTag(text: string, from: number, name: string): { start: number; end: number } {
  const tags = new RegExp(`<${name}(?=[\\s/>])|</${name}\\s*>`, "g");
  tags.lastIndex = from;
  let depth = 1;
  for (let match = tags.exec(text); match; match = tags.exec(text)) {
    if (match[0].startsWith("</")) {
      if (--depth === 0) return { start: match.index, end: match.index + match[0].length };
    } else {
      const nested = openTag(text, match.index + 1 + name.length, name);
      if (!nested.selfClosing) depth += 1;
      tags.lastIndex = nested.end;
    }
  }
  throw new Error(`<${name}> is never closed`);
}

const COMPONENT = /<([A-Z][A-Za-z0-9]*)(?=[\s/>])/;

/** Converts held MDX: ESM and comments dropped, each component replaced by its Markdown. */
function convertHeld(text: string, origin: string): string {
  let rest = withoutEsm(text).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  let out = "";
  const context: ConvertContext = { origin, convert: (mdx) => convertHeld(mdx, origin) };
  for (let match = COMPONENT.exec(rest); match; match = COMPONENT.exec(rest)) {
    const name = match[1];
    const start = match.index;
    const tag = openTag(rest, start + 1 + name.length, name);
    let children = "";
    let end = tag.end;
    if (!tag.selfClosing) {
      const close = closeTag(rest, tag.end, name);
      children = rest.slice(tag.end, close.start);
      end = close.end;
    }
    const toMarkdown = Object.hasOwn(MDX_TO_MARKDOWN, name) ? MDX_TO_MARKDOWN[name] : undefined;
    if (!toMarkdown) throw new Error(`No Markdown conversion for <${name}>: add one to MDX_TO_MARKDOWN in src/lib/docs/markdown.ts`);
    const markdown = toMarkdown(tag.attributes, children, context);
    // A component on a line of its own is a block: it stands in its own paragraph.
    const lineStart = rest.lastIndexOf("\n", start - 1) + 1;
    const block = rest.slice(lineStart, start).trim() === "";
    out += block ? `${rest.slice(0, lineStart)}\n\n${markdown}\n\n` : `${rest.slice(0, start)}${markdown}`;
    rest = rest.slice(end);
  }
  return (out + rest).replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, "\n\n").trim();
}

/** Root links (`](/docs/…)`, `[r]: /docs/…`) made absolute on `origin`. */
function absoluteLinks(text: string, origin: string): string {
  return text.replace(/\]\(\s*\/(?!\/)/g, `](${origin}/`).replace(/^( {0,3}\[[^\]]+\]:[ \t]*)\/(?!\/)/gm, `$1${origin}/`);
}

/**
 * An MDX page as Markdown: frontmatter, `import` and `export` lines and
 * comments removed, each component written as Markdown (`MDX_TO_MARKDOWN`),
 * root links made absolute. Code is left exactly as written. Throws on a
 * component with no conversion, naming it.
 */
export function mdxToMarkdown(source: string, origin: string): string {
  const base = origin.replace(/\/+$/, "");
  const held: Held = { fences: [], codes: [] };
  const text = hold(source.replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---(?:\n|$)/, ""), held);
  const markdown = release(absoluteLinks(convertHeld(text, base), base), held);
  return markdown ? `${markdown}\n` : "";
}

// ---------------------------------------------------------------------------
// Reference pages

function allowedValues(param: DocParam): string {
  if (param.enum) return param.enum.map(code).join(", ");
  if (param.minimum !== undefined && param.maximum !== undefined) return `${param.minimum} to ${param.maximum}`;
  if (param.minimum !== undefined) return `at least ${param.minimum}`;
  if (param.maximum !== undefined) return `at most ${param.maximum}`;
  return "—";
}

function parameters(op: DocOperation): string {
  if (op.params.length === 0) return "No parameters.";
  return table(
    ["Name", "In", "Type", "Required", "Default", "Allowed values", "Description"],
    op.params.map((param) => [
      code(param.name),
      param.in,
      param.type,
      param.required ? "Required" : "Optional",
      param.default === undefined ? "—" : code(String(param.default)),
      allowedValues(param),
      param.description,
    ])
  );
}

/** The response's fields as a nested list: `name` (type, nullable, required): description. One of … */
function fieldList(nodes: SchemaNode[], depth = 0): string {
  return nodes
    .map((node) => {
      const facts = [node.type, node.nullable && "nullable", node.required ? "required" : "optional"].filter(Boolean).join(", ");
      const description = node.description ? `: ${node.description.replace(/\s+/g, " ").trim()}` : "";
      const values = node.enum ? ` One of ${node.enum.map(code).join(", ")}.` : "";
      const line = `${"  ".repeat(depth)}- ${code(node.name)} (${facts})${description}${values}`;
      return node.children ? `${line}\n${fieldList(node.children, depth + 1)}` : line;
    })
    .join("\n");
}

/** A generated reference page as Markdown, in the page's order; "Try it" is the page's own form, so it has no Markdown. */
function referenceMarkdown(op: DocOperation, origin: string): string {
  const notes = notesSource(op.id);
  const sections = [
    `# ${op.summary}`,
    code(`${op.method.toUpperCase()} ${op.path}`),
    op.description,
    `Send a [workspace API key](${origin}${docsHref("get-started/authentication")}) as \`Authorization: Bearer <key>\`.`,
    `## ${REFERENCE_SECTIONS.parameters}`,
    parameters(op),
    `## ${REFERENCE_SECTIONS.samples}`,
    fenced("bash", sampleRequest(op, origin).curl),
    `## ${REFERENCE_SECTIONS.response}`,
    "Example, `200` `application/json`:",
    fenced("json", JSON.stringify(op.example, null, 2)),
    "**Fields**",
    fieldList(schemaTree(jsonSchema(op.response))),
    `## ${REFERENCE_SECTIONS.errors}`,
    table(
      ["Status", "Code", "When"],
      op.errors.map((error) => [String(STATUS_FOR[error]), code(error), ERROR_MEANINGS[error]])
    ),
  ];
  if (notes !== null) sections.push(`## ${REFERENCE_SECTIONS.notes}`, mdxToMarkdown(notes, origin).trim());
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Pages and llms.txt

/** A page's Markdown view, absolute on `origin`: `https://…/docs/api/list-invoices.md`. */
export function markdownHref(slug: string, origin: string): string {
  return `${origin.replace(/\/+$/, "")}${docsMarkdownPath(slug)}`;
}

/**
 * The page at `slug` as Markdown: its title and description, then its MDX
 * converted, or for `api/<id>` its operation. Null for a slug the nav does
 * not have, and for a page whose MDX is not written yet.
 */
export function pageMarkdown(slug: string, origin: string): string | null {
  const base = origin.replace(/\/+$/, "");
  const found = findPage(slug);
  if (!found) return null;
  if (slug.startsWith("api/")) {
    const op = operationById(slug.slice("api/".length));
    return op ? referenceMarkdown(op, base) : null;
  }
  if (!hasSource(slug)) return null;
  const body = mdxToMarkdown(readSource(slug), base);
  return `# ${found.page.title}\n\n> ${found.page.description}\n${body ? `\n${body}` : ""}`;
}

const SUMMARY =
  "Vestiarion is an autonomous treasury agent for stablecoin businesses on Arc. Its API reads a workspace's signed ledger, books, counterparties, milestones, treasury and insights; signed webhooks push each ledger entry.";

/** `/llms.txt`: what Vestiarion is, then every page by its Markdown view, in nav order, then the OpenAPI document. */
export function llmsIndex(origin: string): string {
  const base = origin.replace(/\/+$/, "");
  const pages = publishedPages().map((page) => `- [${page.title}](${markdownHref(page.slug, base)}): ${page.description}`);
  return [
    "# Vestiarion",
    `> ${SUMMARY}`,
    "## Docs",
    pages.join("\n"),
    "## Optional",
    `- [OpenAPI document](${base}/api/v1/openapi.json)`,
  ].join("\n\n") + "\n";
}

/** `/llms-full.txt`: every page's Markdown, in nav order, separated by rules. */
export function llmsFull(origin: string): string {
  return `${publishedPages()
    .map((page) => pageMarkdown(page.slug, origin)!.trimEnd())
    .join("\n\n---\n\n")}\n`;
}
