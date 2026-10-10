"use client";

import { Popover as PopoverPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./cn";
import { overlayMotion, overlaySurface } from "./overlay";

/**
 * A small panel anchored to the control that opened it, for facts that need a sentence each — what a status chip
 * means — where a tooltip is too short and a dialog too much. Not modal: Escape, a click outside or the trigger closes
 * it, and focus returns to the trigger.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({ className, align = "end", sideOffset = 8, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(overlaySurface, overlayMotion, "max-h-(--radix-popover-content-available-height) w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto p-4", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
