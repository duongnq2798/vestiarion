"use client";

import { Mail, Send } from "lucide-react";
import { useState } from "react";
import { askEveryPayeeAction, type AskEveryPayeeResult } from "@/app/actions/payee-links";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { PayeeToAsk } from "@/lib/address-requests";
import { utcDay } from "@/lib/copy";

/**
 * Ask every payee for an address at once, above the Counterparty book (docs/superpowers/specs/
 * 2026-10-18-ask-every-payee-design.md A1-A4): how many payees have no address of their own, then a dialog listing each
 * and how its link goes, by email or to copy. Nothing is sent until Send the links; the links not emailed are shown once.
 */

const INITIAL: AskEveryPayeeResult = { ok: false, message: "" };

const payeesWord = (count: number) => (count === 1 ? "payee" : "payees");

export function AskEveryPayee({ orgSlug, payees, more, linksOut }: { orgSlug: string; payees: PayeeToAsk[]; more: number; linksOut: number }) {
  const [open, setOpen] = useState(false);
  const count = payees.length;
  return (
    <Card className="mb-8 flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0 flex-1 space-y-1">
        <h2 className="text-sm font-semibold text-ink">Ask every payee for an address</h2>
        <p className="text-sm text-ink-2">
          {count} {payeesWord(count)} {count === 1 ? "has" : "have"} no address of {count === 1 ? "its" : "their"} own, so payments to{" "}
          {count === 1 ? "it wait" : "them wait"}. Each gets its own one-time link, by email where it has one.
          {linksOut > 0 ? ` ${linksOut} more already ${linksOut === 1 ? "has" : "have"} a link out.` : ""}
          {more > 0 ? ` ${more} more after these, for the next time.` : ""}
        </p>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" icon={<Send />} className="shrink-0">
            Ask {count} for an address
          </Button>
        </DialogTrigger>
        <DialogContent
          title={`Ask ${count} ${payeesWord(count)} for an address`}
          description="Each gets a one-time link to enter its own address, with no account. You confirm each address before the agent pays there."
        >
          <AskForm orgSlug={orgSlug} payees={payees} />
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** The list and its Send, then what went: its state lives in the dialog's content, so reopening starts at the list. */
function AskForm({ orgSlug, payees }: { orgSlug: string; payees: PayeeToAsk[] }) {
  const { state, formProps } = useActionForm(askEveryPayeeAction, INITIAL);

  if (state.ok && state.asked) {
    const { emailed, links, notMade } = state.asked;
    return (
      <div className="grid gap-4">
        <p className="text-sm text-ink" role="status">
          {state.message}
        </p>
        {emailed.length > 0 && <p className="text-sm text-ink-2">Emailed: {emailed.join(", ")}.</p>}
        {links.length > 0 && (
          <div className="grid gap-2">
            <p className="text-sm text-ink-2">Send these yourself. Each is shown only now, works once and expires on the day shown:</p>
            <ul className="grid gap-2">
              {links.map((link) => (
                <li key={link.counterpartyId} className="grid gap-1">
                  <span className="text-xs font-medium text-ink">
                    {link.name} · expires {utcDay(link.expiresAt)}
                  </span>
                  <div className="flex items-center gap-2">
                    <Input readOnly value={link.url} aria-label={`Payee link for ${link.name}`} className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
                    <CopyButton value={link.url} label={`Copy the link for ${link.name}`} variant="secondary">
                      Copy link
                    </CopyButton>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {notMade.length > 0 && <p className="text-sm text-ink-2">Not made: {notMade.join(", ")}. Ask each from its row.</p>}
        <p className="text-xs text-ink-3">An address that comes in waits for someone here to confirm it, on this page, before the agent pays there.</p>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Done</Button>
          </DialogClose>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form {...formProps} className="grid gap-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <ul aria-label="Payees to ask" className="grid max-h-72 gap-2 overflow-y-auto">
        {payees.map((payee) => (
          <li key={payee.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <input type="hidden" name="counterpartyId" value={payee.id} />
            <span className="min-w-0 font-medium text-ink">
              {payee.name}
              {payee.mirror && <span className="ml-1 text-xs font-normal text-ink-3">(paid at a mirror address)</span>}
            </span>
            {payee.email ? (
              <Badge size="sm" tone="proof" icon={<Mail />}>
                By email to {payee.email}
              </Badge>
            ) : (
              <Badge size="sm" tone="neutral">
                No email: copy its link
              </Badge>
            )}
          </li>
        ))}
      </ul>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">Cancel</Button>
        </DialogClose>
        <SubmitButton pendingLabel="Sending…" icon={<Send />}>
          Send the links
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}
