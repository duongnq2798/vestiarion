import { screenCounterparty } from "./compliance";
import { currentOrgId } from "./context";
import { db } from "./dal";
import { appendLedgerEntry } from "./ledger";

/**
 * Not this person (docs/superpowers/specs/2026-10-01-dismiss-screening-match-design.md): a person who
 * reviewed a counterparty's screening match dismisses it as not the same person. The dismissal holds
 * for that counterparty, that matched entity and the name screened (R2); it is signed in the ledger
 * with the reason (R3); and the counterparty is screened again at once, so a namesake no longer cuts
 * its payment limit. Runs inside the workspace's scope; the action checks who may (R1).
 */

export type DismissalErrorCode = "invalid" | "not_found" | "stale" | "already";

const MESSAGES: Record<DismissalErrorCode, string> = {
  invalid: "Say why it is not the same person, in 3 to 280 characters.",
  not_found: "Counterparty not found.",
  stale: "This counterparty's screening changed after this page loaded. Check the new match and try again.",
  already: "That match was already dismissed for this counterparty.",
};

export class DismissalError extends Error {
  constructor(readonly code: DismissalErrorCode) {
    super(MESSAGES[code]);
    this.name = "DismissalError";
  }
}

/** "Dương Trung Quốc matched at 0.909 (role.pep, role.pol)" → the caption and the score the verdict recorded. */
function readMatch(notes: string | null): { caption: string | null; score: number | null } {
  const found = notes ? /^(.*) matched at ([0-9.]+)/.exec(notes) : null;
  if (!found) return { caption: null, score: null };
  const score = Number(found[2]);
  return { caption: found[1], score: Number.isFinite(score) ? score : null };
}

export async function dismissScreeningMatch(input: {
  actorId: string;
  counterpartyId: string;
  matchedEntityId: string;
  reason: string;
}): Promise<{ name: string; rescreened: boolean; riskLevel: string; paymentLimit: number | null }> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 280) throw new DismissalError("invalid");

  const found = await db()
    .from("counterparties")
    .select("id, name, risk_level, risk_notes, risk_entity_id")
    .eq("id", input.counterpartyId)
    .maybeSingle<{ id: string; name: string; risk_level: string; risk_notes: string | null; risk_entity_id: string | null }>();
  if (found.error) throw new Error(found.error.message);
  const counterparty = found.data;
  if (!counterparty) throw new DismissalError("not_found");
  // The page named the match it showed; if the verdict has moved on since, nothing is recorded (R4).
  if (!counterparty.risk_entity_id || counterparty.risk_entity_id !== input.matchedEntityId) throw new DismissalError("stale");

  const match = readMatch(counterparty.risk_notes);
  const inserted = await db().from("screening_dismissals").insert({
    org_id: currentOrgId(),
    counterparty_id: counterparty.id,
    matched_entity_id: input.matchedEntityId,
    matched_caption: match.caption,
    matched_score: match.score,
    screened_name: counterparty.name,
    reason,
    dismissed_by: input.actorId,
  });
  if (inserted.error) {
    if (inserted.error.code === "23505") throw new DismissalError("already");
    throw new Error(inserted.error.message);
  }

  await appendLedgerEntry({
    actor: "human",
    domain: "compliance",
    action: "screening_match_dismissed",
    summary: `Dismissed a screening match for ${counterparty.name}: not the same person as ${match.caption ?? input.matchedEntityId}`,
    detail: {
      by: input.actorId,
      counterpartyId: counterparty.id,
      matchedEntityId: input.matchedEntityId,
      matchedCaption: match.caption,
      matchedScore: match.score,
      screenedName: counterparty.name,
      reason,
    },
  });

  try {
    const outcome = await screenCounterparty(counterparty.id);
    return { name: counterparty.name, rescreened: true, riskLevel: outcome.riskLevel, paymentLimit: outcome.newPaymentLimit };
  } catch (error) {
    // The dismissal stands; the next cycle's sweep screens the counterparty with it.
    console.error("dismiss screening match: screening again failed", error instanceof Error ? error.message : error);
    return { name: counterparty.name, rescreened: false, riskLevel: counterparty.risk_level, paymentLimit: null };
  }
}
