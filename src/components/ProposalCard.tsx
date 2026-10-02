"use client";

import { Check, Lightbulb, X } from "lucide-react";
import { acceptProposalAction, dismissProposalAction, type ProposalActionResult } from "@/app/actions/proposals";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { Money } from "@/components/vx/Primitives";
import { utcDay } from "@/lib/copy";
import type { ProposalView } from "@/lib/policy-proposals";
import { presentReasoning } from "@/lib/reasoning-copy";

const INITIAL: ProposalActionResult = { ok: false, message: "" };

const HELD_AS: Record<string, string> = { ap_hold: "held", ap_flag_fraud: "flagged", ap_pay: "refused by code", ap_request_info: "asked for information", ap_schedule: "refused by code" };

/**
 * One of the agent's suggestions in Approvals (docs/superpowers/specs/2026-10-02-limit-proposals-design.md
 * §2): the limit it would set, why, and each approval it rests on; Accept or Dismiss for an owner or
 * admin. Every member sees it.
 */
export function ProposalCard({ proposal, orgSlug, canDecide }: { proposal: ProposalView; orgSlug: string; canDecide: boolean }) {
  return (
    <Card asChild className="overflow-hidden">
      <article aria-labelledby={`proposal-${proposal.id}`}>
        <div className="space-y-3 px-4 py-4 sm:px-5">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-agent">
            <Lightbulb aria-hidden className="size-3.5" />
            Suggested by the agent
          </p>
          <h3 id={`proposal-${proposal.id}`} className="text-base font-semibold text-ink [overflow-wrap:anywhere]">
            Raise {proposal.counterpartyName}&apos;s payment limit from {proposal.fromLimit ?? "none"} to {proposal.toLimit} USDC
          </h3>
          <p className="text-sm leading-6 text-ink-2">{presentReasoning(proposal.reasoning) || "The agent's full reasoning is in the audit log."}</p>
          {proposal.evidence.length > 0 && (
            <div>
              <p className="text-xs text-ink-3">People approved, above the limit:</p>
              <ul className="mt-1.5 divide-y divide-line rounded-xl border border-line text-sm">
                {proposal.evidence.map((item) => (
                  <li key={item.invoiceId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
                    <span className="text-ink-2">
                      {item.approvedAt ? utcDay(item.approvedAt) : ""} · the agent {HELD_AS[item.agentAction] ?? "held it"}
                    </span>
                    <Money value={item.amountUsdc} className="text-ink" />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {canDecide ? (
          <div className="flex flex-col gap-2 border-t border-line px-4 py-3 sm:flex-row sm:items-start sm:justify-end sm:px-5">
            <DecideForm action={dismissProposalAction} orgSlug={orgSlug} id={proposal.id} label="Dismiss" pending="Dismissing…" variant="secondary" icon={<X />} />
            <DecideForm action={acceptProposalAction} orgSlug={orgSlug} id={proposal.id} label="Accept" pending="Accepting…" icon={<Check />} />
          </div>
        ) : (
          <p className="border-t border-line px-4 py-3 text-xs text-ink-3 sm:px-5">An owner or admin can accept or dismiss it.</p>
        )}
      </article>
    </Card>
  );
}

function DecideForm({
  action,
  orgSlug,
  id,
  label,
  pending,
  variant,
  icon,
}: {
  action: (previous: ProposalActionResult, formData: FormData) => Promise<ProposalActionResult>;
  orgSlug: string;
  id: string;
  label: string;
  pending: string;
  variant?: "secondary";
  icon: React.ReactNode;
}) {
  const { state, formProps } = useActionForm(action, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-col items-stretch gap-1 sm:items-end">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="proposalId" value={id} />
      <SubmitButton variant={variant} icon={icon} pendingLabel={pending}>
        {label}
      </SubmitButton>
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}
