"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./Button";

/**
 * Whether the submission in `data` was sent by the button with this `name`
 * and `value`, following how a form actually submits it: a button without a
 * name cannot be told apart, so it counts as the sender of any submission;
 * a named button with no `value` submits the empty string, so it is the
 * sender only when `data` holds `name=""`.
 */
export function submittedBy(data: FormData | null, name: string | undefined, value: ButtonProps["value"]): boolean {
  if (!data) return false;
  if (name == null) return true;
  return data.get(name) === String(value ?? "");
}

export type SubmitButtonProps = Omit<ButtonProps, "type" | "asChild"> & {
  /** Replaces the label while this button’s submission runs: “Saving…”. */
  pendingLabel?: string;
};

/**
 * A form’s submit button. It learns from the form itself when a submission is
 * running — no `pending` prop to thread through. Of several submit buttons,
 * only the one pressed shows it; all of them stop taking clicks.
 */
export function SubmitButton({ pendingLabel, loading = false, disabled, name, value, children, ...props }: SubmitButtonProps) {
  const { pending, data } = useFormStatus();
  const busy = loading || (pending && submittedBy(data, name, value));
  return (
    <Button type="submit" name={name} value={value} loading={busy} disabled={disabled || pending} {...props}>
      {busy && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
