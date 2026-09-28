"use client";

import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";
import { useFieldControl } from "./Field";

/** The frame every text-like control shares — inputs, text areas, select triggers — without a height. */
export const controlBase = [
  "w-full min-w-0 border border-line-strong bg-surface text-base text-ink shadow-control outline-hidden sm:text-sm",
  "transition-[border-color,box-shadow] duration-150 ease-standard placeholder:text-ink-3",
  "focus-visible:border-agent focus-visible:ring-4 focus-visible:ring-agent-soft",
  "aria-invalid:border-refused aria-invalid:focus-visible:ring-refused-soft",
  "disabled:cursor-not-allowed disabled:opacity-60",
].join(" ");

export const controlVariants = cva(controlBase, {
  variants: {
    size: {
      sm: "h-9 rounded-lg px-2.5 sm:h-8",
      md: "h-11 rounded-xl px-3 sm:h-10",
    },
  },
  defaultVariants: { size: "md" },
});

export type InputProps = Omit<ComponentProps<"input">, "size"> & { size?: VariantProps<typeof controlVariants>["size"] };

export function Input({ className, size, ...props }: InputProps) {
  const control = useFieldControl(props);
  return <input className={cn(controlVariants({ size }), className)} {...props} {...control} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  const control = useFieldControl(props);
  return <textarea className={cn(controlBase, "min-h-24 resize-y rounded-xl px-3 py-2.5", className)} {...props} {...control} />;
}
