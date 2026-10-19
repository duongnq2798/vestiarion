"use client";

import { Link2, Send } from "lucide-react";
import { useState } from "react";
import { createPayeeLinkAction, revokePayeeLinkAction, type PayeeLinkActionResult } from "@/app/actions/payee-links";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
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

export interface PayeeLinkControlProps {
  orgSlug: string;
  counterparty: { id: string; name: string };
  /** The label of the chain the payee is paid on now, which the dialog names: Base, or the workspace's own chain. */
  chainLabel: string;
  /** The payee's unused, unexpired link, if one is out. */
  activeLink: { id: string; expiresAt: string } | null;
  /**
   * What the link may also ask (payee invoice link P1): `invoice`, for any payee but a client; `chains`, the chains a
   * vendor with no address may choose among, when the workspace pays more than one; none otherwise.
   */
  offers?: { invoice: boolean; chains: readonly string[] };
  /** The payee's used link still waiting for their invoice, and until when it takes one (P6). */
  waitingInvoice?: { id: string; until: string } | null;
}

/** The two options under the dialog's text (P1): both off by default, so a link made without them works as before. */
export const ASK_INVOICE = "Also ask for their invoice";
export const OFFER_CHAIN = "Let them choose where they are paid";

/**
 * Ask a payee for their own address on the chain they are paid on (spec 2026-09-30-payee-links-design.md):
 * a one-time link, shown once, that the payee opens without an account. Whatever
 * they enter waits for a member to confirm it before the agent pays there. The
 * link may also ask for their invoice, and let a vendor choose its chain
 * (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P1). Once the
 * payee sent their address, a link still waiting for their invoice shows here
 * too, and Revoke stops it taking one (P6).
 */
export default function PayeeLinkControl({ orgSlug, counterparty, chainLabel, activeLink, offers, waitingInvoice = null }: PayeeLinkControlProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {activeLink ? (
        <>
          <Badge size="sm" dot tone="agent">
            Address link sent · expires {utcDay(activeLink.expiresAt)}
          </Badge>
          <RevokeLink orgSlug={orgSlug} linkId={activeLink.id} />
        </>
      ) : waitingInvoice ? (
        <>
          <Badge size="sm" dot tone="agent">
            Waiting for their invoice · until {utcDay(waitingInvoice.until)}
          </Badge>
          <RevokeLink orgSlug={orgSlug} linkId={waitingInvoice.id} />
        </>
      ) : (
        <span />
      )}
      <AskForAddress orgSlug={orgSlug} counterparty={counterparty} chainLabel={chainLabel} offers={offers} />
    </div>
  );
}

function AskForAddress({ orgSlug, counterparty, chainLabel, offers }: Pick<PayeeLinkControlProps, "orgSlug" | "counterparty" | "chainLabel" | "offers">) {
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
        description={`Send them a one-time link. They enter their own address on ${chainLabel}, with no account, and you confirm it before the agent pays there.`}
      >
        <CreateLinkForm orgSlug={orgSlug} counterparty={counterparty} offers={offers} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The create form, and the link it just made. Its state lives here, inside the
 * dialog's content, which unmounts when the dialog closes: reopening always
 * starts at the form, never at a link that has since been used or revoked.
 */
function CreateLinkForm({ orgSlug, counterparty, offers }: Pick<PayeeLinkControlProps, "orgSlug" | "counterparty" | "offers">) {
  const { state, formProps } = useActionForm(createPayeeLinkAction, INITIAL);
  const chains = offers?.chains ?? [];

  if (state.ok && state.url && state.expiresAt) {
    return <CreatedPayeeLink url={state.url} expiresAt={state.expiresAt} payeeName={counterparty.name} asksInvoice={state.asksInvoice === true} />;
  }
  return (
    <form {...formProps} className="grid gap-5">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="counterpartyId" value={counterparty.id} />
      <p className="text-sm leading-6 text-ink-2">A new link replaces any unused one you sent {counterparty.name} before.</p>
      {(offers?.invoice || chains.length > 1) && (
        <div className="grid gap-3">
          {offers?.invoice && (
            <Checkbox
              name="asksInvoice"
              label={ASK_INVOICE}
              description="It waits under Waiting for review on Bills until someone here adds it as a bill. Nothing is paid because it arrived."
            />
          )}
          {chains.length > 1 && (
            <Checkbox
              name="offersChain"
              label={OFFER_CHAIN}
              description={`Where their wallet receives USDC: ${chains.slice(0, -1).join(", ")} or ${chains[chains.length - 1]}. You confirm the chain with the address.`}
            />
          )}
        </div>
      )}
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
export function CreatedPayeeLink({ url, expiresAt, payeeName, asksInvoice = false }: { url: string; expiresAt: string; payeeName: string; asksInvoice?: boolean }) {
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
        {asksInvoice && " Their invoice waits under Waiting for review on Bills until someone here adds it."}
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
