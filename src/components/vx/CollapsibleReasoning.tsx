"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Reasoning } from "./Primitives";

/** Below this many characters the reasoning is short enough to read whole: no toggle. */
const LONG = 240;

/**
 * An agent's reasoning shown as its first three lines, with "View reasoning" to read it all: for a page that
 * lists decisions to scan, such as the console's treasury decisions. The whole text is always in the page,
 * for find-in-page and for screen readers; only its height is clamped.
 */
export function CollapsibleReasoning({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (text.length <= LONG) return <Reasoning text={text} className={className} />;
  return (
    <div>
      <div id={id}>
        <Reasoning text={text} className={cn(className, !open && "line-clamp-3")} />
      </div>
      <Button variant="link" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)} className="mt-1.5 text-[0.8125rem]">
        {open ? "Hide reasoning" : "View reasoning"}
      </Button>
    </div>
  );
}
