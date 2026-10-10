"use client";

import { MailCheck, X } from "lucide-react";
import { addInboxEmailAction, dismissInboxEmailAction, finishInboxEmailAction, type InboxActionResult } from "@/app/actions/email-inbox";
import InvoiceIntake, { type IntakeCounterparty } from "@/components/intake/InvoiceIntake";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { InboxEmailView } from "@/lib/email-inbox/list";

const INITIAL: InboxActionResult = { ok: false, message: "" };
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** "Oct 3, 16:00 UTC". */
function receivedOn(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${day}, ${iso.slice(11, 16)} UTC`;
}

/** The sender's checks as Resend reported them, in one sentence: a check, never permission (email invoices design E6). */
function senderChecks(email: InboxEmailView): string {
  const auth = email.authentication;
  if (!auth) return "The sender's checks were not reported.";
  const failed = (["spf", "dkim", "dmarc"] as const).filter((check) => auth[check] !== "pass").map((check) => check.toUpperCase());
  if (failed.length === 0) return "SPF, DKIM and DMARC pass for this sender.";
  return `The sender did not pass ${failed.length === 1 ? failed[0] : `${failed.slice(0, -1).join(", ")} and ${failed.at(-1)}`}: check it came from the vendor.`;
}

function Decide({ orgSlug, email }: { orgSlug: string; email: InboxEmailView }) {
  const add = useActionForm(addInboxEmailAction, INITIAL, { toastOnSuccess: true });
  const addPending = useActionForm(addInboxEmailAction, INITIAL, { toastOnSuccess: true });
  const dismiss = useActionForm(dismissInboxEmailAction, INITIAL, { toastOnSuccess: true });
  const refusal = [add.state, addPending.state, dismiss.state].find((state) => !state.ok && state.message);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {email.status === "ready" && (
          <>
            <form {...add.formProps}>
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="inboxEmailId" value={email.id} />
              <input type="hidden" name="goodsReceived" value="true" />
              <SubmitButton size="sm" pendingLabel="Adding…" icon={<MailCheck aria-hidden />}>
                Add, goods received
              </SubmitButton>
            </form>
            <form {...addPending.formProps}>
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="inboxEmailId" value={email.id} />
              <input type="hidden" name="goodsReceived" value="false" />
              <SubmitButton size="sm" variant="secondary" pendingLabel="Adding…">
                Add, not received yet
              </SubmitButton>
            </form>
          </>
        )}
        <form {...dismiss.formProps}>
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="inboxEmailId" value={email.id} />
          <SubmitButton size="sm" variant="secondary" pendingLabel="Dismissing…" icon={<X aria-hidden />}>
            Dismiss
          </SubmitButton>
        </form>
      </div>
      <FormMessage tone={refusal ? "error" : "neutral"}>{refusal?.message ?? null}</FormMessage>
    </div>
  );
}

/**
 * The invoice form, started from what was read, for a person to fix any field and add it (reader follow-up F5): a
 * ready email edited before it is added, one that lacks a detail finished, one that could not be read typed in.
 */
function FinishForm({ orgSlug, email, counterparties }: { orgSlug: string; email: InboxEmailView; counterparties: IntakeCounterparty[] }) {
  const read = email.read;
  // An email read before the inbox kept the counterparty's id is matched again by its name.
  const counterpartyId = read?.counterpartyId ?? counterparties.find((counterparty) => counterparty.name === read?.counterpartyName)?.id ?? null;
  return (
    <Disclosure summary={email.status === "ready" ? "Edit and add" : "Finish and add"}>
      <InvoiceIntake
        orgSlug={orgSlug}
        counterparties={counterparties}
        inboxEmailId={email.id}
        action={finishInboxEmailAction}
        idPrefix={`email-${email.id}`}
        initial={{
          counterpartyId,
          amount: read?.amount ?? null,
          currency: read?.currency ?? null,
          dueDate: read?.dueDate ?? null,
          earlyPayDiscountPct: read?.earlyPayDiscountPct ?? null,
          discountDeadline: read?.discountDeadline ?? null,
          memo: read?.memo ?? null,
          poReference: read?.poReference ?? null,
        }}
      />
    </Disclosure>
  );
}

function EmailCard({ orgSlug, email, canAdd, counterparties }: { orgSlug: string; email: InboxEmailView; canAdd: boolean; counterparties: IntakeCounterparty[] }) {
  const read = email.read;
  // The counterparty the invoice matched. A vendor name read but matched to none is said as such, never as one.
  const who = read?.counterpartyName ?? null;
  const unmatchedVendor = who ? null : (read?.vendorName ?? null);
  return (
    <Card className="space-y-3 p-4 sm:p-5">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{email.subject || "(no subject)"}</p>
        <p className="text-xs text-ink-3">
          From {email.from ?? "an unknown sender"} · {receivedOn(email.receivedAt)}
        </p>
      </div>
      {email.status === "received" && <p className="text-sm text-ink-2">Reading…</p>}
      {read && email.status !== "unreadable" && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-3">Counterparty</dt>
          <dd className="text-ink">
            {who ??
              (unmatchedVendor ? (
                <>
                  {unmatchedVendor} <span className="text-ink-3">· not in Counterparties</span>
                </>
              ) : (
                "not matched"
              ))}
          </dd>
          <dt className="text-ink-3">Amount</dt>
          <dd className="text-ink">{read.amount ? `${AMOUNT.format(Number(read.amount))} ${read.currency ?? "USDC"}` : "not read"}</dd>
          <dt className="text-ink-3">Due</dt>
          <dd className="text-ink">{read.dueDate ?? "not read"}</dd>
          <dt className="text-ink-3">Purchase order</dt>
          <dd className="text-ink">{read.poReference ?? "none"}</dd>
          {read.invoiceNumber && (
            <>
              <dt className="text-ink-3">Invoice number</dt>
              <dd className="text-ink">{read.invoiceNumber}</dd>
            </>
          )}
        </dl>
      )}
      {read?.warnings.map((warning) => (
        <p key={warning} className="text-xs text-refused">
          {warning}
        </p>
      ))}
      {read?.modelNote && <p className="text-xs italic text-ink-3">The model&apos;s note: {read.modelNote}</p>}
      {email.status === "needs_details" && (
        <div className="text-sm text-ink-2">
          <p className="font-medium text-ink">Cannot be added as it was read:</p>
          <ul className="list-disc pl-5">
            {email.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {canAdd && <p className="mt-1 text-xs text-ink-3">Fix what is missing with Finish and add.</p>}
        </div>
      )}
      {email.status === "unreadable" && (
        <p className="text-sm text-ink-2">
          <span className="font-medium text-ink">Could not be read:</span> {email.reasons[0] ?? "the email could not be read."}
        </p>
      )}
      {email.status !== "received" && email.status !== "unreadable" && (
        <p className="text-xs text-ink-3">
          {senderChecks(email)}
          {read?.knownSender && who ? ` It is the billing email ${who} has on file.` : ""}
        </p>
      )}
      {canAdd ? (
        <>
          <Decide orgSlug={orgSlug} email={email} />
          {email.status !== "received" && <FinishForm orgSlug={orgSlug} email={email} counterparties={counterparties} />}
        </>
      ) : (
        <p className="text-xs text-ink-3">An owner or admin adds it, or dismisses it.</p>
      )}
    </Card>
  );
}

/**
 * The invoices that arrived by email and wait for a person, on Bills & receivables
 * (docs/superpowers/specs/2026-10-03-email-invoices-design.md E6, E7): what was read, the sender's checks, and for an
 * owner or admin Add (with the goods received or not) and Dismiss. Nothing here is added by itself. Renders nothing
 * when nothing waits.
 */
export default function InboxEmails({
  orgSlug,
  emails,
  canAdd,
  counterparties,
}: {
  orgSlug: string;
  emails: InboxEmailView[];
  canAdd: boolean;
  /** The workspace's counterparties, for the form that finishes an email. */
  counterparties: IntakeCounterparty[];
}) {
  if (emails.length === 0) return null;
  return (
    <section aria-labelledby="email-inbox-title" id="email-inbox" className="mb-8">
      <SectionHeader id="email-inbox-title" title="From email" meta={`${emails.length} to decide · sent to this workspace's invoice address`} />
      <div className="space-y-3">
        {emails.map((email) => (
          <EmailCard key={email.id} orgSlug={orgSlug} email={email} canAdd={canAdd} counterparties={counterparties} />
        ))}
      </div>
    </section>
  );
}
