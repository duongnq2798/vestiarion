"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";

/** One per app, in the root layout: it lets a second tooltip open without the first one’s delay. */
export const TooltipProvider = TooltipPrimitive.Provider;

// Radix marks an open tooltip `delayed-open` or `instant-open`, never `open`, so it animates in on mount.
const TOOLTIP_MOTION = [
  "animate-in fade-in-0 zoom-in-95 duration-200 ease-emphasized",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:duration-150 data-[state=closed]:ease-exit",
  "data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1",
].join(" ");

/**
 * A short label for a control with no visible text — an icon button, a
 * truncated value. Never the only place something essential is said: touch
 * screens cannot hover. `disabled` keeps it closed while leaving the trigger
 * where it is, so a control that only sometimes needs one (the sidebar's icon
 * rail) keeps its element, and its focus, when it stops needing it.
 */
export function Tooltip({
  content,
  side = "top",
  disabled = false,
  children,
}: {
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  disabled?: boolean;
  children: ReactElement;
}) {
  return (
    <TooltipPrimitive.Root {...(disabled ? { open: false } : {})}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn("z-50 max-w-xs rounded-lg bg-ink px-2.5 py-1.5 text-xs font-medium text-ground shadow-overlay", TOOLTIP_MOTION)}
        >
          {content}
          <TooltipPrimitive.Arrow width={10} height={5} className="fill-ink" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
