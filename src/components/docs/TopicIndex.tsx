import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { DOCS_NAV, docsHref } from "@/lib/docs/nav";

/** The sections the docs' home indexes: every one but the generated reference lists and the changelog. */
export const INDEXED_SECTIONS = DOCS_NAV.filter((section) => !section.folded && section.pages.length > 1);

/** How many of a section's pages its card names before "and N more". */
const SHOWN = 4;

/**
 * "Explore by topic" on the docs' home (docs redesign D5): each section of the sidebar as a card with its first pages
 * and how many more it holds, built from `DOCS_NAV`, so it never lists a page that does not exist or misses one that
 * does. Two to a row from `sm`, three from `xl`; a last card left alone on its row spans it. The Markdown view writes
 * the same sections as a list (`MDX_TO_MARKDOWN`).
 */
export function TopicIndex() {
  const count = INDEXED_SECTIONS.length;
  // The last card is alone on its row of two when the count is odd, and on its row of three when it is one past a
  // multiple of three: it then spans the row, its links in as many columns.
  const aloneInTwos = count % 2 === 1;
  const aloneInThrees = count % 3 === 1;
  return (
    <div className="my-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {INDEXED_SECTIONS.map((section, index) => {
        const pages = section.pages.filter((page) => page.slug !== "");
        const more = pages.length - SHOWN;
        const last = index === count - 1;
        return (
          <section
            key={section.title}
            aria-label={section.title}
            className={cn(
              "rounded-xl border border-line bg-surface px-5 py-4",
              last && aloneInTwos && "sm:col-span-2",
              last && (aloneInThrees ? "xl:col-span-3" : aloneInTwos && "xl:col-span-1")
            )}
          >
            <p className="text-[0.9375rem] font-semibold text-ink">{section.title}</p>
            <ul
              className={cn(
                "mt-2.5 space-y-1 gap-x-6",
                last && aloneInTwos && "sm:columns-2",
                last && (aloneInThrees ? "xl:columns-3" : aloneInTwos && "xl:columns-1")
              )}
            >
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
