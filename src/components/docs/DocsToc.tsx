"use client";

import { cn } from "@/components/ui/cn";
import { useActiveHeading } from "@/components/ui/useActiveHeading";
import type { Heading } from "@/lib/docs/headings";

/** How far below the top of the window a heading counts as the one being read: under the sticky header. */
const READING_LINE = 112;

/**
 * "On this page": the page's `##` and `###` headings. The one being read is
 * highlighted (`useActiveHeading`). The links are plain anchors; the page
 * scrolls itself.
 */
export function DocsToc({ headings }: { headings: Heading[] }) {
  const active = useActiveHeading(
    headings.map((heading) => heading.id),
    READING_LINE
  );

  if (headings.length === 0) return null;

  return (
    <nav aria-label="On this page">
      <p className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-ink-3">On this page</p>
      <ul className="mt-3 space-y-1 border-l border-line">
        {headings.map((heading) => {
          const current = heading.id === active;
          return (
            <li key={heading.id}>
              <a
                href={`#${heading.id}`}
                aria-current={current ? "location" : undefined}
                className={cn(
                  "-ml-px block border-l py-1 text-[0.8125rem] leading-snug transition-colors duration-150 ease-standard",
                  heading.depth === 3 ? "pl-6" : "pl-3",
                  current ? "border-agent font-medium text-agent" : "border-transparent text-ink-2 hover:border-line-strong hover:text-ink"
                )}
              >
                {heading.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
