# A person's payment draws on the reserve, and a person's cash back stays

Date: 2026-10-05. Status: implemented on `fix/keep-cash-for-approvals`. Found on testnet-2 by the partner: Approve and
pay refused two bills with 151.85 USDC in the reserve.

## 1. The problem

At 09:05 UTC a person brought 152.21 USDC back from the USYC reserve (#1541) so two Centronex bills waiting in Approvals
could be paid. The cash back starts a cycle, so payments held for want of cash are decided at once (reserve cash back
R2). That cycle's treasury stage ran 37 seconds later. Only 2.10 USDC fell due within 7 days, so it swept 151.90 USDC
straight back into USYC (#1546). A two-approvals payment then took 2.23 USDC (#1548), leaving 0.184239 USDC. The approver
chose Approve and pay on the Centronex bills, 0.40 USDC (flagged as a possible duplicate) and 1.20 USDC (awaiting
information, due Oct 18). Both were refused: "The operating account holds 0.184239 USDC, less than this invoice."

Two gaps:

- **Approve and pay cannot draw on the reserve.** The cycle brings back what its own payments due today need (reserve
  cash back R3). A person's approval pays now, whatever the due date, and counts only the operating wallet. The treasury
  keeps cash for what falls due within 7 days, by date, and leaves flagged bills out. So a bill waiting for a person has
  no cash kept for it.
- **A person's cash back is swept again within a minute.** The cycle the cash back starts sees the cash as idle above
  the buffer.

## 2. Rulings

- **R1 — Approve and pay brings back what its payment lacks.** This applies to a person's paying approval (the only one
  needed, or the second of two) of a new USDC payment from the operating wallet, to a payee on Arc or through CCTP with
  its fee.
  - When the operating wallet cannot cover the payment and the reserve can cover the rest, the difference is brought
    back from the reserve first, rounded up to the next micro-USDC. Then it pays.
  - Nothing beyond what the payment lacks moves, but for a CCTP payout's cushion: a fifth of its fee, which is read
    again just before the burn and may have risen. A CCTP payout whose fee could not be read is not covered.
  - Not affected: a Gateway payout (paid from the Gateway balance), a EURC payable, a held milestone released from
    escrow, and a transfer already sent.
- **R2 — what cannot be covered is refused, naming both.** When the operating wallet and the reserve together cannot
  cover the payment, it is refused before anything moves: "The operating account holds X USDC and the USYC reserve Y
  USDC, less than this invoice." For a CCTP payout the sentence ends "less than this invoice and its F USDC CCTP fee."
  With no reserve, or an empty one, the refusal reads as before.
- **R3 — after the claim, before approvals are used.**
  - The redemption runs after the decision is claimed, so a second click never brings cash back twice.
  - It runs before two approvals are marked used, so a redemption that fails leaves both standing.
  - A redemption that fails gives the claim back, as any interrupted approval does, and refuses: "Nothing came back
    from the reserve: *why*. The operating account holds X USDC, less than this invoice."
  - It works while the agent is paused, as a person's own cash back does (reserve cash back R2). Nothing moves while
    payments are switched off, and the refusal says payments are off.
  - The payable is given back as it was before the claim (flagged, awaiting information or held): nothing was paid.
  - Its key is the payment's, the amount's and the reserve's as read. A redemption Arc testnet had not confirmed within
    the wait may still land: the refusal says so ("The reserve's redemption has not confirmed on Arc testnet yet, so
    nothing was paid. Try again in a minute: once it lands, the cash is in the operating wallet."), and asking again
    before anything changed finds the same redemption at Circle rather than sending a second one.
- **R4 — the ledger says so.**
  - A redemption records `cash_brought_back`, actor `human`, domain `treasury`, with `{ by, reason: "approval",
    invoiceId | milestoneId, amount, neededUsdc, operatingBalance, reserveBalance, earnMode, execution? }`, and a
    `treasury_actions` row `redeem_from_usyc`.
  - The payment's `approval_paid` or `milestone_approval_paid` entry carries `fromReserveUsdc`.
  - The person is told, for example: "Paid. 0.215761 USDC came back from the USYC reserve first." When the transfer then
    fails, they are told the cash stays in the operating wallet.
  - A redemption that did not move is recorded too: "Could not bring …", with `executed: false` and `executionNote`.
    A CCTP payout's cushion is recorded as `feeCushionUsdc`.
- **R5 — the card says so before.** On Approvals, take a payable that the stored operating balance cannot cover and the
  reserve can. Its confirmation says: "The operating wallet holds X USDC, so about Y USDC comes back from the USYC reserve
  first."
- **R6 — a person's cash back stays for 24 hours.** For 24 hours after a person's Bring cash back (`cash_brought_back`,
  reason `person`), the treasury stage sweeps nothing.
  - The written policy holds and says why.
  - Code's bounds let no sweep through, whatever the model decides: `sweepAtMost` is 0, and a model's sweep is recorded
    with `boundedByCode`.
  - The model is told until when, as `bounds.noSweepUntil`.
  - Redemptions are unaffected.
  - Cash brought back for an approval (R1) leaves with the payment, and does not count.
- **R7 — held milestones too.** A held milestone a person pays now follows R1–R4, except one whose USDC is being
  locked in escrow: its release waits for the escrow, so nothing is brought back for it.

## 3. What does not change

- The treasury buffer: it counts payables by their date, and leaves flagged ones out.
- The cycle's liquidity step (reserve cash back R3).
- What a Gateway payout needs (approval payout route P2).

## 4. Known limits

- The card reads stored balances, so it says "about". The approval reads the live balance.
- A transfer that fails after a redemption leaves the cash in the operating wallet. The next approval uses it, unless a
  treasury sweep takes it back first; a sweep takes only cash above the buffer, and only when it pays for itself.
- Two approvals at once, of two bills, each count the same operating balance. The second may then fail at Circle after
  its redemption, and its cash stays in the operating wallet. A lock per workspace around redeem-and-pay is left for
  later.
- An early-payment discount sends less than the amount, but the redemption covers the whole amount, as the funds check
  does. What is left stays in the operating wallet.
- `recentPersonCashBack` reads the ledger each cycle by action and actor. A partial index on `ledger_entries` for it is
  left for a later migration.
- R6 holds sweeps for a fixed 24 hours, whatever the person brought the cash back for.

## 5. Tests

- `tests/liquidity.test.ts`:
  - what the reserve covers, rounded up;
  - the approval's redemption, its ledger entry and treasury action;
  - a redemption that does not move;
  - the latest person's cash back within 24 hours.
- `tests/treasury.test.ts`: no sweep while a person's cash back stands, in the bounds and the written policy, and what
  the model is told.
- `tests/approvals.test.ts`:
  - brought back after the claim, then paid;
  - refused naming both balances;
  - a failed redemption gives the claim back and leaves approvals standing;
  - a first approval moves nothing;
  - the card's figure.
- `tests/milestone-decisions.test.ts`: the same for a held milestone.
- `tests/commands-payables.test.ts`, `tests/commands-milestones.test.ts`: the sentence after paying.
- `tests/control-ui.test.tsx`: the sentence before confirming.
- `tests/legal-pages.test.tsx`: the privacy page names `noSweepUntil`.
