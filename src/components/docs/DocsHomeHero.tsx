import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { DocsSearchHero } from "./DocsSearch";

/**
 * The top of the docs' home (docs redesign D5): what the docs are for, in a line; search, which most visitors come
 * for; and the two ways in, the first decision for a business and the quickstart for a developer. It takes the place of
 * the page's title block; the page's own MDX follows it.
 */
export function DocsHomeHero() {
  return (
    <header className="mb-12 border-b border-line pb-10">
      <Eyebrow className="text-agent">Vestiarion docs</Eyebrow>
      <h1 className="mt-3 text-balance text-[2.25rem] font-semibold leading-[1.1] tracking-[-0.035em] text-ink sm:text-[2.75rem]">
        Run your bills and payments with the agent, or build on it.
      </h1>
      <p className="mt-4 max-w-2xl text-pretty text-[1.125rem] leading-relaxed text-ink-2">
        Guides for a business, from its first decision to live payments, and the API, SDK and webhooks for developers.
      </p>
      <div className="mt-7">
        <DocsSearchHero />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button asChild>
          <Link href="/docs/guides/try-it">
            See your first decision
            <ArrowRight aria-hidden />
          </Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href="/docs/get-started/quickstart">Developer quickstart</Link>
        </Button>
      </div>
    </header>
  );
}
