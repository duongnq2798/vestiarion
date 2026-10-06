"use client";

import { Gauge, ShieldCheck } from "lucide-react";
import { useCallback, useState } from "react";
import { enforceSpendingLimitAction, setAgentBudgetAction, turnOffSpendingLimitAction } from "@/app/actions/agent";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";
import { fmt, Hash, Money } from "@/components/vx/Primitives";
import { withSuccessToast } from "@/components/withSuccessToast";
import { addressUrl } from "@/lib/payee-chains";
import { networkProfile, type Network } from "@/lib/network";

/** What the limit dialog says a figure is, and what leaving one blank does: on Arc mainnet a figure stays (mainnet copy C11). */
export function budgetDialogDescription(network: Network): string {
  const rule = "What the agent may pay on its own, in USDC, counted from 00:00 UTC. A payment past either figure is held for a person in Approvals; one a person approves does not count.";
  return network === "arc-mainnet" ? `${rule} A workspace on Arc mainnet keeps a daily or 7-day limit.` : `${rule} Leave a figure blank for no limit.`;
}

const INITIAL: ActionResult = { ok: false, message: "" };
const save = withSuccessToast(setAgentBudgetAction);
const enforce = withSuccessToast(enforceSpendingLimitAction);
const turnOff = withSuccessToast(turnOffSpendingLimitAction);

/**
 * The limit on Arc, as the console reads it (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md §4,
 * R14): its state, its contract and the agent's wallet, and the contract's own figures and count, or null when they
 * could not be read.
 */
export interface OnChainLimitView {
  state: "enforced" | "off" | "unfinished";
  contract: string | null;
  agent: string | null;
  reading: { dailyUsdc: number | null; weeklyUsdc: number | null; spentToday: number; spentThisWeek: number } | null;
}

/** What the panel says about enforcing the limit on Arc, and the action it offers, if any. */
export const ON_ARC_COPY = {
  explain: "Enforce it on Arc, and the agent's own payments go through a contract that refuses anything past the limit, whatever the agent decides.",
  enforced: "Enforced on Arc. The agent's own payments go through its contract, which refuses anything past the limit.",
  needsFigure: "Set a daily or 7-day figure to enforce it on Arc.",
  sandbox: "A live workspace can enforce it on Arc.",
  unreadable: "The contract's figures could not be read just now.",
  wallet:
    "Your wallet's contract carries every payment Vestiarion makes from it, and refuses anything past its figures. Only your wallet can change the figures, or stop it.",
  turnOffDescription:
    "The agent's payments are then checked against the limit in code only. The contract stays on Arc, and the operating wallet's approval goes to 0, so it can draw nothing.",
} as const;

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
export function AgentBudgetPanel({
  orgSlug,
  view,
  canEdit,
  live = false,
  onChain = null,
  network,
  walletTreasury = false,
}: {
  /** The workspace's network: its explorer links what this shows (network threading P6). */
  network: Network;
  orgSlug: string;
  view: AgentBudgetView;
  canEdit: boolean;
  /** A live workspace: the only kind that can enforce the limit on Arc. */
  live?: boolean;
  /** The limit on Arc; null when it was never set up. */
  onChain?: OnChainLimitView | null;
  /** The workspace pays from its owner's own wallet, whose contract only that wallet changes (wallet treasury W14). */
  walletTreasury?: boolean;
}) {
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
          {canEdit && <BudgetDialog orgSlug={orgSlug} view={view} unset={unset} network={network} />}
          {/* Only where the network runs the spending-limit contract: Arc mainnet does not (final review I1, mainnet copy C3). */}
          {walletTreasury ? (
            <OnArcWallet onChain={onChain} network={network} />
          ) : (
            networkProfile(network).spendingLimitContract && (
              <OnArc orgSlug={orgSlug} onChain={onChain} canEdit={canEdit} live={live} unset={unset} network={network} />
            )
          )}
        </CardContent>
      </section>
    </Card>
  );
}

/** The owner's own wallet's contract (wallet treasury W14): what it holds and has paid; nothing here changes it. */
function OnArcWallet({ onChain, network }: { onChain: OnChainLimitView | null; network: Network }) {
  const reading = onChain?.reading ?? null;
  return (
    <div className="mt-4 space-y-2 border-t border-line pt-4 text-[0.8125rem]">
      <p className="flex items-center gap-1.5 font-medium text-ink">
        <ShieldCheck aria-hidden className={cn("size-4", onChain?.state === "enforced" ? "text-agent" : "text-ink-3")} />
        On Arc
      </p>
      <p className="leading-5 text-ink-2">{ON_ARC_COPY.wallet}</p>
      <dl className="space-y-1">
        {onChain?.contract && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-2">Contract</dt>
            <dd>
              <Hash value={onChain.contract} href={addressUrl(network, onChain.contract)} />
            </dd>
          </div>
        )}
        {reading ? (
          <>
            <OnChainCount label="Paid through it today" spent={reading.spentToday} limit={reading.dailyUsdc} />
            <OnChainCount label="In the last 7 days" spent={reading.spentThisWeek} limit={reading.weeklyUsdc} />
          </>
        ) : (
          onChain?.contract && <p className="text-xs text-ink-3">{ON_ARC_COPY.unreadable}</p>
        )}
      </dl>
    </div>
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

function BudgetDialog({ orgSlug, view, unset, network }: { orgSlug: string; view: AgentBudgetView; unset: boolean; network: Network }) {
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
        description={budgetDialogDescription(network)}
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

/** The limit on Arc (onchain spending limit §4): what the contract counts, or the action that puts it there. */
function OnArc({ orgSlug, onChain, canEdit, live, unset, network }: { orgSlug: string; onChain: OnChainLimitView | null; canEdit: boolean; live: boolean; unset: boolean; network: Network }) {
  const enforced = onChain?.state === "enforced";
  const enforceForm = useActionForm(enforce, INITIAL);
  const offForm = useActionForm(turnOff, INITIAL);
  const offId = "spending-limit-off";
  const reading = onChain?.reading ?? null;

  return (
    <div className="mt-4 space-y-2 border-t border-line pt-4 text-[0.8125rem]">
      <p className="flex items-center gap-1.5 font-medium text-ink">
        <ShieldCheck aria-hidden className={cn("size-4", enforced ? "text-agent" : "text-ink-3")} />
        On Arc
      </p>
      {enforced ? (
        <>
          <p className="leading-5 text-ink-2">{ON_ARC_COPY.enforced}</p>
          <dl className="space-y-1">
            {onChain?.contract && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-2">Contract</dt>
                <dd>
                  <Hash value={onChain.contract} href={addressUrl(network, onChain.contract)} />
                </dd>
              </div>
            )}
            {onChain?.agent && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-2">Agent&apos;s wallet</dt>
                <dd>
                  <Hash value={onChain.agent} href={addressUrl(network, onChain.agent)} />
                </dd>
              </div>
            )}
            {reading ? (
              <>
                <OnChainCount label="Paid through it today" spent={reading.spentToday} limit={reading.dailyUsdc} />
                <OnChainCount label="In the last 7 days" spent={reading.spentThisWeek} limit={reading.weeklyUsdc} />
              </>
            ) : (
              <p className="text-xs text-ink-3">{ON_ARC_COPY.unreadable}</p>
            )}
          </dl>
          {canEdit && (
            <>
              <form id={offId} className="contents" {...offForm.formProps}>
                <input type="hidden" name="orgSlug" value={orgSlug} />
              </form>
              <ConfirmDialog
                formId={offId}
                trigger={
                  <Button variant="ghost" size="sm" loading={offForm.pending}>
                    Turn off on Arc
                  </Button>
                }
                title="Stop enforcing the limit on Arc?"
                description={ON_ARC_COPY.turnOffDescription}
                confirmLabel="Turn off on Arc"
              />
              {/* Takes no room until turning it off has something to say. */}
              <FormMessage tone="error" className={!offForm.state.ok && offForm.state.message ? "mt-2" : "min-h-0"}>
                {offForm.state.ok ? null : offForm.state.message}
              </FormMessage>
            </>
          )}
        </>
      ) : !live ? (
        <p className="leading-5 text-ink-3">{ON_ARC_COPY.sandbox}</p>
      ) : (
        <>
          <p className="leading-5 text-ink-2">{ON_ARC_COPY.explain}</p>
          {unset ? (
            <p className="text-xs text-ink-3">{ON_ARC_COPY.needsFigure}</p>
          ) : (
            canEdit && (
              <form {...enforceForm.formProps} className="space-y-2">
                <input type="hidden" name="orgSlug" value={orgSlug} />
                <SubmitButton variant="secondary" size="sm" icon={<ShieldCheck />} pendingLabel="Enforcing on Arc…">
                  {onChain?.state === "unfinished" ? "Finish enforcing on Arc" : "Enforce on Arc"}
                </SubmitButton>
                <FormMessage tone="error" className={!enforceForm.state.ok && enforceForm.state.message ? undefined : "min-h-0"}>
                  {enforceForm.state.ok ? null : enforceForm.state.message}
                </FormMessage>
              </form>
            )
          )}
        </>
      )}
    </div>
  );
}

function OnChainCount({ label, spent, limit }: { label: string; spent: number; limit: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="min-w-0 text-ink-2">{label}</dt>
      <dd className="shrink-0 text-ink">
        <span className="tabular-nums">{fmt(spent)}</span>
        {limit === null ? (
          <span className="text-ink-3"> USDC · no figure</span>
        ) : (
          <>
            <span className="text-ink-3"> of </span>
            <Money value={limit} />
          </>
        )}
      </dd>
    </div>
  );
}
