"use client";

import { CalendarCheck, MessageSquareReply, X } from "lucide-react";
import { useState } from "react";
import { counterTermRequestAction, decideTermRequestAction, type TermDecisionResult } from "@/app/more-time/[token]/actions";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { termRequestLine } from "@/lib/terms/words";

const INITIAL: TermDecisionResult = { ok: false, message: "" };

export interface TermRequestShown {
  orgName: string;
  counterpartyName: string;
  reference: string | null;
  amount: number;
  currency: string;
  dueDate: string;
  newDueDate: string;
  days: number;
  expiresAt: string;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * The supplier's page of a request for more time (docs/superpowers/specs/2026-10-17-term-requests-design.md X4): who asks,
 * for which invoice, the new date and the full amount, and Agree or Decline. The supplier may also propose fewer days, which
 * the agent answers by email (docs/superpowers/specs/2026-10-17-term-requests-follow-up-design.md F5). One answer, then
 * the page says what happens.
 */
export function TermDecision({ token, request }: { token: string; request: TermRequestShown }) {
  const { state, formProps } = useActionForm(decideTermRequestAction, INITIAL);
  const counter = useActionForm(counterTermRequestAction, INITIAL);
  const [days, setDays] = useState(String(Math.max(1, Math.floor(request.days / 2))));
  const answered = state.ok ? state : counter.state.ok ? counter.state : null;
  return (
    <Card className="space-y-5 p-6">
      <div className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-wide text-ink-3">Payment terms</p>
        <h1 className="text-xl font-semibold text-ink [text-wrap:balance]">{termRequestLine(request)}</h1>
        <p className="text-sm text-ink-2">
          Nothing else changes: the same amount, to where {request.orgName} already pays {request.counterpartyName}. The request stands until {day(request.expiresAt)}. If
          you decline, the invoice stays due on {day(request.dueDate)}.
        </p>
      </div>
      {answered ? (
        <p role="status" className="text-sm text-ink">
          {answered.message}
        </p>
      ) : (
        <div className="space-y-4">
          <form {...formProps} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="token" value={token} />
            <SubmitButton name="decision" value="accept" pendingLabel="Agreeing…" icon={<CalendarCheck aria-hidden />}>
              Agree to the new date
            </SubmitButton>
            <SubmitButton name="decision" value="decline" variant="secondary" pendingLabel="Declining…" icon={<X aria-hidden />}>
              Decline
            </SubmitButton>
            <FormMessage tone={state.message ? "error" : "neutral"}>{state.message}</FormMessage>
          </form>
          {request.days > 1 && (
            <form {...counter.formProps} className="space-y-2 border-t border-line pt-4">
              <input type="hidden" name="token" value={token} />
              <p className="text-sm text-ink-2">Would fewer days work for you? Propose how many, and {request.orgName} answers you by email.</p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-sm text-ink-2">
                  <Input
                    name="days"
                    value={days}
                    onChange={(event) => setDays(event.target.value)}
                    inputMode="numeric"
                    className="h-9 w-20 text-right font-mono text-sm"
                    aria-label={`The days you propose instead of ${request.days}`}
                  />
                  <span>days</span>
                </label>
                <SubmitButton variant="secondary" pendingLabel="Sending…" icon={<MessageSquareReply aria-hidden />}>
                  Propose fewer days
                </SubmitButton>
              </div>
              <FormMessage tone={counter.state.message ? "error" : "neutral"}>{counter.state.message}</FormMessage>
            </form>
          )}
        </div>
      )}
    </Card>
  );
}
