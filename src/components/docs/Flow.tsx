import { Children, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/**
 * A workflow as the product runs it (docs redesign D7): its steps in order on a line, each a short title and what
 * happens there, with an optional title above and caption below. Dots, not numbers, so it is never read as the guide's
 * own numbered steps. An ordered list, so a screen reader hears the steps and their order; the line and dots are drawn
 * for the eye alone. `compact` sets it in smaller type, closer together, for a narrow place (the docs' home hero). The
 * Markdown view writes it as a numbered list (`MDX_TO_MARKDOWN` in src/lib/docs/markdown.ts). Use it for a flow the
 * guide already describes in words, never for one it does not.
 */
export function Flow({
  title,
  caption,
  compact = false,
  className,
  children,
}: {
  title?: string;
  caption?: string;
  compact?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const steps = Children.toArray(children);
  return (
    <figure className={cn("my-8 rounded-xl border border-line bg-ground/30 px-5 py-5 sm:px-6", className)}>
      {title && <p className="mb-4 text-[0.8125rem] font-semibold text-ink">{title}</p>}
      <ol className={compact ? "text-[0.8125rem] leading-snug" : "text-[0.9375rem] leading-relaxed"}>
        {steps.map((step, index) => (
          <li key={index} className={cn("relative flex gap-3.5 last:pb-0", compact ? "pb-3.5" : "pb-5")}>
            {index < steps.length - 1 && (
              <span aria-hidden className={cn("absolute bottom-0 left-[0.4375rem] w-px bg-line-strong", compact ? "top-4" : "top-5")} />
            )}
            <span
              aria-hidden
              className={cn("relative size-[0.9375rem] shrink-0 rounded-full border-2 border-agent bg-surface", compact ? "mt-px" : "mt-1.5")}
            />
            <div className="min-w-0 flex-1">{step}</div>
          </li>
        ))}
      </ol>
      {caption && <figcaption className="mt-4 border-t border-line pt-3 text-[0.875rem] leading-relaxed text-ink-3">{caption}</figcaption>}
    </figure>
  );
}

/** One step of a `Flow`: its title, and what happens there, in the figure's type. */
export function FlowStep({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <p className="m-0 font-semibold text-ink">{title}</p>
      {children && <div className="mt-0.5 text-ink-2 [&_p]:m-0 [&_p]:text-[length:inherit] [&_p]:leading-[inherit]">{children}</div>}
    </div>
  );
}
