"use client";

import { toast } from "@/components/ui/Toaster";
import type { ActionResult } from "@/components/ui/useActionForm";

/**
 * A form action that raises its success toast itself, as soon as the result
 * arrives. `useActionForm`'s `toastOnSuccess` raises it from an effect in the
 * form, but a decision that succeeds usually removes that very form — the
 * approved card leaves the inbox, the Pause button becomes Resume — in the
 * same refresh that delivers the result, so the effect never runs.
 */
export function withSuccessToast<State extends ActionResult>(action: (previous: State, formData: FormData) => Promise<State>) {
  return async (previous: State, formData: FormData): Promise<State> => {
    const result = await action(previous, formData);
    if (result.ok && result.message) toast.success(result.message);
    return result;
  };
}
