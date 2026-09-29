"use client";

import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./cn";
import { menuItem, overlayMotion, overlaySurface } from "./overlay";

/**
 * A menu of actions or places. Arrow keys, typeahead and Escape come from
 * Radix. An item can be a link: `<DropdownMenuItem asChild><Link …/></DropdownMenuItem>`.
 */
export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;

export function DropdownMenuContent({ className, sideOffset = 6, align = "start", ...props }: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn(
          overlaySurface,
          overlayMotion,
          "max-h-(--radix-dropdown-menu-content-available-height) min-w-56 origin-(--radix-dropdown-menu-content-transform-origin) overflow-y-auto p-1.5",
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({ className, tone = "default", ...props }: ComponentProps<typeof DropdownMenuPrimitive.Item> & { tone?: "default" | "danger" }) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(menuItem, tone === "danger" && "text-refused before:bg-refused data-[highlighted]:bg-refused-soft data-[highlighted]:text-refused [&>svg]:text-refused", className)}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return <DropdownMenuPrimitive.Label className={cn("px-2.5 pb-1 pt-1.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-ink-3", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={cn("-mx-1.5 my-1.5 h-px bg-line", className)} {...props} />;
}

export function DropdownMenuShortcut({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("ml-auto font-mono text-[0.6875rem] tracking-wide text-ink-3", className)} {...props} />;
}
