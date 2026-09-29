"use client";

import { RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Eyebrow } from "@/components/ui/Eyebrow";

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
      <Card tone="refused" role="alert" className="max-w-2xl p-6 sm:p-8">
        <Eyebrow className="text-refused">Something went wrong</Eyebrow>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink">This section could not be shown</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">
          Try this section again, or choose another one from the navigation — the rest of the workspace is still available.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button icon={<RotateCcw />} onClick={() => retry()}>
            Try again
          </Button>
          {error.digest && <span className="font-mono text-xs text-ink-3">Server log reference {error.digest}</span>}
        </div>
      </Card>
    </div>
  );
}
