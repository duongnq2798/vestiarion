import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "./cn";

export const badgeVariants = cva("inline-flex max-w-full items-center gap-1.5 whitespace-nowrap border font-semibold [&_svg]:shrink-0", {
  variants: {
    tone: {
      neutral: "border-line-strong bg-surface text-ink-2",
      agent: "border-agent-line bg-agent-soft text-agent",
      proof: "border-proof-line bg-proof-soft text-proof",
      held: "border-held-line bg-held-soft text-held",
      refused: "border-refused-line bg-refused-soft text-refused",
      simulated: "hatch border-dashed border-line-strong bg-surface/70 text-ink-2",
    },
    size: {
      sm: "rounded-full px-2 py-0.5 text-[0.6875rem] [&_svg]:size-3",
      md: "rounded-full px-2.5 py-1 text-xs [&_svg]:size-3.5",
    },
    shape: {
      pill: "",
      tag: "rounded-md",
    },
  },
  defaultVariants: { tone: "neutral", size: "md", shape: "pill" },
});

type Tone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

const DOT: Record<Tone, string> = {
  neutral: "bg-ink-3",
  agent: "bg-agent",
  proof: "bg-proof",
  held: "bg-held",
  refused: "bg-refused",
  simulated: "border border-dashed border-ink-3",
};

export type BadgeProps = VariantProps<typeof badgeVariants> & {
  children: ReactNode;
  /** A leading status dot in the badge’s tone. */
  dot?: boolean;
  /** A leading icon; takes the dot’s place. */
  icon?: ReactNode;
  title?: string;
  className?: string;
};

/** A status or a label. Tone carries meaning, so a badge always says it in words too. */
export function Badge({ tone, size, shape, dot = false, icon, title, className, children }: BadgeProps) {
  return (
    <span title={title} className={cn(badgeVariants({ tone, size, shape }), className)}>
      {icon ?? (dot ? <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tone ?? "neutral"])} /> : null)}
      {children}
    </span>
  );
}
