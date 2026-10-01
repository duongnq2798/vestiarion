/**
 * How a milestone was verified, as the contractor stage tells the model and
 * records in the decision's observed facts: verified or not, by what method
 * (a merged pull request, a timesheet, a person here by hand), the evidence
 * link if there is one, and the verifier's note.
 *
 * The model used to get only the evidence link. A milestone a person verified
 * by hand often has none (pay a freelancer sets one up that way), and the
 * model read `verificationSource: null` as unverified and held it.
 */
export function milestoneVerification(milestone: {
  verified: boolean;
  verification_method?: string | null;
  verification_source: string | null;
  verification_detail?: unknown;
}): { verified: boolean; method: string | null; source: string | null; note: string | null } {
  const detail = milestone.verification_detail;
  const note = detail && typeof detail === "object" && typeof (detail as { note?: unknown }).note === "string" ? (detail as { note: string }).note : null;
  return {
    verified: milestone.verified,
    method: milestone.verification_method ?? null,
    source: milestone.verification_source,
    note,
  };
}
