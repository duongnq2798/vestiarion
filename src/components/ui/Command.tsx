"use client";

import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { Dialog, DialogContent } from "./Dialog";
import { Kbd } from "./Kbd";
import { menuItemBase } from "./overlay";

/** A filterable list driven by the keyboard, from cmdk. */
export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive className={cn("flex w-full flex-col overflow-hidden text-ink", className)} {...props} />;
}

/**
 * The command palette: a dialog near the top of the screen with a search field
 * and a list beneath it. Escape or a click outside closes it.
 */
export function CommandDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={description}
        hideHeader
        showClose={false}
        className="top-[12dvh] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 sm:top-[18dvh] sm:p-0"
        bodyClassName="m-0 p-0 overflow-visible"
      >
        <Command label={title} loop>
          {children}
        </Command>
        <div className="hidden items-center gap-3 border-t border-line bg-ground/60 px-4 py-2 text-[0.6875rem] text-ink-3 sm:flex">
          <span className="inline-flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> to move
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>↵</Kbd> to open
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>esc</Kbd> to close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4">
      <Search aria-hidden className="size-4 shrink-0 text-ink-3" />
      <CommandPrimitive.Input className={cn("h-13 min-w-0 flex-1 bg-transparent text-base text-ink outline-hidden placeholder:text-ink-3 sm:text-sm", className)} {...props} />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List className={cn("max-h-[min(22rem,60dvh)] scroll-py-1.5 overflow-y-auto overscroll-contain p-1.5", className)} {...props} />;
}

export function CommandEmpty({ className, ...props }: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className={cn("px-4 py-10 text-center text-sm text-ink-3", className)} {...props} />;
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[0.625rem] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-ink-3",
        className
      )}
      {...props}
    />
  );
}

/** cmdk marks the row under the pointer or the arrow keys `data-selected`. */
export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        menuItemBase,
        "data-[selected=true]:bg-raised/70 data-[selected=true]:text-ink data-[selected=true]:before:opacity-100 data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className
      )}
      {...props}
    />
  );
}

export function CommandSeparator({ className, ...props }: ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn("-mx-1.5 my-1.5 h-px bg-line", className)} {...props} />;
}

export function CommandShortcut({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("ml-auto font-mono text-[0.6875rem] tracking-wide text-ink-3", className)} {...props} />;
}
