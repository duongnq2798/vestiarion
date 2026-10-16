import { ArrowUpRight, ChevronRight, PencilLine } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { hasSource } from "@/lib/docs/content";
import type { Heading } from "@/lib/docs/headings";
import { pageMarkdown } from "@/lib/docs/markdown";
import { DOCS_NAV } from "@/lib/docs/nav";
import { publicOrigin } from "@/lib/public-origin";
import type { SearchEntry } from "@/lib/docs/search";
import { CopyPage } from "./CopyPage";
import { DocsPager } from "./DocsPager";
import { DocsSearchButton, DocsSearchProvider } from "./DocsSearch";
import { DocsMobileNav, DocsSidebar } from "./DocsSidebar";
import { DocsToc } from "./DocsToc";

/** The public repository the docs are written in. */
export const DOCS_REPOSITORY = "https://github.com/duongnq2798/vestiarion";

/** Where a page's MDX is edited on GitHub. */
export function editHref(slug: string): string {
  return `${DOCS_REPOSITORY}/edit/main/content/docs/${slug || "index"}.mdx`;
}

/**
 * The frame around every docs page, rendered by the `/docs` layout (docs redesign D1): the site header labelled
 * "Docs", with search, the repository and the console; the sidebar from `lg` up (a drawer from the header below it) on
 * its own quiet panel; and the page on the reading surface. The page brings its own table of contents, through
 * `DocsPage`, so the frame stays put while pages change beneath it. The search index is built by the layout and handed
 * to the browser here.
 */
export function DocsShell({ searchIndex, children }: { searchIndex: SearchEntry[]; children: ReactNode }) {
  return (
    <DocsSearchProvider index={searchIndex}>
      <div className="flex min-h-dvh flex-col bg-surface">
        <SiteHeader section={{ href: "/docs", label: "Docs" }} width="wide">
          <DocsSearchButton />
          <Button asChild variant="ghost" className="hidden xl:inline-flex">
            <a href={DOCS_REPOSITORY} target="_blank" rel="noopener noreferrer">
              GitHub
              <ArrowUpRight aria-hidden />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </Button>
          <Button asChild variant="secondary" className="hidden md:inline-flex">
            <Link href="/onboarding">Open console</Link>
          </Button>
          <DocsMobileNav sections={DOCS_NAV} />
        </SiteHeader>
        <div className="mx-auto flex w-full max-w-[88rem] flex-1">
          <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-[17.5rem] shrink-0 overflow-y-auto overscroll-contain border-r border-line bg-ground/40 lg:block">
            <DocsSidebar sections={DOCS_NAV} />
          </aside>
          <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 outline-none sm:px-6 lg:px-10 xl:px-12">
            {children}
          </main>
        </div>
        <SiteFooter compact />
      </div>
    </DocsSearchProvider>
  );
}

/** Where a page sits: the docs, then its section. */
function Breadcrumb({ section }: { section: string }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex min-w-0 items-center gap-1 text-[0.8125rem] text-ink-3">
        <li>
          <Link href="/docs" className="rounded-md transition-colors duration-150 ease-standard hover:text-agent">
            Docs
          </Link>
        </li>
        <li aria-hidden>
          <ChevronRight className="size-3.5" />
        </li>
        <li className="truncate font-medium text-ink-2">{section}</li>
      </ol>
    </nav>
  );
}

/**
 * One docs page inside the shell (docs redesign D4): where it sits, "Copy page", its title and lead, the content at a
 * reading width of 44rem (about 75 characters a line), then the edit link and the previous and next pages; "On this
 * page" beside it from `xl` up when the page has sections to list. `hero` replaces the title block on the docs' home.
 * The Markdown to copy is the page's `.md` view, written here when the page is built.
 */
export function DocsPage({
  slug,
  section,
  title,
  description,
  headings,
  hero,
  children,
}: {
  slug: string;
  section: string;
  title: ReactNode;
  description?: ReactNode;
  headings: Heading[];
  hero?: ReactNode;
  children: ReactNode;
}) {
  const markdown = pageMarkdown(slug, publicOrigin());
  const toc = headings.length >= 2;
  return (
    <div className="flex gap-10 xl:gap-14">
      <article className="min-w-0 max-w-[44rem] flex-1 pb-16 pt-6 sm:pt-8">
        {hero ?? (
          <header className="mb-10">
            <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <Breadcrumb section={section} />
              {markdown !== null && <CopyPage slug={slug} markdown={markdown} />}
            </div>
            <h1 className="mt-4 text-balance text-[2rem] font-semibold leading-[1.15] tracking-[-0.03em] text-ink [overflow-wrap:anywhere] sm:text-[2.375rem]">
              {title}
            </h1>
            {description && <p className="mt-4 text-pretty text-[1.125rem] leading-relaxed text-ink-2">{description}</p>}
          </header>
        )}
        {children}
        {hasSource(slug) && (
          <p className="mt-14">
            <a
              href={editHref(slug)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-6 items-center gap-1.5 text-[0.875rem] text-ink-3 underline-offset-4 transition-colors duration-150 ease-standard hover:text-agent hover:underline"
            >
              <PencilLine aria-hidden className="size-3.5" />
              Edit this page on GitHub
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        )}
        <DocsPager slug={slug} />
      </article>
      {toc && (
        <aside className="sticky top-16 hidden max-h-[calc(100dvh-4rem)] w-56 shrink-0 self-start overflow-y-auto py-8 xl:block">
          <DocsToc headings={headings} />
        </aside>
      )}
    </div>
  );
}
