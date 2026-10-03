"use client";

import { Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { runAgentCycleAction } from "@/app/actions/agent";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { toast } from "@/components/ui/Toaster";
import { AGENT_EXPECTED_EVENT } from "@/lib/agent-activity";
import { orgHref } from "@/lib/auth/org-paths";
import type { CycleClockMode } from "@/lib/clock";

const STEPS = ["reading invoices", "screening counterparties", "checking milestones", "testing treasury economics"];

/**
 * The page head's agent actions: whatever the page puts first (`leading` — the
 * treasury page's pause switch), then Run, in one row. Progress and the result
 * sit beneath that row, so a long status line never pushes the buttons apart.
 * A finished cycle is announced by a toast; a failed one stays here, in words.
 */
export default function AgentControlsClient({
  orgSlug,
  nextDay,
  headSeq,
  clockMode,
  paused = false,
  leading,
}: {
  orgSlug: string;
  nextDay: number;
  headSeq?: number;
  clockMode: CycleClockMode;
  paused?: boolean;
  leading?: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refreshDashboard() {
    startTransition(() => {
      router.push(headSeq == null ? orgHref(orgSlug, "/console") : orgHref(orgSlug, `/console?since=${headSeq}`));
      router.refresh();
    });
  }

  async function runCycle() {
    setBusy(true);
    setError(null);
    window.dispatchEvent(new Event(AGENT_EXPECTED_EVENT));
    try {
      const result = await runAgentCycleAction(orgSlug);
      if (result.ok) {
        toast.success(result.message);
        refreshDashboard();
      } else {
        setError(`Cycle failed: ${result.message}`);
      }
    } catch (caught) {
      setError(`Cycle failed: ${caught instanceof Error ? caught.message : "Unknown error"}`);
    } finally {
      setBusy(false);
    }
  }

  const running = busy || pending;
  const runLabel = clockMode === "simulate" ? `day ${nextDay}` : "cycle";
  const status = running ? `Agent is ${STEPS.join(" · ")}.` : (error ?? (paused ? "The agent is paused. Resume it to run a cycle." : null));

  return (
    <div className="flex flex-col items-stretch gap-2 sm:items-end">
      <div className="flex flex-wrap items-start gap-2 sm:justify-end">
        {leading}
        <Button icon={<Play />} loading={running} disabled={paused} onClick={runCycle}>
          {running ? `Running ${runLabel}…` : clockMode === "simulate" ? `Run day ${nextDay}` : "Run cycle now"}
        </Button>
      </div>
      {running && <ProgressBar label={`Running ${runLabel}`} className="sm:w-56" />}
      <p aria-live="polite" className={cn("min-h-4 max-w-sm text-xs leading-relaxed sm:text-right", error ? "text-refused" : "text-ink-2")}>
        {status}
      </p>
    </div>
  );
}
