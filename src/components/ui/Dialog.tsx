"use client";

import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useRef, type ComponentProps, type ReactNode } from "react";
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
  /** Classes for the scrolling body that holds `children`. */
  bodyClassName?: string;
};

/**
 * A modal panel in the middle of the screen. The title is required: it is what
 * a screen reader announces as the dialog opens.
 *
 * Closing returns focus to whatever held it when the dialog opened. Radix
 * alone returns it to the dialog's Trigger, and a dialog opened another way —
 * a keyboard shortcut, a button elsewhere — has none.
 */
export function DialogContent({
  title,
  description,
  hideHeader = false,
  showClose = true,
  className,
  bodyClassName,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: DialogContentProps) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-overlay-backdrop="" className={overlayBackdrop} />
      <DialogPrimitive.Content
        className={cn(dialogPanel, dialogMotion, "flex max-w-lg flex-col gap-5 overflow-hidden", className)}
        {...(description ? {} : { "aria-describedby": undefined })}
        onOpenAutoFocus={(event) => {
          const active = document.activeElement;
          returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          const target = returnFocus.current;
          returnFocus.current = null;
          if (event.defaultPrevented || !target?.isConnected) return;
          event.preventDefault();
          target.focus({ preventScroll: true });
        }}
        {...props}
      >
        <div className={cn("shrink-0 space-y-1.5", showClose && "pr-10", hideHeader && "sr-only")}>
          <DialogPrimitive.Title className="text-lg font-semibold tracking-tight text-ink">{title}</DialogPrimitive.Title>
          {description && <DialogPrimitive.Description className="text-sm leading-relaxed text-ink-2">{description}</DialogPrimitive.Description>}
        </div>
        <div className={cn("-m-1.5 min-h-0 flex-1 overflow-y-auto p-1.5", bodyClassName)}>{children}</div>
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
