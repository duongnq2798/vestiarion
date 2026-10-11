import { isValidElement, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { slugify, type Heading } from "@/lib/docs/headings";

/** The text a rendered node reads as: `Query <code>limit</code>` is "Query limit". */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** A numbered step's heading, "1. Sign in": its number and its words, or null for any other heading. */
export function stepOf(children: ReactNode): { number: string; words: string } | null {
  if (typeof children !== "string") return null;
  const match = /^(\d{1,2})\.\s+(\S.*)$/s.exec(children);
  return match ? { number: match[1], words: match[2] } : null;
}

/**
 * A `##` or `###` heading with its anchor, and a `#` link to it that shows on
 * hover. The `#` is hidden from assistive technology and the tab order, so it
 * stays out of the heading's accessible name; the table of contents and the
 * URL are the ways to reach a section.
 *
 * A numbered `##` ("1. Sign in", as the guides number their steps) draws its number in a badge beside the words
 * (docs clarity T2); its id, its text in the table of contents and its accessible name ("1. Sign in") are unchanged.
 */
export function DocsHeading({ depth, id, children }: { depth: 2 | 3; id: string; children: ReactNode }) {
  const Tag = depth === 2 ? "h2" : "h3";
  const step = depth === 2 ? stepOf(children) : null;
  return (
    <Tag
      id={id}
      className={cn(
        "group scroll-mt-24 font-semibold text-ink [overflow-wrap:anywhere]",
        depth === 2 ? "mt-14 mb-4 text-[1.5rem] leading-tight tracking-[-0.02em] first:mt-0" : "mt-10 mb-3 text-[1.1875rem] leading-snug tracking-[-0.01em]",
        step && "flex items-start gap-3"
      )}
    >
      {step ? (
        <>
          <span className="mt-px inline-grid size-8 shrink-0 place-items-center rounded-full border border-agent-line bg-agent-soft font-mono text-sm font-semibold text-agent">
            {step.number}
            <span className="sr-only">.</span>
          </span>
          <span className="min-w-0">{step.words}</span>
        </>
      ) : (
        children
      )}
      <a
        href={`#${id}`}
        aria-hidden="true"
        tabIndex={-1}
        className="ml-2 inline-block rounded-md text-ink-3 no-underline opacity-0 transition-opacity duration-150 ease-standard hover:text-agent group-hover:opacity-100"
      >
        #
      </a>
    </Tag>
  );
}

/**
 * The `h2` and `h3` components for one page, holding that page's ids as
 * `slugifyHeadings` computed them from its source — the ids the table of
 * contents, search and the link checker use.
 *
 * Each depth-and-text pair has a queue of ids in document order, and a
 * heading takes the next one from its own queue. That relies on one thing:
 * the headings of a page render once each, in document order, which is what
 * React does with a server component's tree. Only headings with the same
 * depth and text share a queue, so even out of order they would swap ids
 * with each other, never take another heading's. Build the components inside
 * the page, so each render starts with full queues.
 *
 * A heading whose rendered text matches no id in the source throws: the
 * prerender fails instead of shipping an anchor the table of contents does
 * not link to.
 */
export function headingComponents(headings: Heading[]) {
  const ids = new Map<string, string[]>();
  for (const heading of headings) {
    const key = `${heading.depth}:${slugify(heading.text)}`;
    ids.set(key, [...(ids.get(key) ?? []), heading.id]);
  }

  const idFor = (depth: 2 | 3, children: ReactNode) => {
    const text = textOf(children);
    const id = ids.get(`${depth}:${slugify(text)}`)?.shift();
    if (id === undefined) {
      const known = headings.map((heading) => `${"#".repeat(heading.depth)} "${heading.text}"`).join(", ") || "none";
      throw new Error(
        `DocsHeading: no heading id for ${"#".repeat(depth)} "${text}" — slugifyHeadings read the source differently from how MDX rendered it, or rendered it twice. The source's headings: ${known}.`
      );
    }
    return id;
  };

  return {
    h2: ({ children }: { children?: ReactNode }) => (
      <DocsHeading depth={2} id={idFor(2, children)}>
        {children}
      </DocsHeading>
    ),
    h3: ({ children }: { children?: ReactNode }) => (
      <DocsHeading depth={3} id={idFor(3, children)}>
        {children}
      </DocsHeading>
    ),
  };
}
