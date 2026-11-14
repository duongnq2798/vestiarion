"use client";

import { unstable_rethrow } from "next/navigation";
import { startTransition, useActionState, useEffect, useRef, type FormEvent } from "react";
import { AGENT_EXPECTED_EVENT } from "@/lib/agent-activity";
import { toast } from "./Toaster";

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface ActionFormOptions<State extends ActionResult = ActionResult> {
  /** Clears every field — Radix selects and checkboxes too — once the action succeeds. */
  resetOnSuccess?: boolean;
  /** Raises a toast with the result’s message once the action succeeds. */
  toastOnSuccess?: boolean;
  /** Runs once after a successful result — for a form hosted in a dialog that should close itself. */
  onSuccess?: (state: State) => void;
  /** Runs once after every result, refused or not — for a form that must let go of something a refusal was about. */
  onResult?: (state: State) => void;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Disabling the pressed button while the action runs drops keyboard focus to
 * the page. Once the result is in, put it back — on the first invalid field
 * after a refusal, otherwise on the button that was pressed or, when that is
 * gone (a confirmation dialog's), on the form's first control — unless the
 * person has already moved focus somewhere else.
 */
function restoreFocus(form: HTMLFormElement | null, submitter: HTMLElement | null, ok: boolean) {
  if (!form) return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  const invalid = ok ? null : form.querySelector<HTMLElement>('[aria-invalid="true"]');
  const target = invalid ?? (submitter?.isConnected ? submitter : form.querySelector<HTMLElement>(FOCUSABLE));
  target?.focus();
}

/**
 * What a form says when its action never answered: the connection dropped, a deploy restarted the server, or the
 * server failed (docs/superpowers/specs/2026-11-14-loading-states-design.md L6). The action may have run all the same,
 * so the person is sent to see where it stands before trying again.
 */
export const ACTION_UNANSWERED = "Vestiarion did not answer, so this may not have gone through. Check your connection, then reload the page to see where it stands before you try again.";

/**
 * The action's own result, or, when the call itself fails, a refusal saying so: the form stays as it was, with what
 * the person typed, instead of the whole section giving way to an error screen. A redirect or a not-found from the
 * action is Next's to follow, so it goes on.
 */
export async function answered<State extends ActionResult>(
  action: (previous: State, formData: FormData) => Promise<State>,
  previous: State,
  formData: FormData
): Promise<State> {
  try {
    return await action(previous, formData);
  } catch (error) {
    unstable_rethrow(error);
    console.error(error);
    return { ...previous, ok: false, message: ACTION_UNANSWERED };
  }
}

/**
 * A form wired to a server action that keeps what the person typed when the
 * action refuses it.
 *
 * React resets a form after every submission through `<form action>`,
 * whatever the action returns — so a validation error used to wipe the very
 * fields it was about. Submitting from `onSubmit` inside a transition leaves
 * the fields alone; they are cleared only on success, and only when asked.
 * The `action` prop stays: a submission made before the page hydrated is not
 * lost — React queues it and replays it through `action` once hydration
 * finishes, and only that replayed submission takes React's reset path.
 *
 * `useFormStatus` keeps working inside the form: React marks the form pending
 * for as long as the transition started in `onSubmit` runs.
 */
export function useActionForm<State extends ActionResult>(
  action: (previous: State, formData: FormData) => Promise<State>,
  initial: State,
  { resetOnSuccess = false, toastOnSuccess = false, onSuccess, onResult }: ActionFormOptions<State> = {}
) {
  const formRef = useRef<HTMLFormElement>(null);
  const submitterRef = useRef<HTMLElement | null>(null);
  // React's own types route the payload overload through `Awaited<State>`, which
  // TypeScript cannot prove equal to `State` while `State` is still this
  // function's own unresolved generic — even though `State extends ActionResult`
  // never actually settles to a Promise. Typing the call through a simpler,
  // `Awaited`-free signature sidesteps that inference dead end; the runtime
  // behaviour is exactly `useActionState`'s two-argument, payload-taking form.
  const [state, dispatch, pending] = (useActionState as <S>(action: (state: S, payload: FormData) => Promise<S>, initialState: S) => [S, (payload: FormData) => void, boolean])(
    (previous, formData) => answered(action, previous, formData),
    initial
  );
  // The result last acted on. Each submission produces a new state object, so
  // a result is reset-and-toasted once, however often the form re-renders.
  const handled = useRef(state);

  useEffect(() => {
    if (state === handled.current) return;
    handled.current = state;
    if (state.ok) {
      // Most actions give the agent something to decide within seconds: the page watches it closely for a while.
      window.dispatchEvent(new Event(AGENT_EXPECTED_EVENT));
      if (resetOnSuccess) formRef.current?.reset();
      if (toastOnSuccess && state.message) toast.success(state.message);
      onSuccess?.(state);
    }
    onResult?.(state);
    restoreFocus(formRef.current, submitterRef.current, state.ok);
  }, [state, resetOnSuccess, toastOnSuccess, onSuccess, onResult]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The pressed button's name and value belong in the submission, as they would natively.
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    submitterRef.current = submitter;
    const formData = new FormData(event.currentTarget, submitter);
    startTransition(() => dispatch(formData));
  }

  return { state, pending, formProps: { ref: formRef, action: dispatch, onSubmit } };
}
