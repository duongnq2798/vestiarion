"use client";

import { Link2, Send } from "lucide-react";
import { useState } from "react";
import { createPayeeLinkAction, revokePayeeLinkAction, type PayeeLinkActionResult } from "@/app/actions/payee-links";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";
import { utcDay } from "@/lib/copy";

const INITIAL: PayeeLinkActionResult = { ok: false, message: "" };
const revoke = withSuccessToast(revokePayeeLinkAction);

/**
 * How often the Counterparties page re-reads its data. A payee answers a link from
 * another browser, so while a link is out or an address waits for confirmation the
 * page checks every 15 s, and "not yet confirmed" appears without a reload; the
 * rest of the time, every minute (the Members page's rhythm for its invitations).
 */
export function counterpartiesRefreshMs(state: { linksOut: number; unconfirmed: number }): number {
  return state.linksOut > 0 || state.unconfirmed > 0 ? 15_000 : 60_000;
}

export interface PayeeLinkControlProps {
  orgSlug: string;
  counterparty: { id: string; name: string };
  /** The payee's unused, unexpired link, if one is out. */
  activeLink: { id: string; expiresAt: string } | null;
}

/**
 * Ask a payee for their own Arc address (spec 2026-09-30-payee-links-design.md):
 * a one-time link, shown once, that the payee opens without an account. Whatever
 * they enter waits for a member to confirm it before the agent pays there.
 */
export default function PayeeLinkControl({ orgSlug, counterparty, activeLink }: PayeeLinkControlProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {activeLink ? (
        <>
          <Badge size="sm" dot tone="agent">
            Address link sent · expires {utcDay(activeLink.expiresAt)}
          </Badge>
          <RevokeLink orgSlug={orgSlug} linkId={activeLink.id} />
        </>
      ) : (
        <span />
      )}
      <AskForAddress orgSlug={orgSlug} counterparty={counterparty} />
    </div>
  );
}

function AskForAddress({ orgSlug, counterparty }: Pick<PayeeLinkControlProps, "orgSlug" | "counterparty">) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" icon={<Send />} className="shrink-0">
          Ask for address
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Ask ${counterparty.name} for their address`}
        description="Send them a one-time link. They enter their own Arc address, with no account, and you confirm it before the agent pays there."
      >
        <CreateLinkForm orgSlug={orgSlug} counterparty={counterparty} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The create form, and the link it just made. Its state lives here, inside the
 * dialog's content, which unmounts when the dialog closes: reopening always
 * starts at the form, never at a link that has since been used or revoked.
 */
function CreateLinkForm({ orgSlug, counterparty }: Pick<PayeeLinkControlProps, "orgSlug" | "counterparty">) {
  const { state, formProps } = useActionForm(createPayeeLinkAction, INITIAL);

  if (state.ok && state.url && state.expiresAt) {
    return <CreatedPayeeLink url={state.url} expiresAt={state.expiresAt} payeeName={counterparty.name} />;
  }
  return (
    <form {...formProps} className="grid gap-5">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="counterpartyId" value={counterparty.id} />
      <p className="text-sm leading-6 text-ink-2">A new link replaces any unused one you sent {counterparty.name} before.</p>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">Cancel</Button>
        </DialogClose>
        <SubmitButton pendingLabel="Creating…" icon={<Link2 />}>
          Create link
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

/** The link just made, shown this once: it is never stored in a form anyone can read again. */
export function CreatedPayeeLink({ url, expiresAt, payeeName }: { url: string; expiresAt: string; payeeName: string }) {
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Input readOnly value={url} aria-label="Payee link" className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
        <CopyButton value={url} label="Copy link" variant="secondary">
          Copy link
        </CopyButton>
      </div>
      <p className="text-sm leading-6 text-ink-2">
        Send it to {payeeName}. It works once and expires {utcDay(expiresAt)}. When they enter an address, the agent holds payments to {payeeName}{" "}
        until someone here confirms it on this page.
      </p>
      <p className="text-xs text-ink-3">This link is shown only now. Create a new one if it is lost.</p>
    </div>
  );
}

function RevokeLink({ orgSlug, linkId }: { orgSlug: string; linkId: string }) {
  const { state, formProps, pending } = useActionForm(revoke, INITIAL);
  return (
    <form {...formProps} className="flex items-center gap-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="linkId" value={linkId} />
      <Button type="submit" size="sm" variant="ghost" loading={pending}>
        Revoke
      </Button>
      {state.message && !state.ok && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}
