import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Show and hide, built on <details>: it works before JavaScript runs, opens for
 * find-in-page, and animates its height where the browser can (`.disclosure`
 * in globals.css). `bare` drops the frame and the chevron, for rows that draw
 * their own summary.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen,
  variant = "default",
  id,
  className,
  summaryClassName,
  contentClassName,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  variant?: "default" | "bare";
  id?: string;
  className?: string;
  summaryClassName?: string;
  contentClassName?: string;
}) {
  const framed = variant === "default";
  return (
    <details id={id} open={defaultOpen} className={cn("disclosure group/disclosure", framed && "rounded-2xl border border-line bg-surface shadow-surface", className)}>
      <summary
        className={cn(
          "cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden",
          framed && "flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium text-ink-2 transition-colors duration-150 hover:text-ink",
          summaryClassName
        )}
      >
        {framed && <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-3 transition-transform duration-200 ease-standard group-open/disclosure:rotate-90" />}
        {summary}
      </summary>
      <div className={cn(framed && "px-4 pb-4", contentClassName)}>{children}</div>
    </details>
  );
}
