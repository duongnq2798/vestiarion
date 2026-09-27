"use client";

import { useActionState } from "react";
import { signInWithEmail, type LoginState } from "@/app/login/actions";

const INITIAL: LoginState = { ok: false, message: "" };

export default function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signInWithEmail, INITIAL);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next} />
      <label className="block text-sm font-medium text-ink" htmlFor="email">Work email</label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        className="w-full rounded-md border border-line bg-ground px-3 py-2 text-sm text-ink"
      />
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-ink px-3.5 py-2 text-sm font-medium text-ground disabled:opacity-70"
      >
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
      {state.message && (
        <p aria-live="polite" className={state.ok ? "text-sm text-proof" : "text-sm text-refused"}>{state.message}</p>
      )}
    </form>
  );
}
