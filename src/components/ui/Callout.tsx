import { cva, type VariantProps } from "class-variance-authority";
import { CircleCheck, CirclePause, Info, OctagonMinus, Sparkles, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export const calloutVariants = cva("flex gap-3 rounded-xl border px-4 py-3 text-sm", {
  variants: {
    tone: {
      neutral: "border-line-strong bg-surface text-ink-2",
      agent: "border-agent-line bg-agent-soft text-ink",
      proof: "border-proof-line bg-proof-soft text-ink",
      held: "border-held-line bg-held-soft text-ink",
      refused: "border-refused-line bg-refused-soft text-ink",
    },
  },
  defaultVariants: { tone: "neutral" },
});

type Tone = NonNullable<VariantProps<typeof calloutVariants>["tone"]>;

// The same shapes as the outcome glyphs: a pause for held, an octagon for refused.
const TONE: Record<Tone, { icon: LucideIcon; accent: string }> = {
  neutral: { icon: Info, accent: "text-ink" },
  agent: { icon: Sparkles, accent: "text-agent" },
  proof: { icon: CircleCheck, accent: "text-proof" },
  held: { icon: CirclePause, accent: "text-held" },
  refused: { icon: OctagonMinus, accent: "text-refused" },
};

export type CalloutProps = {
  tone?: Tone;
  title?: ReactNode;
  /** Replaces the tone’s icon. */
  icon?: ReactNode;
  /** `alert` for something that went wrong just now, `status` for news, nothing for standing information. */
  role?: "alert" | "status";
  className?: string;
  children?: ReactNode;
};

/** A block that stands apart from the page: a refusal, a warning, a recommendation. */
export function Callout({ tone = "neutral", title, icon, role, className, children }: CalloutProps) {
  const { icon: Icon, accent } = TONE[tone];
  return (
    <div role={role} className={cn(calloutVariants({ tone }), className)}>
      <span aria-hidden className={cn("mt-0.5 shrink-0 [&_svg]:size-[1.125rem]", accent)}>
        {icon ?? <Icon />}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className={cn("font-semibold leading-snug", accent)}>{title}</p>}
        {children && <div className="leading-relaxed">{children}</div>}
      </div>
    </div>
  );
}
