# Not this person: dismissing a screening match a person reviewed

Date: 2026-10-01. Status: in progress (the partner asked for it after testing Pay a freelancer;
rulings below carry their cost if wrong).

## 1. Why

Live screening sends a counterparty's name to OpenSanctions and takes the best match.

- **What went wrong:** in testnet-2 a new freelancer, "Quoc Duong", matched "Dương Trung Quốc", a
  politically exposed person, at 0.909 (ledger #634).
  - A PEP match makes a counterparty medium risk, and medium cuts the payment limit to a quarter.
  - So the 1 USDC milestone was held over a 0.25 USDC limit (#641).
- **Why it matters:** short Vietnamese names collide with public figures often, and the first real
  users are paying Vietnamese freelancers.
- **What was missing:** a person who has looked and knows it is not the same person had no way to
  say so. The only way out was to inflate the configured limit.

## 2. What it does

- **The card shows the match.** A counterparty screened medium or high on a match shows it on its
  Counterparties card: who it matched, the score, the topics.
- **Not this person.** A member who can decide approvals can choose it, give a reason, and confirm.
- **The dismissal is recorded and signed.** It is kept for that counterparty and that matched entity
  only, and the ledger signs it as `screening_match_dismissed`.
- **The counterparty is screened again at once.** Screening skips a dismissed entity and judges the
  next candidate, if any: a different person who matches still counts. With no other match, the
  counterparty is clear and its limit is whole again.
- **The agent looks again within a minute.** A `match_dismissed` cycle event follows. The follow-up
  stage reopens payables and milestones held on the old risk or limit (the follow-up reopen rule;
  F1 for milestones).

## 3. Rulings

- **R1 — who.** Only members with `approval.decide` (owner, admin, approver), the people who
  confirm addresses: dismissing a match restores payment authority.
- **R2 — what is dismissed.** One matched entity (its OpenSanctions id), for one counterparty, for
  the name that was screened. If the counterparty's name changes, the dismissal stops applying
  and the new name is screened in full.
- **R3 — a reason is required**, 3–280 characters. It is kept in the dismissal and in the ledger.
- **R4 — stale pages are refused.** The dismissal names the entity the page showed. If the
  counterparty's latest match is another one by then, it is refused and nothing is recorded.
- **R5 — high risk too.** A strong sanctions match can be a namesake as well. The dialog says the
  payment limit comes back, and the ledger keeps who decided it.
- **R6 — bundled screening has no entity ids**, so the button appears only for a live screening
  match.

## 4. Pieces

- **Migration 0051:**
  - `counterparties.risk_entity_id`, the matched entity of the current verdict;
  - the `screening_dismissals` table, tenant-scoped with RLS.
- **`src/lib/compliance.ts`:** `screenName` skips dismissed ids; `applyScreening` loads them and
  stores `risk_entity_id`; the sweep loads them once.
- **`src/lib/screening-dismissal.ts`:** the dismissal.
- **`src/app/actions/compliance.ts`:** the action.
- **`src/components/intake/ScreeningMatch.tsx`:** the match and the dialog on the card.
- **Docs:** the changelog entry for the ledger action and the event kind, and a guide note.

## 5. Rollout

1. Migrate 0051.
2. In testnet-2, choose **Not this person** on Quoc Duong with a reason.
3. Expect the risk to become clear and the limit 1 USDC.
4. Expect `screening_match_dismissed`, then the held milestone reopened and paid within a minute.
5. Record the outcome in §6.

## 6. Rollout record

(pending)
