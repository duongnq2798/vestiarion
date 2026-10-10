"use client";

import { RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { FrameBanners } from "@/components/vx/FrameContext";
import { WorkspaceHeader } from "@/components/vx/WorkspaceHeader";

/**
 * A page that fails to load fails inside the workspace, not instead of it:
 * the navigation and the header stay, so every other section is still one
 * click away.
 * In production the message from a server error is generic; the digest is
 * what matches it to the server's log.
 */
export default function WorkspaceError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <>
      <WorkspaceHeader />
      <div className={cn(CONTENT_FRAME, "pb-10 pt-4 sm:pt-6 lg:pt-7")}>
        <FrameBanners />
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
    </>
  );
}
