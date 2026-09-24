"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { resetDemoAction, runAgentCycleAction } from "@/app/actions/agent";

const STEPS = ["reading invoices", "screening counterparties", "checking milestones", "testing treasury economics"];
const RESET_CONFIRMATION = "RESET_DEMO_DATA";

export default function AgentControlsClient({ nextDay, headSeq }: { nextDay: number; headSeq?: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"tick" | "reset" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function refreshDashboard() {
    startTransition(() => {
      router.push(headSeq == null ? "/" : `/?since=${headSeq}`);
      router.refresh();
    });
  }

  async function runCycle() {
    setBusy("tick");
    setMessage(null);
    try {
      const result = await runAgentCycleAction();
      setMessage(result.ok ? result.message : `Cycle failed: ${result.message}`);
      if (result.ok) refreshDashboard();
    } catch (error) {
      setMessage(`Cycle failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function resetDemo() {
    if (!window.confirm("Reset all demo data? The audit chain will start again from genesis.")) return;
    setBusy("reset");
    setMessage(null);
    try {
      const result = await resetDemoAction(RESET_CONFIRMATION);
      setMessage(result.message);
      if (result.ok) {
        startTransition(() => {
          router.push("/");
          router.refresh();
        });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The demo could not be reset.");
    } finally {
      setBusy(null);
    }
  }

  const running = busy === "tick" || pending;
  const failed = message?.toLowerCase().includes("fail") || message?.includes("expired") || message?.includes("disabled");

  return (
    <div className="flex max-w-xl flex-col items-stretch gap-2 sm:items-end">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={runCycle}
          className="relative inline-flex h-10 items-center justify-center gap-2 overflow-hidden rounded-md bg-agent px-4 text-sm font-semibold text-on-agent hover:bg-agent/90 disabled:cursor-progress disabled:opacity-70"
        >
          <span aria-hidden>▶</span>
          {running ? `Running day ${nextDay}…` : `Run day ${nextDay}`}
          {running && <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-on-agent/20"><span className="block h-full w-2/5 bg-on-agent motion-safe:animate-sweep" /></span>}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={resetDemo}
          className="h-10 rounded-md border border-line-strong px-3 text-xs font-medium text-ink-2 hover:bg-raised hover:text-ink disabled:opacity-60"
        >
          {busy === "reset" ? "Resetting…" : "Reset demo"}
        </button>
      </div>
      <p aria-live="polite" className={`min-h-4 text-xs ${failed ? "text-refused" : "text-ink-2"}`}>
        {running ? `Agent is ${STEPS.join(" · ")}.` : message}
      </p>
    </div>
  );
}
