import Link from "next/link";
import { TERM_PAGES } from "@/lib/payment-terms/pages";

/** The term pages (docs/superpowers/specs/2026-10-28-payment-terms-design.md PT8), each with what it means; `except` leaves out the page it is on. */
export function TermLinks({ except }: { except?: string }) {
  return (
    <ul className="mt-4 grid gap-3 sm:grid-cols-2">
      {TERM_PAGES.filter((page) => page.slug !== except).map((page) => (
        <li key={page.slug} className="rounded-xl border border-line bg-surface px-4 py-3">
          <Link href={`/payment-terms/${page.slug}`} className="text-sm font-semibold text-agent underline-offset-4 hover:underline">
            {page.words}
          </Link>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">{page.meaning}</p>
        </li>
      ))}
    </ul>
  );
}
