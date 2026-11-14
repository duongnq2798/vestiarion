"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { RetryButton } from "@/components/ui/RetryButton";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";

/**
 * A page outside a workspace that fails to load: sign-in, onboarding, the accountant's portfolio, a payee's or a
 * supplier's link (docs/superpowers/specs/2026-11-14-loading-states-design.md L7). It says so in the site's own frame,
 * with a way to try the page again and a way home, instead of the browser's bare error. A workspace page has its own,
 * in `o/[slug]/error.tsx`. In production a server error's message is generic; the digest matches it to the server's log.
 */
export default function SiteError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-16">
        <div role="alert" className="w-full max-w-md text-center">
          <p>
            <Eyebrow className="text-refused">Something went wrong</Eyebrow>
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-ink">This page could not be shown</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">
            Try it again in a moment. If it keeps failing, the status page says whether Vestiarion is having trouble.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <RetryButton retry={retry} />
            <Button asChild variant="secondary">
              <Link href="/status">See the status page</Link>
            </Button>
          </div>
          {error.digest && <p className="mt-6 font-mono text-xs text-ink-3">Server log reference {error.digest}</p>}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
