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
      {/* 16px below `sm`: iOS zooms the page into any smaller field it focuses. */}
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        className="h-11 w-full rounded-xl border border-line-strong bg-ground px-3 text-base text-ink outline-none focus:border-agent focus:ring-2 focus:ring-agent-soft sm:text-sm"
      />
      <button
        type="submit"
        disabled={pending}
        className="brand-shadow h-11 w-full rounded-xl bg-agent px-3.5 text-sm font-semibold text-on-agent transition-transform hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-70"
      >
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
      {state.message && (
        <p aria-live="polite" className={state.ok ? "text-sm text-proof" : "text-sm text-refused"}>{state.message}</p>
      )}
    </form>
  );
}
