"use client";

import { CalendarClock } from "lucide-react";
import { useState } from "react";
import { setTermRequestsAction, type TermRequestsActionResult } from "@/app/actions/term-requests";
import { DocsLink } from "@/components/DocsLink";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { TermRequestsView } from "@/lib/terms/requests";

const INITIAL: TermRequestsActionResult = { ok: false, message: "" };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const STATUS: Record<string, string> = { open: "asked for", accepted: "agreed to", declined: "declined", withdrawn: "was withdrawn from", countered: "proposed fewer days than" };

/**
 * Bills & receivables, **More time when cash is short** (docs/superpowers/specs/2026-10-17-term-requests-design.md X1):
 * an owner or admin lets the agent ask suppliers for more time on bills held for want of cash, with the most days it asks
 * for, or stops it; anyone else reads which it is. The last requests are listed.
 */
export function TermRequests({ orgSlug, view, canWrite }: { orgSlug: string; view: TermRequestsView; canWrite: boolean }) {
  const { state, formProps } = useActionForm(setTermRequestsAction, INITIAL);
  const [maxDays, setMaxDays] = useState(String(view.setting.maxDays ?? 14));
  const on = view.setting.on;
  const sandbox = view.setting.sandbox ? " In this sandbox, the requests go to the email of whoever turned them on, who answers as the supplier." : "";
  const words =
    (on
      ? `When a bill is held because the cash is not there, the agent asks the supplier by email for up to ${view.setting.maxDays ?? 0} more days, for the same amount. A supplier who agrees moves the due date, and the agent decides the bill again.`
      : "When a bill is held because the cash is not there, let the agent ask the supplier for more time, for the same amount, up to the days you set.") + sandbox;
  return (
    <section aria-labelledby="more-time-title" className="mb-6">
      <SectionHeader id="more-time-title" title="More time when cash is short" action={<DocsLink href="/docs/guides/more-time" topic="Requests for more time" />} />
      <Card className="divide-y divide-line">
        {canWrite ? (
          <form {...formProps} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <input type="hidden" name="on" value={on ? "false" : "true"} />
            <p className="min-w-0 flex-1 basis-64 text-xs text-ink-2">{words}</p>
            {!on && (
              <label className="flex items-center gap-1 text-xs text-ink-2">
                <span>Up to</span>
                <Input name="maxDays" value={maxDays} onChange={(event) => setMaxDays(event.target.value)} inputMode="numeric" className="h-8 w-16 text-right font-mono text-xs" aria-label="The most days the agent asks for" />
                <span>days</span>
              </label>
            )}
            <SubmitButton size="sm" variant="secondary" pendingLabel={on ? "Turning off…" : "Turning on…"} icon={<CalendarClock aria-hidden />}>
              {on ? "Stop the agent's requests" : "Let the agent ask for more time"}
            </SubmitButton>
            <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.message}</FormMessage>
          </form>
        ) : (
          <p className="px-4 py-3 text-xs text-ink-2 sm:px-5">{on ? words : "The agent does not ask suppliers for more time. An owner or admin turns it on."}</p>
        )}
        {view.recent.length > 0 && (
          <ul aria-label="Requests for more time" className="space-y-0.5 px-4 py-3 text-xs text-ink-2 sm:px-5">
            {view.recent.map((request) => (
              <li key={request.id}>
                {request.counterpartyName} {STATUS[request.status] ?? request.status} {request.days} more {request.days === 1 ? "day" : "days"}, to {day(request.newDueDate)}
                {request.decidedAt ? `, ${day(request.decidedAt)}` : ""}.
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
