import Link from "next/link";
import { DOCS_NAV, docsHref } from "@/lib/docs/nav";

/** The sections the docs' home indexes: every one but the generated reference lists and the changelog. */
export const INDEXED_SECTIONS = DOCS_NAV.filter((section) => !section.folded && section.pages.length > 1);

/** How many of a section's pages its card names before "and N more". */
const SHOWN = 4;

/**
 * "Explore by topic" on the docs' home (docs redesign D5): each section of the sidebar as a card with its first pages
 * and how many more it holds, built from `DOCS_NAV`, so it never lists a page that does not exist or misses one that
 * does. The Markdown view writes the same sections as a list (`MDX_TO_MARKDOWN`).
 */
export function TopicIndex() {
  return (
    <div className="my-6 grid gap-3 sm:grid-cols-2">
      {INDEXED_SECTIONS.map((section) => {
        const pages = section.pages.filter((page) => page.slug !== "");
        const more = pages.length - SHOWN;
        return (
          <section
            key={section.title}
            aria-label={section.title}
            className="rounded-xl border border-line bg-surface px-5 py-4 sm:[&:last-child:nth-child(odd)]:col-span-2"
          >
            <p className="text-[0.9375rem] font-semibold text-ink">{section.title}</p>
            <ul className="mt-2.5 space-y-1 sm:[section:last-child:nth-child(odd)_&]:columns-2 sm:[section:last-child:nth-child(odd)_&]:gap-x-6">
              {pages.slice(0, SHOWN).map((page) => (
                <li key={page.slug}>
                  <Link
                    href={docsHref(page.slug)}
                    className="inline-flex min-h-6 items-center text-[0.875rem] text-agent underline-offset-4 hover:underline [overflow-wrap:anywhere]"
                  >
                    {page.title}
                  </Link>
                </li>
              ))}
            </ul>
            {more > 0 && <p className="mt-2 text-[0.8125rem] text-ink-3">and {more} more in the sidebar</p>}
          </section>
        );
      })}
    </div>
  );
}
