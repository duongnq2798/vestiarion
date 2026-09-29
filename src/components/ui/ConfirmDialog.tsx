"use client";

import { TriangleAlert } from "lucide-react";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";
import { dialogMotion, dialogPanel, overlayBackdrop } from "./overlay";

export interface ConfirmDialogProps {
  /** The control that opens the dialog — usually a Button. */
  trigger: ReactElement;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  /**
   * The id of the form the confirm button submits. The dialog is rendered
   * outside that form, so the button names it with the `form` attribute.
   */
  formId?: string;
  /** For a confirmation that is not a form submission. */
  onConfirm?: () => void;
}

/**
 * Asks before something that cannot be taken back. A click outside does not
 * close it — the person chooses. Confirming closes it at once; the control
 * that opened it shows the work in progress.
 */
export function ConfirmDialog({ trigger, title, description, confirmLabel, cancelLabel = "Cancel", tone = "danger", formId, onConfirm }: ConfirmDialogProps) {
  const danger = tone === "danger";
  return (
    <AlertDialogPrimitive.Root>
      <AlertDialogPrimitive.Trigger asChild>{trigger}</AlertDialogPrimitive.Trigger>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay data-overlay-backdrop="" className={overlayBackdrop} />
        <AlertDialogPrimitive.Content className={cn(dialogPanel, dialogMotion, "max-w-md")}>
          <div className="flex gap-4">
            {danger && (
              <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-refused-soft text-refused">
                <TriangleAlert className="size-5" />
              </span>
            )}
            <div className="min-w-0 space-y-1.5">
              <AlertDialogPrimitive.Title className="text-base font-semibold text-ink">{title}</AlertDialogPrimitive.Title>
              <AlertDialogPrimitive.Description className="text-sm leading-relaxed text-ink-2">{description}</AlertDialogPrimitive.Description>
            </div>
          </div>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="secondary">{cancelLabel}</Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button type={formId ? "submit" : "button"} form={formId} variant={danger ? "danger-solid" : "primary"} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
