import type { ReactNode } from "react";
import { cn } from "./cn";

/** What an empty view says instead of nothing: what would be here, and how to get it there. */
export function EmptyState({
  title,
  body,
  icon,
  action,
  compact = false,
  titleAs: Title = "h3",
  className,
}: {
  title: ReactNode;
  body?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  titleAs?: "h2" | "h3";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "hatch flex flex-col items-start gap-4 rounded-2xl border border-dashed border-line-strong bg-surface/80",
        compact ? "px-4 py-6" : "px-5 py-8 sm:px-8 sm:py-10",
        className
      )}
    >
      {icon && (
        <span aria-hidden className="grid size-10 place-items-center rounded-full border border-line bg-surface text-ink-3 shadow-control [&_svg]:size-5">
          {icon}
        </span>
      )}
      <div className="space-y-1.5">
        <Title className="text-base font-semibold text-ink">{title}</Title>
        {body && <div className="max-w-prose text-sm leading-relaxed text-ink-2">{body}</div>}
      </div>
      {action}
    </div>
  );
}
