import Link from "next/link";
import type { ReactNode } from "react";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SiteFooter, SiteHeader } from "./SiteChrome";

/**
 * The frame of the terms and privacy pages (spec §2, F2): the site header, a
 * reading column of at most 48rem with the title and the date the page was
 * last updated, and the compact footer, like the other one-column public
 * pages. The prose takes the docs' type: 1rem at a 1.75 line height.
 */

const PROSE =
  "[&_p]:mt-4 [&_p]:leading-7 [&_p]:text-ink-2 [&_p]:[overflow-wrap:anywhere] [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_ul]:leading-7 [&_ul]:text-ink-2 [&_li]:pl-1 [&_li]:[overflow-wrap:anywhere] [&_li]:marker:text-ink-3 [&_strong]:font-semibold [&_strong]:text-ink [&_code]:font-mono [&_code]:text-[0.875em] [&_code]:text-ink";

const LINK =
  "font-medium text-agent underline decoration-agent-line underline-offset-4 [overflow-wrap:anywhere] transition-colors duration-150 ease-standard hover:decoration-agent";

export function LegalPage({ title, updated, intro, children }: { title: string; updated: string; intro: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex-1 px-4 py-12 sm:px-6 sm:py-16">
        <article className="mx-auto w-full max-w-3xl">
          <header className="border-b border-line pb-6">
            <p>
              <Eyebrow className="text-agent">Legal</Eyebrow>
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-ink sm:text-[2.125rem]">{title}</h1>
            <p className="mt-2 font-mono text-xs text-ink-3">
              Last updated <time dateTime={updated}>{updated}</time>
            </p>
            <p className="mt-4 text-base leading-7 text-ink-2">{intro}</p>
          </header>
          <div className={PROSE}>{children}</div>
        </article>
      </main>
      <SiteFooter compact />
    </div>
  );
}

/** One titled part of the page; its heading is an anchor others can link to. */
export function LegalSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-10">
      <h2 id={id} className="scroll-mt-20 text-xl font-semibold tracking-tight text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A link in the prose: another site in a new tab, a page of this app through the router. */
export function LegalLink({ href, children }: { href: string; children: ReactNode }) {
  if (/^https?:\/\//.test(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={LINK}>
      {children}
    </Link>
  );
}
