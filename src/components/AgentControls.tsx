"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export default function AgentControls() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [busy, setBusy] = useState<"tick" | "reset" | null>(null);

  async function runCycle() {
    setBusy("tick");
    setLastResult(null);
    try {
      const res = await fetch("/api/agent/tick", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Agent cycle failed");
      setLastResult(`Day ${data.day}: ${data.lines.length} decisions logged.`);
      startTransition(() => router.refresh());
    } catch (err) {
      setLastResult(`Error: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("reset");
    setLastResult(null);
    try {
      await fetch("/api/agent/reset", { method: "POST" });
      setLastResult("Demo data reset to day 0.");
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={runCycle}
        disabled={busy !== null}
        className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 transition-opacity hover:bg-emerald-400 disabled:opacity-50"
      >
        {busy === "tick" || isPending ? "Running agent…" : "Run Agent Cycle"}
      </button>
      <button
        onClick={reset}
        disabled={busy !== null}
        className="rounded-md border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-900 disabled:opacity-50"
      >
        {busy === "reset" ? "Resetting…" : "Reset Demo Data"}
      </button>
      {lastResult && <span className="text-sm text-neutral-400">{lastResult}</span>}
    </div>
  );
}
