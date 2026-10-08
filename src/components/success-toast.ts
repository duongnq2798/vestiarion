"use client";

import { toast } from "@/components/ui/Toaster";

/**
 * A decision's confirmation: the action's own words, and for a payment its transaction on the explorer, one click away
 * and on screen long enough to reach it.
 */
export function successToast(message: string, txUrl?: string | null): void {
  if (!txUrl) {
    toast.success(message);
    return;
  }
  toast.success(message, {
    duration: 10_000,
    action: { label: "View transaction", onClick: () => window.open(txUrl, "_blank", "noopener,noreferrer") },
  });
}
