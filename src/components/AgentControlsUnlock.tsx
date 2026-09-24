"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { type AgentActionResult, unlockAgentControls } from "@/app/actions/agent";

const INITIAL: AgentActionResult = { ok: false, message: "" };

export default function AgentControlsUnlock() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(unlockAgentControls, INITIAL);

  useEffect(() => {
    if (!state.ok) return;
    formRef.current?.reset();
    router.refresh();
  }, [router, state.ok]);

  return (
    <form ref={formRef} action={action} className="flex max-w-sm flex-col items-stretch gap-2 sm:items-end">
      <div className="flex gap-2">
        <label className="sr-only" htmlFor="agent-token">Agent control token</label>
        <input
          id="agent-token"
          name="agentToken"
          type="password"
          required
          autoComplete="current-password"
          placeholder="Control token"
          className="h-10 min-w-0 rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink shadow-sm outline-none focus:border-agent"
        />
        <button
          type="submit"
          disabled={pending}
          className="brand-shadow h-10 shrink-0 rounded-xl bg-agent px-4 text-sm font-semibold text-on-agent transition-transform hover:-translate-y-0.5 disabled:opacity-60"
        >
          {pending ? "Checking…" : "Unlock controls"}
        </button>
      </div>
      <p aria-live="polite" className={`min-h-4 text-xs ${state.message && !state.ok ? "text-refused" : "text-ink-2"}`}>
        {state.message || "Mutating controls require the server-side AGENT_API_TOKEN."}
      </p>
    </form>
  );
}
