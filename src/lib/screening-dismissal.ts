import { MATCHES_KEPT, screenCounterparty, type ScreeningCandidate } from "./compliance";
import { currentOrgId } from "./context";
import { db } from "./dal";
import { appendLedgerEntry } from "./ledger";

/**
 * Not this person (docs/superpowers/specs/2026-10-01-dismiss-screening-match-design.md): a person who
 * reviewed a counterparty's screening match dismisses it as not the same person. The dismissal holds
 * for that counterparty, that matched entity and the name screened (R2); it is signed in the ledger
 * with the reason (R3); and the counterparty is screened again at once, so a namesake no longer cuts
 * its payment limit. Runs inside the workspace's scope; the action checks who may (R1).
 *
 * A name can match many people (review every match, docs/superpowers/specs/2026-10-02-review-every-match-design.md):
 * the card lists every match the latest screening kept, and one review dismisses all the ones it listed,
 * each recorded on its own, under one reason and one signed entry. A match it did not list still counts.
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
  /** The matches the page listed, the verdict's own among them. */
  matchedEntityIds: string[];
  reason: string;
}): Promise<{ name: string; rescreened: boolean; riskLevel: string; paymentLimit: number | null; dismissed: number }> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 280) throw new DismissalError("invalid");
  const ids = [...new Set(input.matchedEntityIds)];
  if (ids.length === 0 || ids.length > MATCHES_KEPT) throw new DismissalError("stale");

  const found = await db()
    .from("counterparties")
    .select("id, name, risk_level, risk_notes, risk_entity_id, risk_matches")
    .eq("id", input.counterpartyId)
    .maybeSingle<{ id: string; name: string; risk_level: string; risk_notes: string | null; risk_entity_id: string | null; risk_matches?: ScreeningCandidate[] | null }>();
  if (found.error) throw new Error(found.error.message);
  const counterparty = found.data;
  if (!counterparty) throw new DismissalError("not_found");
  // The page named the matches it showed; if the verdict has moved on since, nothing is recorded (R4): the
  // verdict's match must be among them, and each one among the matches the screening kept (or, for a
  // verdict from before it kept them, the verdict's own match alone).
  const kept = new Map((counterparty.risk_matches ?? []).map((candidate) => [candidate.id, candidate]));
  const listed = (id: string) => (kept.size > 0 ? kept.has(id) : id === counterparty.risk_entity_id);
  if (!counterparty.risk_entity_id || !ids.includes(counterparty.risk_entity_id) || !ids.every(listed)) throw new DismissalError("stale");

  const verdict = readMatch(counterparty.risk_notes);
  const matches = ids.map((id) => {
    const candidate = kept.get(id);
    return candidate ? { id, caption: candidate.caption, score: candidate.score } : { id, caption: verdict.caption, score: verdict.score };
  });
  // The verdict's own match first, as the entry's single-match fields name it.
  matches.sort((a, b) => Number(b.id === counterparty.risk_entity_id) - Number(a.id === counterparty.risk_entity_id));
  const match = matches[0];
  const inserted = await db()
    .from("screening_dismissals")
    .insert(
      matches.map((each) => ({
        org_id: currentOrgId(),
        counterparty_id: counterparty.id,
        matched_entity_id: each.id,
        matched_caption: each.caption,
        matched_score: each.score,
        screened_name: counterparty.name,
        reason,
        dismissed_by: input.actorId,
      }))
    );
  if (inserted.error) {
    if (inserted.error.code === "23505") throw new DismissalError("already");
    throw new Error(inserted.error.message);
  }

  await appendLedgerEntry({
    actor: "human",
    domain: "compliance",
    action: "screening_match_dismissed",
    summary:
      matches.length === 1
        ? `Dismissed a screening match for ${counterparty.name}: not the same person as ${match.caption ?? match.id}`
        : `Dismissed ${matches.length} screening matches for ${counterparty.name}: not the same person as ${match.caption ?? match.id} or ${matches.length - 1} others`,
    detail: {
      by: input.actorId,
      counterpartyId: counterparty.id,
      matchedEntityId: match.id,
      matchedCaption: match.caption,
      matchedScore: match.score,
      // Every match this review dismissed, the one above first.
      matchedEntities: matches,
      screenedName: counterparty.name,
      reason,
    },
  });

  try {
    const outcome = await screenCounterparty(counterparty.id);
    return { name: counterparty.name, rescreened: true, riskLevel: outcome.riskLevel, paymentLimit: outcome.newPaymentLimit, dismissed: matches.length };
  } catch (error) {
    // The dismissal stands; the next cycle's sweep screens the counterparty with it.
    console.error("dismiss screening match: screening again failed", error instanceof Error ? error.message : error);
    return { name: counterparty.name, rescreened: false, riskLevel: counterparty.risk_level, paymentLimit: null, dismissed: matches.length };
  }
}
