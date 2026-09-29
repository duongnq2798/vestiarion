"use client";

import { Check } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "./cn";

export type CheckboxProps = Omit<ComponentProps<typeof CheckboxPrimitive.Root>, "children"> & {
  label: ReactNode;
  description?: ReactNode;
};

/**
 * A checkbox with its label. Inside a form it submits `name=on` when ticked,
 * like a native one, and returns to its default when the form resets.
 *
 * `className` styles the row — the box and the label together — not the box alone.
 */
export function Checkbox({ label, description, id, className, ...props }: CheckboxProps) {
  const generated = useId();
  const checkboxId = id ?? generated;
  const descriptionId = description ? `${checkboxId}-description` : undefined;
  return (
    <div className={cn("flex items-start gap-3 has-[[data-disabled]]:opacity-60", className)}>
      <CheckboxPrimitive.Root
        id={checkboxId}
        aria-describedby={descriptionId}
        className="mt-0.5 grid size-5 shrink-0 cursor-pointer place-items-center rounded-md border border-line-strong bg-surface text-on-agent shadow-control transition-colors duration-150 ease-standard disabled:cursor-not-allowed data-[state=checked]:border-agent data-[state=checked]:bg-agent"
        {...props}
      >
        <CheckboxPrimitive.Indicator className="duration-150 data-[state=checked]:animate-in data-[state=checked]:zoom-in-50">
          <Check aria-hidden strokeWidth={3} className="size-3.5" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <div className="grid gap-0.5">
        <label htmlFor={checkboxId} className="cursor-pointer text-sm leading-6 text-ink">
          {label}
        </label>
        {description && (
          <p id={descriptionId} className="text-xs text-ink-3">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
