# Payee lock (2026-10-20)

## Why

The most expensive payment fraud a small business meets is a supplier's or contractor's payout details being changed:
- FBI IC3 counted $3.05B in business email compromise losses in the US in 2025.
- AFP found 74% of organisations hit, mainly through vendor impersonation asking to change payment instructions.
- UK Finance put the average business invoice-fraud case at about £23k, with about 38% returned.

Small-business tools mostly warn and let the warning be dismissed:
- BILL does not require the vendor to confirm a bank change before paying.
- Ramp lets a red warning be skipped with a reason.

Insurers' social-engineering questionnaires (Marsh, The Hartford, SPG) ask for the same three controls:
- a callback to a contact held before the request;
- confirmation by someone other than the requester;
- the record of that check.

Vestiarion already holds every payment to a changed address until a person confirms it, and holds a first payment until
two parties stand behind the address (new payee check). The rest is missing:
- confirming records nothing about how the address was checked;
- the person who entered or asked for an address can confirm it;
- approving the payment confirms the address as a side effect;
- a changed address can be paid the moment it is confirmed;
- nothing points out an address made to look like a known one.

The payee lock closes these gaps, small and additive. Nothing changes for a workspace that leaves the lock off, except
that Confirm address now offers to record how the address was checked, and Counterparties names lookalike addresses.

Source: the market research of 2026-10-20 (private), bet 1.

## Rules

**PL1. The setting.**
- Two columns on `approval_policies` (one row per workspace, migration 0135):
  - `payee_lock boolean not null default false`;
  - `payee_lock_cooling_hours integer not null default 0`, between 0 and 168.
- An owner changes it on **Settings → Payee lock** (`approval.policy`, as the two approvals figure is).
- Each change is signed as `payee_lock_changed { by, from: { on, coolingHours }, to: { on, coolingHours } }`.
- A change is refused while a cycle runs, for the same reason the figure is: the cycle read the setting when it began.
- Before 0135 runs:
  - the setting reads as off;
  - Settings shows the panel without the switch, with a line that says it is not available yet;
  - a change attempted anyway is refused cleanly.

**PL2. A verification record on Confirm address.**

Confirm address opens a form instead of a yes/no:

| Field | Values | Required when |
|---|---|---|
| **How did you check it?** | `call` (Called them on a number we had before), `message` (Messaged them on a channel we used before), `in_person` (In person), `other` (Another way) | Lock on |
| **Contact used** | Up to 200 characters, for example "+44 20 7946 0000, from our contract" | Lock on, for call or message |
| **This contact was on file before the new address arrived** | A checkbox | Lock on, for call or message: must be ticked |
| **Note** | Up to 300 characters, plain text | Lock on, for "Another way" |

- The confirmation's signed entry `counterparty_address_confirmed` gains `verification: { method, contact, contactOnFileBefore, note }`.
- With the lock off every field is optional, and a form left empty records `verification: null`, as today.
- Text fields refuse control characters and links, as the payee's invoice number does.

**PL3. Two people (lock on).**
- The member who answers for the address may not confirm it, unless no other member may:
  - the member who typed it;
  - for an address the payee sent, the member who asked for it (`addressGiver`, new payee check N4).
- "No other member may" means `approversBesides([giver]) === 0`. Then the confirmation is allowed and recorded with
  `soloConfirmation: true`, so the record says plainly that one person did both.
- The refusal reads: "You entered or asked for this address, so someone else confirms it."
- With the lock off nothing changes. The entry records `byGiver: true` when the giver confirmed it.

**PL4. No confirmation by approving (lock on).**
- Approve and pay on a payment to an address waiting for confirmation is refused before anything is claimed: "Confirm
  {payee}'s address on Counterparties first, and record how you checked it."
- With the lock off, approving still confirms the address as before (`via: "approval"`, `verification: null`).

**PL5. Cooling-off (lock on, hours above 0).**
- A payment to a counterparty whose address changed less than the set hours ago is not made, whether or not the address
  is confirmed:
  - the agent's guardrail holds it as `counterparty.cooling_off`, naming the UTC time from which it can be paid;
  - Approve and pay refuses with the same time.
- Only an address change counts (`address_changed_at`). An address typed in when the counterparty was added never
  waits.
- The follow-up stage decides a held payable again once the time has passed. It is held, not refused, so nothing is
  lost.

**PL6. Lookalike addresses.**
- Two addresses look alike when they differ but share the first 6 and the last 4 hex digits after `0x`, the pattern
  address poisoning uses.
- On Counterparties, a counterparty whose address looks like another counterparty's, or is the same address as another
  counterparty's, shows a warning: "Looks like {other}'s address" or "Same address as {other}".
- The confirm form repeats the warning, and the confirmation records `lookalikeOf: [counterpartyId…]`.
- It never blocks: two counterparties can share a wallet on purpose.
- Only addresses on the same chain are compared. Case is ignored.

**PL7. Records and docs.**
- Ledger: the new action `payee_lock_changed`, and the new detail fields on `counterparty_address_confirmed`.
- The API changelog lists these. No `/api/v1` request body changes.
- Updated: guide "Your first payment" (payee lock section), CHANGELOG, ARCHITECTURE.

**PL8. Not in this MVP.** Each comes later, if pilots ask for it:
- the evidence pack export answering insurer questionnaires;
- reading bank details off invoice PDFs;
- an allowlist inside the spending-limit contract;
- payee-side verification.

## Design

- **`src/lib/payee-lock.ts`** (new, pure where possible):
  - `PayeeLock`, `readPayeeLock(orgDb)` (tolerant of missing columns, PL1), `changePayeeLock` (owner change, signed);
  - `parseVerification(form, lockOn)` (PL2);
  - `coolingOffUntil(changedAt, hours)` and `inCoolingOff(changedAt, lock, now)` (PL5);
  - `lookalikes(rows)` (PL6).
- **`confirmCounterpartyAddress`** takes `verification` and `lock`. With the lock on it enforces PL2 and PL3, refuses
  `via: "approval"` (PL4) and records the new detail. Errors are typed codes: `verification_required`,
  `contact_not_on_file`, `giver_confirms`, `lock_requires_confirm`.
- **Guardrails** gain an optional `payeeLock` input, evaluated right after `counterparty.address_unconfirmed`. The
  orchestrator and milestone decisions read the lock once per cycle, beside the two approvals figure.
- **Approvals** read the lock before claiming, for PL4 and PL5.
- **UI**:
  - `ConfirmAddress` becomes a dialog with the form;
  - the address row shows lookalike warnings;
  - `PayeeLockPanel` on Settings sits under Two approvals.

## Tests

- **Unit:**
  - lookalikes: same, alike, different chain, case;
  - verification parsing: each method, the lock on and off, links and control characters refused;
  - cooling-off times.
- **Platform tests with the fake Supabase:**
  - confirm with the lock on and off;
  - the giver refused, a solo confirmation, verification required;
  - approval refused under the lock and during cooling-off;
  - changing the setting: signed, refused during a cycle, missing columns.
- **Guardrail:** `counterparty.cooling_off`, before and after the time.
- **PGlite migration test for 0135:** columns, defaults, check constraint, idempotent re-run.
- **Components:** the confirm form's fields and required marks, the Settings panel, lookalike badges.
- **Docs:** the guide's quoted strings.

## Rollout

The partner runs migration 0135. Until then everything behaves as before. On production:
1. turn the lock on in a team workspace with a 24-hour cooling-off;
2. change a test vendor's address through a payee link;
3. confirm it with a verification record from another member;
4. check that the agent holds the payment until the cooling-off ends.

No money needs to move.
