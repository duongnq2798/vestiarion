"use client";

import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "./cn";

export interface RadioOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
}

export type RadioGroupProps = Omit<ComponentProps<typeof RadioGroupPrimitive.Root>, "children"> & {
  /** The group's name for people; the `name` prop is what a form submits it as. */
  legend: ReactNode;
  options: readonly RadioOption[];
};

/**
 * One choice among a few, each with its label and an optional line under it. Inside a form it submits `name=<value>`
 * like native radio buttons, and returns to its default when the form resets.
 *
 * `className` styles the group, not each option.
 */
export function RadioGroup({ legend, options, className, ...props }: RadioGroupProps) {
  const generated = useId();
  const legendId = `${generated}-legend`;
  return (
    <div className={cn("grid gap-3", className)}>
      <p id={legendId} className="text-sm font-medium text-ink">
        {legend}
      </p>
      <RadioGroupPrimitive.Root aria-labelledby={legendId} className="grid gap-3" {...props}>
        {options.map((option) => {
          const itemId = `${generated}-${option.value}`;
          const descriptionId = option.description ? `${itemId}-description` : undefined;
          return (
            <div key={option.value} className="flex items-start gap-3 has-[[data-disabled]]:opacity-60">
              <RadioGroupPrimitive.Item
                id={itemId}
                value={option.value}
                aria-describedby={descriptionId}
                className="mt-0.5 grid size-5 shrink-0 cursor-pointer place-items-center rounded-full border border-line-strong bg-surface shadow-control transition-colors duration-150 ease-standard focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-agent disabled:cursor-not-allowed data-[state=checked]:border-agent"
              >
                <RadioGroupPrimitive.Indicator className="size-2.5 rounded-full bg-agent duration-150 data-[state=checked]:animate-in data-[state=checked]:zoom-in-50" />
              </RadioGroupPrimitive.Item>
              <div className="grid gap-0.5">
                <label htmlFor={itemId} className="cursor-pointer text-sm leading-6 text-ink">
                  {option.label}
                </label>
                {option.description && (
                  <p id={descriptionId} className="text-xs text-ink-3">
                    {option.description}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </RadioGroupPrimitive.Root>
    </div>
  );
}
