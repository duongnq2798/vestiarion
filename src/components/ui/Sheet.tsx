"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";
import { overlayBackdrop } from "./overlay";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const sheetVariants = cva(
  [
    "fixed z-50 flex flex-col bg-surface text-ink shadow-overlay outline-hidden",
    "data-[state=open]:animate-in data-[state=closed]:animate-out duration-300 ease-emphasized data-[state=closed]:duration-200 data-[state=closed]:ease-exit",
  ],
  {
    variants: {
      side: {
        left: "inset-y-0 left-0 h-dvh w-[min(20rem,calc(100vw-3.5rem))] border-r border-line data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
        right: "inset-y-0 right-0 h-dvh w-[min(24rem,calc(100vw-3.5rem))] border-l border-line data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
        top: "inset-x-0 top-0 max-h-[85dvh] border-b border-line data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top",
        bottom: "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t border-line data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
      },
    },
    defaultVariants: { side: "right" },
  }
);

export type SheetContentProps = Omit<ComponentProps<typeof DialogPrimitive.Content>, "title"> &
  VariantProps<typeof sheetVariants> & {
    title: ReactNode;
    description?: ReactNode;
    /** Keeps the title and description for screen readers only. */
    hideHeader?: boolean;
    showClose?: boolean;
  };

/**
 * A panel that slides in from an edge, over a dimmed page: the navigation
 * drawer, the landing menu. Radix traps focus inside, closes it on Escape or a
 * click outside, and returns focus to whatever opened it.
 */
export function SheetContent({ side, title, description, hideHeader = false, showClose = true, className, children, ...props }: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-overlay-backdrop="" className={overlayBackdrop} />
      <DialogPrimitive.Content className={cn(sheetVariants({ side }), className)} {...(description ? {} : { "aria-describedby": undefined })} {...props}>
        <div className={cn("shrink-0 space-y-1 border-b border-line px-5 py-4", showClose && "pr-14", hideHeader && "sr-only")}>
          <DialogPrimitive.Title className="text-base font-semibold tracking-tight text-ink">{title}</DialogPrimitive.Title>
          {description && <DialogPrimitive.Description className="text-sm text-ink-2">{description}</DialogPrimitive.Description>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {showClose && (
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon" aria-label="Close" className="absolute right-2 top-2.5">
              <X />
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
