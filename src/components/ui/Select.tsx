"use client";

import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./cn";
import { useFieldControl } from "./Field";
import { controlVariants } from "./Input";
import { menuItem, overlayMotion, overlaySurface } from "./overlay";

/**
 * A select that looks the same on every system. Given a `name` inside a form,
 * Radix renders a hidden native select, so the value reaches the form’s
 * `FormData`, and it returns to `defaultValue` when the form resets.
 */
export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export function SelectTrigger({ className, size, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger> & { size?: "sm" | "md" }) {
  const control = useFieldControl(props);
  return (
    <SelectPrimitive.Trigger
      className={cn(controlVariants({ size }), "group/select flex cursor-pointer items-center justify-between gap-2 text-left data-[placeholder]:text-ink-3 [&>span]:truncate", className)}
      {...props}
      {...control}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-ink-3 transition-transform duration-200 ease-standard group-data-[state=open]/select:rotate-180" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({ className, children, position = "popper", ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={6}
        className={cn(
          overlaySurface,
          overlayMotion,
          "relative max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin) overflow-y-auto overflow-x-hidden p-1",
          className
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-6 cursor-default items-center justify-center text-ink-3">
          <ChevronUp aria-hidden className="size-4" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-6 cursor-default items-center justify-center text-ink-3">
          <ChevronDown aria-hidden className="size-4" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item className={cn(menuItem, "pr-9", className)} {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2.5 inline-flex">
        <Check aria-hidden className="text-agent" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
