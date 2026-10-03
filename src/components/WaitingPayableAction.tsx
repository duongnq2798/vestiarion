import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { AddDetailsDialog } from "@/components/AddDetailsDialog";
import { Button } from "@/components/ui/Button";
import { addDetailsPrompt, addedDetailsSentence, missingDetails, type AddedDetails, type OnFile } from "@/lib/added-details";
import { approvalAnchor, orgHref } from "@/lib/auth/org-paths";

/** What the card says when the payable lacks nothing a person can add here: it waits for a decision. */
export const WAITING_FOR_A_DECISION = "Waiting for a person's decision.";

/**
 * What a person can do about a payable that waits for them, in its card on Invoices (complete held invoice): an owner
 * or admin adds the purchase order or goods receipt it lacks, right there, and anyone who decides payments opens it in
 * Approvals, at its card. Once details were added, it says so until the agent decides the payable again. A viewer,
 * who can do neither, sees nothing unless details were added.
 */
export function WaitingPayableAction({
  orgSlug,
  invoice,
  added,
  canAddDetails,
  canDecide,
}: {
  orgSlug: string;
  invoice: { id: string; counterpartyName: string } & OnFile;
  /** What a person added since the agent's decision; null when nothing was. */
  added: AddedDetails | null;
  /** An owner or admin, on a payable with no transfer recorded against it. */
  canAddDetails: boolean;
  /** An owner, admin or approver. */
  canDecide: boolean;
}) {
  const missing = missingDetails(invoice);
  const offerDetails = canAddDetails && missing !== null;
  if (!offerDetails && !canDecide && !added) return null;
  const sentence = added ? addedDetailsSentence(added) : offerDetails ? addDetailsPrompt(missing) : WAITING_FOR_A_DECISION;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-ink-2">{sentence}</p>
      {(offerDetails || canDecide) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {offerDetails && <AddDetailsDialog orgSlug={orgSlug} payable={invoice} variant="primary" />}
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
}
