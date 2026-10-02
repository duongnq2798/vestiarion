"use client";

import { Gauge } from "lucide-react";
import { useCallback, useState } from "react";
import { setAgentBudgetAction } from "@/app/actions/agent";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";
import { fmt, Money } from "@/components/vx/Primitives";
import { withSuccessToast } from "@/components/withSuccessToast";

const INITIAL: ActionResult = { ok: false, message: "" };
const save = withSuccessToast(setAgentBudgetAction);

/** What the console knows of the agent's spending limit: plain numbers, nothing secret. */
export interface AgentBudgetView {
  dailyUsdc: number | null;
  weeklyUsdc: number | null;
  spentToday: number;
  spentThisWeek: number;
  /** What the limit leaves now; null with no figure set. */
  remaining: number | null;
}

/**
 * The agent's spending limit on the console (docs/superpowers/specs/2026-10-02-outflow-budget-design.md
 * §4): what the agent paid on its own today and in the last 7 days, against each figure that is set,
 * and what is left. An owner or admin changes it from here.
 */
export function AgentBudgetPanel({ orgSlug, view, canEdit }: { orgSlug: string; view: AgentBudgetView; canEdit: boolean }) {
  const unset = view.dailyUsdc === null && view.weeklyUsdc === null;
  return (
    <Card asChild>
      <section aria-labelledby="agent-budget">
        <CardContent className="p-4 sm:p-5">
          <SectionHeader title="Agent spending limit" meta="what it pays on its own" />
          {unset ? (
            <p id="agent-budget" className="text-sm leading-6 text-ink-2">
              No limit set. The agent pays anything within each counterparty&apos;s own limit.
            </p>
          ) : (
            <p id="agent-budget" className={cn("text-2xl font-semibold tracking-[-0.02em]", view.remaining === 0 ? "text-held" : "text-ink")}>
              <Money value={view.remaining ?? 0} /> <span className="text-sm font-normal text-ink-2">left</span>
            </p>
          )}
          <dl className="mt-3 space-y-3 text-[0.8125rem]">
            <Usage label="Today (UTC)" spent={view.spentToday} limit={view.dailyUsdc} />
            <Usage label="Last 7 days" spent={view.spentThisWeek} limit={view.weeklyUsdc} />
          </dl>
          <p className="mt-3 text-xs leading-5 text-ink-3">
            {unset
              ? "Set a daily or 7-day figure, and a payment past it waits for you in Approvals."
              : "A payment past it waits for you in Approvals. What a person approves does not count."}
          </p>
          {canEdit && <BudgetDialog orgSlug={orgSlug} view={view} unset={unset} />}
        </CardContent>
      </section>
    </Card>
  );
}

function Usage({ label, spent, limit }: { label: string; spent: number; limit: number | null }) {
  const share = limit === null ? 0 : Math.min(1, spent / limit);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="min-w-0 text-ink-2">{label}</dt>
        <dd className="shrink-0 text-ink">
          {limit === null ? (
            <>
              <Money value={spent} />
              <span className="text-ink-3"> · no limit</span>
            </>
          ) : (
            <>
              <span className="tabular-nums">{fmt(spent)}</span>
              <span className="text-ink-3"> of </span>
              <Money value={limit} />
            </>
          )}
        </dd>
      </div>
      {limit !== null && (
        <div
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-agent-soft"
          role="meter"
          aria-label={`${label}: ${spent} of ${limit} USDC`}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(spent, limit)}
        >
          <div className={cn("h-full rounded-full", share >= 1 ? "bg-held" : "bg-agent")} style={{ width: `${share * 100}%` }} />
        </div>
      )}
    </div>
  );
}

function BudgetDialog({ orgSlug, view, unset }: { orgSlug: string; view: AgentBudgetView; unset: boolean }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { state, formProps } = useActionForm(save, INITIAL, { onSuccess: close });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm" icon={<Gauge />} className="mt-4">
          {unset ? "Set limit" : "Change limit"}
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Agent spending limit"
        description="What the agent may pay on its own, in USDC, counted from 00:00 UTC. A payment past either figure is held for a person in Approvals; one a person approves does not count. Leave a figure blank for no limit."
      >
        <form {...formProps} className="grid gap-5">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <Field id="budget-daily" label="Per day (USDC)" optional>
            <Input name="daily" inputMode="decimal" placeholder="No daily limit" defaultValue={view.dailyUsdc ?? ""} />
          </Field>
          <Field id="budget-weekly" label="Per 7 days (USDC)" optional description="Today and the six days before it. At least the daily figure.">
            <Input name="weekly" inputMode="decimal" placeholder="No 7-day limit" defaultValue={view.weeklyUsdc ?? ""} />
          </Field>
          <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <SubmitButton pendingLabel="Saving…">Save limit</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
