"use client";

import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";
import { dialogMotion, dialogPanel, overlayBackdrop } from "./overlay";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export type DialogContentProps = Omit<ComponentProps<typeof DialogPrimitive.Content>, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  /** Keeps the title and description for screen readers only. */
  hideHeader?: boolean;
  showClose?: boolean;
};

/**
 * A modal panel in the middle of the screen. The title is required: it is what
 * a screen reader announces as the dialog opens.
 */
export function DialogContent({ title, description, hideHeader = false, showClose = true, className, children, ...props }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayBackdrop} />
      <DialogPrimitive.Content
        className={cn(dialogPanel, dialogMotion, "grid max-w-lg gap-5", className)}
        {...(description ? {} : { "aria-describedby": undefined })}
        {...props}
      >
        <div className={cn("space-y-1.5", showClose && "pr-10", hideHeader && "sr-only")}>
          <DialogPrimitive.Title className="text-lg font-semibold tracking-tight text-ink">{title}</DialogPrimitive.Title>
          {description && <DialogPrimitive.Description className="text-sm leading-relaxed text-ink-2">{description}</DialogPrimitive.Description>}
        </div>
        {children}
        {showClose && (
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close" className="absolute right-3 top-3">
              <X />
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}
