"use client";

import { useEffect } from "react";

/**
 * A page that fails to load fails inside the workspace, not instead of it:
 * the navigation stays, so every other section is still one click away.
 * In production the message from a server error is generic; the digest is
 * what matches it to the server's log.
 */
export default function WorkspaceError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
      <div role="alert" className="surface-shadow max-w-2xl rounded-2xl border border-refused-line bg-surface p-6 sm:p-8">
        <p className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-refused">Something went wrong</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink">This section could not be shown</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">
          Try this section again, or choose another one from the navigation — the rest of the workspace is still
          available.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => retry()}
            className="brand-shadow h-10 rounded-xl bg-agent px-4 text-sm font-semibold text-on-agent transition-transform hover:-translate-y-0.5"
          >
            Try again
          </button>
          {error.digest && <span className="font-mono text-xs text-ink-3">Server log reference {error.digest}</span>}
        </div>
      </div>
    </div>
  );
}
