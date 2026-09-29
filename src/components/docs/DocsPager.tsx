import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { docsHref, neighbours, type NavPage } from "@/lib/docs/nav";

function PagerLink({ page, direction }: { page: NavPage; direction: "prev" | "next" }) {
  const next = direction === "next";
  return (
    <Link
      href={docsHref(page.slug)}
      rel={direction}
      className={cn(
        "group flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3 transition-colors duration-150 ease-standard hover:border-agent-line",
        next ? "items-end text-right sm:col-start-2" : "items-start"
      )}
    >
      <span className="inline-flex items-center gap-1.5 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3">
        {!next && <ArrowLeft aria-hidden className="size-3.5" />}
        {next ? "Next" : "Previous"}
        {next && <ArrowRight aria-hidden className="size-3.5" />}
      </span>
      <span className="max-w-full truncate text-sm font-semibold text-ink group-hover:text-agent">{page.title}</span>
    </Link>
  );
}

/** The pages before and after this one, in nav order. */
export function DocsPager({ slug }: { slug: string }) {
  const { prev, next } = neighbours(slug);
  if (!prev && !next) return null;
  return (
    <nav aria-label="Previous and next pages" className="mt-14 grid gap-3 border-t border-line pt-8 sm:grid-cols-2">
      {prev && <PagerLink page={prev} direction="prev" />}
      {next && <PagerLink page={next} direction="next" />}
    </nav>
  );
}
