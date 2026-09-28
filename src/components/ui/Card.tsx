import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./cn";

export const cardVariants = cva("rounded-2xl border bg-surface shadow-surface", {
  variants: {
    tone: {
      default: "border-line",
      agent: "border-agent-line",
      held: "border-held-line",
      refused: "border-refused-line",
      simulated: "border-dashed border-line-strong",
    },
    interactive: {
      true: "transition duration-200 ease-standard hover:-translate-y-0.5 hover:border-agent-line hover:shadow-raised active:translate-y-0",
      false: "",
    },
  },
  defaultVariants: { tone: "default", interactive: false },
});

export type CardProps = ComponentProps<"div"> & VariantProps<typeof cardVariants> & { asChild?: boolean };

/** A surface that holds one thing. `asChild` gives a `Link`, `article` or `li` the card’s look. */
export function Card({ tone, interactive, asChild = false, className, ...props }: CardProps) {
  const Comp = asChild ? Slot.Root : "div";
  return <Comp className={cn(cardVariants({ tone, interactive }), className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1 px-5 pt-5 sm:px-6 sm:pt-6", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("text-base font-semibold leading-snug tracking-tight text-ink", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm leading-relaxed text-ink-2", className)} {...props} />;
}

/** The card’s body. Right after a header it sits closer, as the header’s continuation. */
export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-5 sm:p-6 [[data-slot=card-header]+&]:pt-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-wrap items-center gap-3 rounded-b-2xl border-t border-line bg-ground/40 px-5 py-3 sm:px-6", className)} {...props} />;
}
