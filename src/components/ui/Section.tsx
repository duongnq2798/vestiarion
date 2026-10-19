import type { ComponentProps } from "react";
import { cn } from "./cn";

const TONE = {
  ground: "bg-ground text-ink focus-default",
  surface: "bg-surface text-ink focus-default",
  agent: "bg-agent text-on-agent focus-inverse",
  ink: "bg-ink text-on-agent focus-inverse",
} as const;

export type SectionProps = ComponentProps<"section"> & {
  tone?: keyof typeof TONE;
  /** Overrides the inner container's width and spacing independently of the section. */
  containerClassName?: string;
};

/** A full-width region with a bounded reading area and focus suited to its surface. */
export function Section({ tone = "ground", className, containerClassName, children, ...props }: SectionProps) {
  return (
    <section className={cn(TONE[tone], className)} {...props}>
      <div className={cn("mx-auto max-w-7xl px-page py-section", containerClassName)}>{children}</div>
    </section>
  );
}
