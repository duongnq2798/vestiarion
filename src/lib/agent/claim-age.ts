/**
 * When a person's decision on a payable holds it: `claim_invoice_decision` (migration 0025) marks the row `processing`,
 * and a claim that never finished may be retaken once it is old. Browser-free and pure, so the approvals library and the
 * verdicts read the same rule.
 */

/** How long a claim holds before anyone may retake it — `claim_invoice_decision`'s interval (migration 0025). */
export const RECLAIM_AFTER_MS = 10 * 60 * 1000;

/**
 * Whether `claim_invoice_decision` would let a new decision retake this row:
 * a `processing` claim whose `reviewed_at` is over 10 minutes old, or missing.
 */
export function isReclaimable(status: string, reviewedAt: string | null, now: number): boolean {
  if (status !== "processing") return false;
  if (reviewedAt === null) return true;
  const claimedAt = Date.parse(reviewedAt);
  return Number.isNaN(claimedAt) || claimedAt < now - RECLAIM_AFTER_MS;
}
