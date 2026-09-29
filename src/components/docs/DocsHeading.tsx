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

/** A `##` or `###` heading with its anchor, and a `#` link to it that shows on hover or focus. */
export function DocsHeading({ depth, id, children }: { depth: 2 | 3; id: string; children: ReactNode }) {
  const Tag = depth === 2 ? "h2" : "h3";
  return (
    <Tag
      id={id}
      className={cn(
        "group scroll-mt-24 font-semibold tracking-tight text-ink",
        depth === 2 ? "mt-12 mb-4 text-xl first:mt-0" : "mt-8 mb-3 text-base"
      )}
    >
      {children}
      <a
        href={`#${id}`}
        aria-label={`Link to this section: ${textOf(children)}`}
        className="ml-2 inline-block rounded-md text-ink-3 no-underline opacity-0 transition-opacity duration-150 ease-standard hover:text-agent focus-visible:opacity-100 group-hover:opacity-100"
      >
        #
      </a>
    </Tag>
  );
}

/**
 * The `h2` and `h3` components for one page, holding that page's ids as
 * `slugifyHeadings` computed them from its source. A heading takes the first
 * unused id with its own depth and text, so the two "Example" headings get
 * `example` and `example-2` — the ids the table of contents, search and the
 * link checker use. Build it inside the page, so each render starts afresh.
 */
export function headingComponents(headings: Heading[]) {
  const ids = new Map<string, string[]>();
  for (const heading of headings) {
    const key = `${heading.depth}:${slugify(heading.text)}`;
    ids.set(key, [...(ids.get(key) ?? []), heading.id]);
  }

  const idFor = (depth: 2 | 3, children: ReactNode) => {
    const base = slugify(textOf(children));
    return ids.get(`${depth}:${base}`)?.shift() ?? base;
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
