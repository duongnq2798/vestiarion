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

/**
 * A `##` or `###` heading with its anchor, and a `#` link to it that shows on
 * hover. The `#` is hidden from assistive technology and the tab order, so it
 * stays out of the heading's accessible name; the table of contents and the
 * URL are the ways to reach a section.
 */
export function DocsHeading({ depth, id, children }: { depth: 2 | 3; id: string; children: ReactNode }) {
  const Tag = depth === 2 ? "h2" : "h3";
  return (
    <Tag
      id={id}
      className={cn(
        "group scroll-mt-24 font-semibold tracking-tight text-ink [overflow-wrap:anywhere]",
        depth === 2 ? "mt-12 mb-4 text-xl first:mt-0" : "mt-8 mb-3 text-base"
      )}
    >
      {children}
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
