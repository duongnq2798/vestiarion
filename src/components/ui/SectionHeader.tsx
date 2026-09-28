import type { ReactNode } from "react";
import { cn } from "./cn";

/** A section’s title, a quiet note beside it, and an action on the right. */
export function SectionHeader({ title, meta, action, id, className }: { title: ReactNode; meta?: ReactNode; action?: ReactNode; id?: string; className?: string }) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1", className)}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={id} className="text-base font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {meta && <span className="text-[0.8125rem] text-ink-3">{meta}</span>}
      </div>
      {action}
    </div>
  );
}
