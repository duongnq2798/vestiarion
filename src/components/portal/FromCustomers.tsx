"use client";

import { ArrowRight, MessageSquareReply } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { closeCustomerRequestAction, replyToCustomerAction, type CustomerPortalActionResult } from "@/app/actions/customer-portal";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Textarea } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { RequestKind } from "@/lib/customer-portal/model";
import type { FromCustomerView } from "@/lib/customer-portal/view";

/**
 * What customers said on their statements, for finance to act on (docs/superpowers/specs/2026-10-13-customer-portal-
 * design.md P8), on Bills & receivables' Receivables tab: each request with its customer, invoice and what is owed, the
 * customer's words, the thread, and the next step. A claim of payment is shown as the customer's word ("Customer says
 * paid"), never as a payment. An owner or admin replies and closes; every other member reads.
 */

/** One request as finance reads it (`fromCustomerItems`). */
export type FromCustomerItem = FromCustomerView;

const TONES: Record<RequestKind, "held" | "agent" | "refused" | "neutral"> = { paid: "held", promise: "agent", dispute: "refused", pay_link: "neutral" };
const INITIAL: CustomerPortalActionResult = { ok: false, message: "" };

export function FromCustomers({ orgSlug, items, canWrite }: { orgSlug: string; items: FromCustomerItem[]; canWrite: boolean }) {
  if (items.length === 0) return null;
  return (
    <section id="from-customers" aria-labelledby="from-customers-title" className="scroll-mt-6 space-y-3">
      <SectionHeader id="from-customers-title" title="From customers" meta={`${items.length} to answer`} />
      <p className="text-xs leading-5 text-ink-3">
        What customers said on their statement links. A customer saying it paid is its word, not a payment: the invoice stays open until the payment
        arrives and is applied.
      </p>
      <Card className="overflow-hidden">
        <ul aria-label="Requests from customers" className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.id}>
              <FromCustomerRow orgSlug={orgSlug} item={item} canWrite={canWrite} />
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function FromCustomerRow({ orgSlug, item, canWrite }: { orgSlug: string; item: FromCustomerItem; canWrite: boolean }) {
  const router = useRouter();
  const [replying, setReplying] = useState(false);
  const replyId = useId();
  const reply = useActionForm(replyToCustomerAction, INITIAL, {
    resetOnSuccess: true,
    onSuccess: () => {
      setReplying(false);
      router.refresh();
    },
  });
  const close = useActionForm(closeCustomerRequestAction, INITIAL, { toastOnSuccess: true, onSuccess: () => router.refresh() });
  const closes = item.step.closes.filter((outcome) => item.closeLabels[outcome]);

  return (
    <article aria-labelledby={`${item.id}-title`} className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge tone={TONES[item.kind]} dot>
          {item.kindLabel}
        </Badge>
        <h3 id={`${item.id}-title`} className="min-w-0 text-sm font-semibold text-ink">
          {item.customerName}
        </h3>
        <span className="text-xs text-ink-3">{item.on}</span>
      </div>
      <p className="text-sm text-ink">{item.said}</p>
      <p className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem] text-ink-2">
        <Link href={item.invoiceHref} className="break-words font-medium text-agent underline-offset-4 hover:underline">
          {item.invoiceLabel}
        </Link>
        <span>· {item.owed}</span>
        {item.pause && <span>· {item.pause}</span>}
      </p>
      {item.messages.length > 0 && (
        <ol aria-label="Messages" className="space-y-2">
          {item.messages.map((message) => (
            <li key={message.id} className={message.business ? "rounded-xl border border-agent-line bg-agent-soft px-3 py-2" : "rounded-xl bg-ground px-3 py-2"}>
              <p className="text-xs font-medium text-ink-3">
                {message.who} · {message.on}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-ink">{message.body}</p>
            </li>
          ))}
        </ol>
      )}
      <div className="rounded-xl border border-line bg-ground px-3 py-2.5">
        <p className="flex items-start gap-1.5 text-sm font-semibold text-ink">
          <ArrowRight aria-hidden className="mt-0.5 size-4 shrink-0 text-agent" />
          <span>Next: {item.step.label}</span>
        </p>
        <p className="mt-0.5 pl-[1.375rem] text-[0.8125rem] leading-5 text-ink-2">{item.step.detail}</p>
      </div>
      {canWrite && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {item.step.openInvoice && (
              <Button asChild size="sm" variant="primary">
                <Link href={item.invoiceHref}>Open the invoice</Link>
              </Button>
            )}
            {item.step.reply && !replying && (
              <Button size="sm" variant="secondary" icon={<MessageSquareReply />} aria-expanded={false} aria-controls={replyId} onClick={() => setReplying(true)}>
                Reply
              </Button>
            )}
            {closes.length > 0 && (
              <form {...close.formProps} className="contents">
                <input type="hidden" name="orgSlug" value={orgSlug} />
                <input type="hidden" name="requestId" value={item.id} />
                {closes.map((outcome) => (
                  <SubmitButton key={outcome} size="sm" variant={outcome === "not_received" ? "ghost" : "secondary"} name="outcome" value={outcome} pendingLabel="Closing…">
                    {item.closeLabels[outcome]}
                  </SubmitButton>
                ))}
              </form>
            )}
          </div>
          {!close.state.ok && close.state.message && <FormMessage tone="error">{close.state.message}</FormMessage>}
          {replying && (
            <form id={replyId} {...reply.formProps} className="grid gap-2">
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="requestId" value={item.id} />
              <Field id={`${replyId}-body`} label={`Reply to ${item.customerName}`} description="They read it on their statement, under your workspace's name.">
                <Textarea name="body" rows={3} maxLength={2000} required autoFocus />
              </Field>
              <FormMessage tone={reply.state.ok ? "success" : "error"}>{reply.state.message || null}</FormMessage>
              <div className="flex flex-wrap gap-2">
                <SubmitButton size="sm" pendingLabel="Sending…">
                  Send reply
                </SubmitButton>
                <Button size="sm" variant="ghost" onClick={() => setReplying(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </article>
  );
}
