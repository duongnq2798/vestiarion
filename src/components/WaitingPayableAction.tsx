import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { AddDetailsDialog } from "@/components/AddDetailsDialog";
import { DocumentRequestLine } from "@/components/document-requests/DocumentRequestLine";
import { Button } from "@/components/ui/Button";
import { addDetailsPrompt, addedDetailsSentence, missingDetails, type AddedDetails, type OnFile } from "@/lib/added-details";
import { approvalAnchor, orgHref } from "@/lib/auth/org-paths";
import type { DocumentRequestView } from "@/lib/document-requests/rules";
import { MATCH_INCOMPLETE, ruleNextStep } from "@/lib/next-step";

/** What the card says when the payable lacks nothing a person can add here: it waits for a decision. */
export const WAITING_FOR_A_DECISION = "Waiting for a person's decision.";

/**
 * What a person can do about a payable that waits for them, in its card on Invoices (complete held invoice): an owner
 * or admin adds the purchase order or goods receipt it lacks, right there, and anyone who decides payments opens it in
 * Approvals, at its card. Once details were added, it says so until the agent decides the payable again. A payable
 * code stopped says which rule stopped it and, to an owner or admin, links the page that removes the cause: its
 * counterparty's limit or address, the screening match, the agent's spending limit (agent activity spec R5). A viewer,
 * who can do none of it, sees nothing unless details were added, or the agent asked the vendor for the missing document.
 *
 * Where it did (`documentRequest`), the card says what Vestiarion would ask, when it asked, or what the vendor sent, with
 * the vendor's purchase order number filled into Add details (document requests ER3, ER4, ER6).
 */
export function WaitingPayableAction({
  orgSlug,
  invoice,
  added,
  canAddDetails,
  canDecide,
  rule = null,
  canFix = false,
  documentRequest,
}: {
  orgSlug: string;
  invoice: { id: string; counterpartyName: string; counterpartyId?: string } & OnFile;
  /** What a person added since the agent's decision; null when nothing was. */
  added: AddedDetails | null;
  /** An owner or admin, on a payable with no transfer recorded against it. */
  canAddDetails: boolean;
  /** An owner, admin or approver. */
  canDecide: boolean;
  /** The guardrail rule that refused it, when code stopped it. */
  rule?: string | null;
  /** An owner or admin, who can change what the rule checked: a limit, an address, the spending limit. */
  canFix?: boolean;
  /** The agent's latest request to the vendor for the missing document, as the card shows it. */
  documentRequest?: DocumentRequestView;
}) {
  const step = ruleNextStep(rule, { id: invoice.counterpartyId ?? "", name: invoice.counterpartyName });
  const missing = missingDetails(invoice);
  // An incomplete three-way match is completed by the details it lacks, or, for a missing purchase order, by marking
  // the counterparty as paid without them (three-way match design M7).
  const matchIncomplete = rule === MATCH_INCOMPLETE;
  const fixable = step?.fix && canFix && (invoice.counterpartyId || !step.fix.path.startsWith("/counterparties"));
  const fix = fixable && (!matchIncomplete || missing?.poReference) ? step.fix : null;
  // What code stopped it on comes first: details would not change that decision, unless they are what it lacked.
  const offerDetails = canAddDetails && missing !== null && (step === null || matchIncomplete);
  // An owner or admin revokes a request out (ER6); the line itself is for anyone who sees the card.
  const request = documentRequest ? <DocumentRequestLine orgSlug={orgSlug} vendorName={invoice.counterpartyName} view={documentRequest} canRevoke={canFix} /> : null;
  if (!offerDetails && !fix && !canDecide && !added) return request;
  const detailsPrompt = offerDetails
    ? addDetailsPrompt(missing) + (matchIncomplete && fix ? ` Or, if ${invoice.counterpartyName} is paid without purchase orders, mark it so.` : "")
    : null;
  const sentence = added
    ? addedDetailsSentence(added)
    : matchIncomplete && detailsPrompt
      ? detailsPrompt
      : step
        ? step.sentence
        : (detailsPrompt ?? WAITING_FOR_A_DECISION);
  const suggestedPo = documentRequest?.state === "answered" ? documentRequest.poReference : null;

  const row = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-ink-2">{sentence}</p>
      {(offerDetails || fix || canDecide) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {offerDetails && <AddDetailsDialog orgSlug={orgSlug} payable={invoice} variant="primary" suggestedPo={suggestedPo} />}
          {fix && (
            <Button asChild size="sm">
              <Link href={orgHref(orgSlug, fix.path)}>{fix.label}</Link>
            </Button>
          )}
          {canDecide && (
            <Button asChild size="sm" variant="secondary">
              <Link href={orgHref(orgSlug, `/approvals#${approvalAnchor(invoice.id)}`)}>
                Decide in Approvals
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
  return request ? (
    <div className="space-y-3">
      {request}
      {row}
    </div>
  ) : (
    row
  );
}
