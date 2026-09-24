"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { runAgentCycleAction } from "@/app/actions/agent";
import type { CycleClockMode } from "@/lib/clock";

const STEPS = ["reading invoices", "screening counterparties", "checking milestones", "testing treasury economics"];

export default function AgentControlsClient({ nextDay, headSeq, clockMode }: { nextDay: number; headSeq?: number; clockMode: CycleClockMode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function refreshDashboard() {
    startTransition(() => {
      router.push(headSeq == null ? "/console" : `/console?since=${headSeq}`);
      router.refresh();
    });
  }

  async function runCycle() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await runAgentCycleAction();
      setMessage(result.ok ? result.message : `Cycle failed: ${result.message}`);
      if (result.ok) refreshDashboard();
    } catch (error) {
      setMessage(`Cycle failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setBusy(false);
    }
  }

  const running = busy || pending;
  const runLabel = clockMode === "simulate" ? `day ${nextDay}` : "cycle";
  const failed = message?.toLowerCase().includes("fail") || message?.includes("expired") || message?.includes("disabled");

  return (
    <div className="flex max-w-xl flex-col items-stretch gap-2 sm:items-end">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={runCycle}
          className="relative inline-flex h-10 items-center justify-center gap-2 overflow-hidden rounded-md bg-agent px-4 text-sm font-semibold text-on-agent hover:bg-agent/90 disabled:cursor-progress disabled:opacity-70"
        >
          <span aria-hidden>▶</span>
          {running ? `Running ${runLabel}…` : clockMode === "simulate" ? `Run day ${nextDay}` : "Run cycle now"}
          {running && <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-on-agent/20"><span className="block h-full w-2/5 bg-on-agent motion-safe:animate-sweep" /></span>}
        </button>
      </div>
      <p aria-live="polite" className={`min-h-4 text-xs ${failed ? "text-refused" : "text-ink-2"}`}>
        {running ? `Agent is ${STEPS.join(" · ")}.` : message}
      </p>
    </div>
  );
}
