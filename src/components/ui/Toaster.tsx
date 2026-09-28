"use client";

import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import { Toaster as Sonner } from "sonner";
import { Spinner } from "./Spinner";

export { toast } from "sonner";

/**
 * Where confirmations appear: bottom right, full width on a phone. Toasts
 * confirm what went right; an action’s error stays in the form that caused it.
 */
export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      gap={10}
      offset={20}
      mobileOffset={12}
      containerAriaLabel="Notifications"
      icons={{
        success: <CircleCheck className="size-[1.125rem] text-proof" />,
        error: <CircleX className="size-[1.125rem] text-refused" />,
        info: <Info className="size-[1.125rem] text-agent" />,
        warning: <TriangleAlert className="size-[1.125rem] text-held" />,
        loading: <Spinner className="size-[1.125rem] text-agent" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "flex w-(--width) items-start gap-3 rounded-xl border border-line bg-surface p-4 font-sans text-sm text-ink shadow-overlay",
          content: "min-w-0 flex-1",
          title: "font-semibold leading-5 text-ink",
          description: "mt-0.5 leading-5 text-ink-2",
          icon: "mt-px flex size-5 shrink-0 items-center justify-center",
          actionButton: "ml-auto h-8 shrink-0 cursor-pointer rounded-lg bg-agent px-3 text-xs font-semibold text-on-agent transition-colors duration-150 ease-standard hover:bg-agent/90",
          cancelButton: "h-8 shrink-0 cursor-pointer rounded-lg px-3 text-xs font-medium text-ink-2 transition-colors duration-150 ease-standard hover:bg-raised",
        },
      }}
    />
  );
}
