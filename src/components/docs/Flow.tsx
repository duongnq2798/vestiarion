import { Children, type ReactNode } from "react";

/**
 * A workflow as the product runs it (docs redesign D7): its steps in order on a line, each a short title and what
 * happens there, with an optional caption for what the figure leaves out. Dots, not numbers, so it is never read as the
 * guide's own numbered steps. An ordered list, so a screen reader hears the steps and their order; the line and dots
 * are drawn for the eye alone. The Markdown view writes it as a numbered list (`MDX_TO_MARKDOWN` in
 * src/lib/docs/markdown.ts). Use it for a flow the guide already describes in words, never for one it does not.
 */
export function Flow({ caption, children }: { caption?: string; children?: ReactNode }) {
  const steps = Children.toArray(children);
  return (
    <figure className="my-8 rounded-xl border border-line bg-ground/30 px-5 py-5 sm:px-6">
      <ol>
        {steps.map((step, index) => (
          <li key={index} className="relative flex gap-4 pb-5 last:pb-0">
            {index < steps.length - 1 && <span aria-hidden className="absolute bottom-0 left-[0.4375rem] top-5 w-px bg-line-strong" />}
            <span aria-hidden className="relative mt-1.5 size-[0.9375rem] shrink-0 rounded-full border-2 border-agent bg-surface" />
            <div className="min-w-0 flex-1">{step}</div>
          </li>
        ))}
      </ol>
      {caption && <figcaption className="mt-4 border-t border-line pt-3 text-[0.875rem] leading-relaxed text-ink-3">{caption}</figcaption>}
    </figure>
  );
}

/** One step of a `Flow`: its title, and what happens there. */
export function FlowStep({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="text-[0.9375rem] leading-relaxed">
      <p className="m-0 font-semibold text-ink">{title}</p>
      {children && <div className="text-ink-2 [&_p]:m-0 [&_p]:text-[0.9375rem] [&_p]:leading-relaxed">{children}</div>}
    </div>
  );
}
