import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { DocsSearchHero } from "./DocsSearch";
import { Flow, FlowStep } from "./Flow";

/**
 * The top of the docs' home (docs redesign D5, docs home polish H3): what the docs are for, in a line; search, which most
 * visitors come for, the only search field on this page; and the two ways in, the first decision for a business and the
 * quickstart for a developer. Beside them from `xl`, how a bill moves through Vestiarion in four steps, each one the
 * product's own (guides/try-it, guides/controls), with the guide on how payments are controlled. It takes the place of
 * the page's title block; the page's own MDX follows it.
 */
export function DocsHomeHero() {
  return (
    <header className="mb-12 grid gap-10 border-b border-line pb-10 xl:grid-cols-[minmax(0,1fr)_19rem] xl:items-center">
      <div className="min-w-0">
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
      </div>
      <div className="hidden min-w-0 xl:block">
        <Flow title="How a bill moves" compact className="my-0 bg-surface px-5 py-4 shadow-surface sm:px-5">
          <FlowStep title="A bill comes in">From a form, a PDF, your accounting tool, email, Chrome or the API.</FlowStep>
          <FlowStep title="The agent decides">Pay now, pay later, hold it or ask for what is missing, and says why.</FlowStep>
          <FlowStep title="Rules in code check it">Limits, duplicates and the payee. Code can refuse what the model proposes.</FlowStep>
          <FlowStep title="Paid, or held for you">In USDC on Arc, within your limits, or a person decides.</FlowStep>
        </Flow>
        <Link
          href="/docs/guides/controls"
          className="mt-3 inline-flex min-h-6 items-center gap-1 text-[0.8125rem] font-medium text-agent underline-offset-4 hover:underline"
        >
          How payments are controlled
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      </div>
    </header>
  );
}
