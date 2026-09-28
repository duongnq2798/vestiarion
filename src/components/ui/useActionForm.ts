"use client";

import { startTransition, useActionState, useEffect, useRef, type FormEvent } from "react";
import { toast } from "sonner";

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface ActionFormOptions {
  /** Clears every field — Radix selects and checkboxes too — once the action succeeds. */
  resetOnSuccess?: boolean;
  /** Raises a toast with the result’s message once the action succeeds. */
  toastOnSuccess?: boolean;
}

/**
 * A form wired to a server action that keeps what the person typed when the
 * action refuses it.
 *
 * React resets a form after every submission through `<form action>`,
 * whatever the action returns — so a validation error used to wipe the very
 * fields it was about. Submitting from `onSubmit` inside a transition leaves
 * the fields alone; they are cleared only on success, and only when asked.
 * The `action` prop stays, so React still refuses a submission made before
 * the page hydrated instead of posting it to the page.
 *
 * `useFormStatus` keeps working inside the form: React marks the form pending
 * for as long as the transition started in `onSubmit` runs.
 */
export function useActionForm<State extends ActionResult>(
  action: (previous: State, formData: FormData) => Promise<State>,
  initial: State,
  { resetOnSuccess = false, toastOnSuccess = false }: ActionFormOptions = {}
) {
  const formRef = useRef<HTMLFormElement>(null);
  // React's own types route the payload overload through `Awaited<State>`, which
  // TypeScript cannot prove equal to `State` while `State` is still this
  // function's own unresolved generic — even though `State extends ActionResult`
  // never actually settles to a Promise. Typing the call through a simpler,
  // `Awaited`-free signature sidesteps that inference dead end; the runtime
  // behaviour is exactly `useActionState`'s two-argument, payload-taking form.
  const [state, dispatch, pending] = (useActionState as <S>(action: (state: S, payload: FormData) => Promise<S>, initialState: S) => [S, (payload: FormData) => void, boolean])(
    action,
    initial
  );
  // The result last acted on. Each submission produces a new state object, so
  // a result is reset-and-toasted once, however often the form re-renders.
  const handled = useRef(state);

  useEffect(() => {
    if (state === handled.current) return;
    handled.current = state;
    if (!state.ok) return;
    if (resetOnSuccess) formRef.current?.reset();
    if (toastOnSuccess && state.message) toast.success(state.message);
  }, [state, resetOnSuccess, toastOnSuccess]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The pressed button's name and value belong in the submission, as they would natively.
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const formData = new FormData(event.currentTarget, submitter);
    startTransition(() => dispatch(formData));
  }

  return { state, pending, formProps: { ref: formRef, action: dispatch, onSubmit } };
}
