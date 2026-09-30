# Editing a counterparty's address, with the next payment held for a person

A counterparty's Arc address can only be set when the counterparty is added; nothing in the app edits it. A typo means adding the counterparty again, and a counterparty added without an address (the form says "Optional until payment setup") can never be given one. The Go live panel already tells owners to "Set each one's Arc testnet address on the Counterparties page", so the product promises a feature that does not exist.

Editing a payee's address is also the classic payment-redirection fraud: change the address, and the next payment goes to the wrong wallet. So the edit comes with a guardrail.

Decided on 2026-09-30 by the implementer under the partner's standing instruction.

## Decisions

- **E1. Who.**
  - Owners and admins (`records.write`, the permission that already adds counterparties) can set or change a counterparty's address from the Counterparties page, with an "Edit address" action on each counterparty.
  - Approvers and viewers see the address only.
- **E2. Validation.**
  - An Arc (EVM) address is `0x` followed by 40 hex characters. Whitespace is trimmed.
  - The same value as the current address is refused with "That is already this counterparty's address."
  - Clearing an address is allowed, and its payments are then held as today.
- **E3. The ledger records every change.**
  - The entry is `counterparty_address_changed` with `{ by, counterpartyId, from, to }`.
  - A counterparty's address is business payment data, not a person's contact details, and an auditor needs to see where money was redirected, so both addresses are recorded.
- **E4. The guardrail `counterparty.address_unconfirmed`.**
  - **The columns:**
    - `counterparties.address_changed_at` is set by every edit. It is not set when the counterparty is created with its address.
    - `address_confirmed_at` is set when a person approves a payment to that counterparty.
  - **When it holds:** while `address_changed_at` is not null and `address_confirmed_at` is null or earlier, every agent payment to that counterparty is held for review with this reasoning: "the counterparty's address changed on <date>; a person approves the first payment to the new address".
    - This applies to AP invoices and to contractor milestones.
    - The check sits in `enforceApGuardrails`, and in the milestone guardrail if there is a separate one, after duplicate and high risk and before the limit.
  - **What confirms the address:** a person's "Approve and pay" on such a payment confirms it, and later payments are decided normally. So does "Pay now" on a held payment.
  - **Why this rule:** it is the standard control against redirection. It costs one approval per change and never blocks a correct payment for long.
- **E5. Screening does not change.** The address is not part of screening; the counterparty's risk is unchanged.
- **E6. The Go live panel's sentence** now points to something real. The first-payment guide gains an "Edit address" step with its screenshot.

## Data

Migration `0033_counterparty_address_change.sql` (idempotent):
- adds `counterparties.address_changed_at timestamptz` and `address_confirmed_at timestamptz`;
- adds a function `change_counterparty_address(p_counterparty_id uuid, p_address text, p_by uuid)` with the tenant role's grants, following the existing tenant RPC pattern (`claim_invoice_decision`). It updates the address and `address_changed_at` in one statement, scoped to the caller's org by RLS, and returns the old address for the ledger.

## Testing

- **Validation:** good, bad, same-as-current and cleared addresses.
- **Permissions:** the `records.write` literal, and approvers and viewers refused.
- **The ledger entry's body.**
- **The guardrail:**
  - held while unconfirmed, for both invoice and milestone payments;
  - not held after a person's approval confirms the address;
  - not held for a counterparty created with its address;
  - the order relative to the other rules: a duplicate or high risk still flags first, and an over-limit amount is still held.
- **Approve-and-pay** sets `address_confirmed_at`.
- **PGlite:** the migration, the function's scoping, and the grants.
- **UI:** the edit dialog, and the held reason shown on the decision card.
