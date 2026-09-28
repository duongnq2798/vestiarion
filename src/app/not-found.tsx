import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";

/** Any address that matches no page. Workspace addresses have their own, in `o/not-found.tsx`. */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-md text-center">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.11em] text-agent">404</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-ink">This page does not exist</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">The address may be mistyped, or the page may have moved.</p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/onboarding" className="brand-shadow inline-flex h-11 items-center justify-center rounded-xl bg-agent px-5 text-sm font-semibold text-on-agent transition-transform hover:-translate-y-0.5">
              Open console
            </Link>
            <Link href="/" className="inline-flex h-11 items-center justify-center rounded-xl border border-line-strong bg-surface/80 px-5 text-sm font-semibold text-ink transition-colors hover:border-agent-line hover:text-agent">
              Go to the homepage
            </Link>
          </div>
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
