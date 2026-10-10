"use client";

import { History } from "lucide-react";
import Link from "next/link";
import { useCallback, useState, useTransition } from "react";
import { tryRuleAction, type TryRuleResult } from "@/app/actions/policy-replay";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { FormMessage } from "@/components/ui/FormMessage";
import { Money } from "@/components/vx/Primitives";
import { orgHref } from "@/lib/auth/org-paths";
import { RULE_TRIAL_COPY } from "@/lib/rule-trial-copy";
import type { ReplayCounts, RuleKind } from "@/lib/policy-replay";
import type { RuleReplayRow, RuleReplayView } from "@/lib/policy-replay-read";

/**
 * Try it on past decisions (docs/superpowers/specs/2026-10-10-policy-replay-design.md §2): inside a setting's own form,
 * the window, the button that replays the code's checks with the figure typed in, and the result. While a result is
 * shown, the form carries what Apply this figure posts back to the setting's action: the window, and the figure in force
 * when the replay ran (P10). A form changes nothing until it is submitted, so editing the figure clears the result.
 */

const WINDOWS = [30, 90] as const;

type TryRule = (formData: FormData) => Promise<TryRuleResult>;

/** A trial's state, kept by the form it sits in. */
export function useRuleTrial(rule: RuleKind, tryRule: TryRule = tryRuleAction) {
  const [view, setView] = useState<RuleReplayView | null>(null);
  const [message, setMessage] = useState("");
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [pending, startTransition] = useTransition();

  const clear = useCallback(() => {
    setView(null);
    setMessage("");
  }, []);

  const run = useCallback(
    (form: HTMLFormElement | null) => {
      if (!form) return;
      const data = new FormData(form);
      data.set("rule", rule);
      data.set("days", String(days));
      startTransition(async () => {
        // A request that never answers (a network drop, a deploy) is said in the form, never thrown at the page.
        const result = await tryRule(data).catch((): TryRuleResult => ({ ok: false, message: "That did not work. Try again in a moment." }));
        setView(result.ok ? result.view : null);
        setMessage(result.ok ? "" : result.message);
      });
    },
    [rule, days, tryRule]
  );

  const pickDays = useCallback(
    (next: (typeof WINDOWS)[number]) => {
      setDays(next);
      clear();
    },
    [clear]
  );

  return { view, message, days, pending, run, clear, pickDays };
}

export type RuleTrialState = ReturnType<typeof useRuleTrial>;

/** The fields Apply this figure posts with the form: the window, and the figure in force when the replay ran. */
export function RuleTrialFields({ view }: { view: RuleReplayView | null }) {
  if (!view) return null;
  return (
    <>
      {Object.entries(view.apply).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/** The window and the button, then the result: placed inside the setting's form, so the button reads its figure. */
export function RuleTrial({ orgSlug, trial, className }: { orgSlug: string; trial: RuleTrialState; className?: string }) {
  return (
    <RuleTrialPanel
      orgSlug={orgSlug}
      days={trial.days}
      pending={trial.pending}
      message={trial.message}
      view={trial.view}
      onPickDays={trial.pickDays}
      onRun={trial.run}
      className={className}
    />
  );
}

/** What `RuleTrial` shows, from plain props: a guide's screenshot renders it with a result and no handlers. */
export function RuleTrialPanel({
  orgSlug,
  days: picked,
  pending = false,
  message = "",
  view,
  onPickDays,
  onRun,
  className,
}: {
  orgSlug: string;
  days: (typeof WINDOWS)[number];
  pending?: boolean;
  message?: string;
  view: RuleReplayView | null;
  onPickDays?: (days: (typeof WINDOWS)[number]) => void;
  onRun?: (form: HTMLFormElement | null) => void;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-3 rounded-xl border border-line bg-raised/40 p-3", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="group" aria-label={RULE_TRIAL_COPY.window} className="flex items-center gap-1">
          <span className="mr-1 text-xs text-ink-2">{RULE_TRIAL_COPY.window}</span>
          {WINDOWS.map((days) => (
            <Button
              key={days}
              type="button"
              size="sm"
              variant={picked === days ? "primary" : "ghost"}
              aria-pressed={picked === days}
              onClick={() => onPickDays?.(days)}
            >
              Last {days} days
            </Button>
          ))}
        </div>
        <Button type="button" variant="secondary" size="sm" icon={<History />} loading={pending} onClick={(event) => onRun?.(event.currentTarget.form)}>
          {RULE_TRIAL_COPY.button}
        </Button>
      </div>
      <FormMessage tone="error" className={message ? undefined : "min-h-0"}>
        {message || null}
      </FormMessage>
      {view && <RuleTrialResult orgSlug={orgSlug} view={view} />}
      <RuleTrialFields view={view} />
    </div>
  );
}

const CHANGE: Record<RuleReplayRow["change"], { label: string; tone: "held" | "agent" | "neutral" }> = {
  now_held: { label: RULE_TRIAL_COPY.nowHeld, tone: "held" },
  now_two_people: { label: RULE_TRIAL_COPY.nowTwoPeople, tone: "held" },
  now_paid: { label: RULE_TRIAL_COPY.nowPaid, tone: "agent" },
  cant_tell: { label: RULE_TRIAL_COPY.cantTell, tone: "neutral" },
};

const COUNTS: Array<[keyof Omit<ReplayCounts, "decisions">, string]> = [
  ["unchanged", RULE_TRIAL_COPY.unchanged],
  ["nowHeld", RULE_TRIAL_COPY.nowHeld],
  ["nowPaid", RULE_TRIAL_COPY.nowPaid],
  ["nowTwoPeople", RULE_TRIAL_COPY.nowTwoPeople],
  ["cantTell", RULE_TRIAL_COPY.cantTell],
];

/** "Oct 8", the UTC day of an ISO date. */
function day(value: string): string {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** What a replay found: the change before and after, the five counts, and each decision that changes or it cannot tell. */
export function RuleTrialResult({ orgSlug, view }: { orgSlug: string; view: RuleReplayView }) {
  const changed = view.counts.decisions - view.counts.unchanged;
  return (
    <section aria-label="What this figure would have done" className="grid gap-3 text-[0.8125rem]">
      <div>
        <p className="font-medium text-ink">{view.setting}</p>
        <p className="mt-0.5 text-ink-2">
          <span>In force now: {view.from}</span>
          <span aria-hidden> → </span>
          <span className="sr-only">; </span>
          <span className="font-medium text-ink">Trying: {view.to}</span>
        </p>
        <p className="mt-0.5 text-xs text-ink-3">
          {view.counts.decisions} {view.counts.decisions === 1 ? "decision" : "decisions"} replayed, {day(view.windowFrom)} to {day(view.windowTo)} (UTC)
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {COUNTS.map(([key, label]) => (
          <div key={key} className="rounded-lg border border-line bg-surface px-2.5 py-1.5">
            <dt className="text-xs text-ink-2">{label}</dt>
            <dd className={cn("text-base font-semibold tabular-nums", view.counts[key] > 0 && key !== "unchanged" ? "text-ink" : "text-ink-3")}>{view.counts[key]}</dd>
          </div>
        ))}
      </dl>
      {view.counts.decisions === 0 ? (
        <p className="text-ink-2">{RULE_TRIAL_COPY.none}</p>
      ) : changed === 0 ? (
        <p className="text-ink-2">{RULE_TRIAL_COPY.nothing}</p>
      ) : (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-surface px-3">
          {view.rows.map((row) => (
            <li key={row.seq} className="grid gap-0.5 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="min-w-0 font-medium text-ink">
                  {row.bill} <span className="font-normal text-ink-2">· {row.counterparty}</span>
                </p>
                <Badge size="sm" tone={CHANGE[row.change].tone}>
                  {CHANGE[row.change].label}
                </Badge>
              </div>
              <p className="text-xs text-ink-2">
                {row.amount === null ? "Amount not recorded" : row.currency === "USDC" ? <Money value={row.amount} /> : `${row.amount} ${row.currency}`} · {day(row.date)} ·{" "}
                <Link href={orgHref(orgSlug, `/audit?before=${row.seq + 1}#seq-${row.seq}`)} className="font-mono text-agent hover:underline">
                  #{String(row.seq).padStart(4, "0")}
                </Link>
              </p>
              <p className="text-xs text-ink-2">
                Now: {row.before}. With this figure: <span className="text-ink">{row.after}</span>.
              </p>
            </li>
          ))}
          {view.more > 0 && <li className="py-2 text-xs text-ink-3">And {view.more} more, counted above.</li>}
        </ul>
      )}
      <p className="text-xs leading-5 text-ink-3">{RULE_TRIAL_COPY.note}</p>
    </section>
  );
}
