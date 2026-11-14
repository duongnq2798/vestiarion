"use client";

import { useEffect } from "react";
import { RetryButton } from "@/components/ui/RetryButton";
import "./globals.css";

/**
 * The last resort, when the root layout itself fails (docs/superpowers/specs/2026-11-14-loading-states-design.md L7):
 * it stands in for the whole document, so it brings its own `<html>`, `<body>` and styles, and nothing that needs the
 * layout. Every other failure is caught nearer, by `error.tsx` or `o/[slug]/error.tsx`.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-16">
          <div role="alert" className="w-full max-w-md text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-refused">Something went wrong</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-ink">Vestiarion could not be shown</h1>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              Try again in a moment. If it keeps failing, <a className="text-agent underline underline-offset-4" href="/status">the status page</a> says whether
              Vestiarion is having trouble.
            </p>
            <div className="mt-8 flex justify-center">
              <RetryButton retry={retry} />
            </div>
            {error.digest && <p className="mt-6 font-mono text-xs text-ink-3">Server log reference {error.digest}</p>}
          </div>
        </main>
      </body>
    </html>
  );
}
