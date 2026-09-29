import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import type { Heading } from "@/lib/docs/headings";
import { DOCS_NAV } from "@/lib/docs/nav";
import { DocsPager } from "./DocsPager";
import { DocsMobileNav, DocsSidebar } from "./DocsSidebar";
import { DocsToc } from "./DocsToc";

/**
 * The frame around every docs page, rendered by the `/docs` layout: the site
 * header labelled "Docs", the sidebar from `lg` up (a drawer from the header
 * below it), and the page. The page brings its own table of contents, through
 * `DocsPage`, so the frame stays put while pages change beneath it.
 */
export function DocsShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-ground">
      <SiteHeader section={{ href: "/docs", label: "Docs" }} wide>
        <Button asChild variant="ghost" className="hidden sm:inline-flex">
          <Link href="/onboarding">Open console</Link>
        </Button>
        <DocsMobileNav sections={DOCS_NAV} />
      </SiteHeader>
      <div className="mx-auto flex w-full max-w-[88rem] flex-1">
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-64 shrink-0 overflow-y-auto overscroll-contain border-r border-line/80 lg:block">
          <DocsSidebar sections={DOCS_NAV} />
        </aside>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 outline-none sm:px-6 lg:px-10">
          {children}
        </main>
      </div>
      <SiteFooter compact />
    </div>
  );
}

/**
 * One docs page inside the shell: its section, title and description, the
 * content at a reading width of at most 48rem, the previous and next pages,
 * and "On this page" beside it from `xl` up.
 */
export function DocsPage({
  slug,
  section,
  title,
  description,
  headings,
  children,
}: {
  slug: string;
  section: string;
  title: ReactNode;
  description?: ReactNode;
  headings: Heading[];
  children: ReactNode;
}) {
  return (
    <div className="flex gap-10">
      <article className="min-w-0 max-w-3xl flex-1 pb-16 pt-8 sm:pt-10">
        <header className="mb-8 border-b border-line pb-6">
          <p className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-agent">{section}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink [overflow-wrap:anywhere] sm:text-[2.125rem]">{title}</h1>
          {description && <p className="mt-3 text-base leading-relaxed text-ink-2">{description}</p>}
        </header>
        {children}
        <DocsPager slug={slug} />
      </article>
      <aside className="sticky top-16 hidden max-h-[calc(100dvh-4rem)] w-52 shrink-0 self-start overflow-y-auto py-10 xl:block">
        <DocsToc headings={headings} />
      </aside>
    </div>
  );
}
