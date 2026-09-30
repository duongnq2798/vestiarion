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
    - `address_confirmed_at` is set when a person confirms the new address.
  - **Unconfirmed** means `address_changed_at` is set and `address_confirmed_at` is null or earlier than it.
  - **Invoices.** While unconfirmed, the agent's "pay" on an invoice to that counterparty is held for review with this reasoning: "[guardrail override: the counterparty's address changed on <date> and no one has confirmed it — held for a person to approve]".
    - The check sits in `enforceApGuardrails`, after duplicate and high risk and before the limit, so the reason names the change.
  - **Milestones.** Held milestones have no approval path in the app. So instead of a hold, a verified milestone whose contractor's address is unconfirmed is skipped before the decision:
    - no model call;
    - its status stays `verified`;
    - the cycle line says "waiting for someone to confirm its new address".

    Once the address is confirmed, the next cycle decides the milestone as usual.
  - **What confirms the address:**
    - **"Approve and pay"** on a waiting invoice to that counterparty. The approval card shows the address the payment goes to, and posts it back. `approveAndPay` refuses with `address_changed` ("This counterparty's address changed after this page loaded. Check the new address and try again.") when the posted address is not the current one. That way a person never confirms an address they did not see.
    - **"Confirm address"** on the counterparty. It shows only while the address is unconfirmed, and uses `approval.decide` (owner, admin, approver). The form posts the address shown and is refused in the same way if it changed.

    Each writes a `counterparty_address_confirmed` ledger entry, `{ by, counterpartyId, address, via: "approval" | "confirm" }`.
  - **The same person may change and confirm.** Many workspaces have one member. The control is the deliberate second step, and the ledger records who did each.
  - **Why this rule:** it is the standard control against redirection. It costs one confirmation per change, and never blocks a correct payment for long.
- **E5. Screening does not change.** The address is not part of screening; the counterparty's risk is unchanged.
- **E6. The Go live panel's sentence** now points to something real. The first-payment guide gains a short "Changing an address" section.
- **E7. Concurrency.** The edit is a compare-and-set: it reads the current address, then updates `where id = … and address is not distinct from <old>`. When another edit won, it says "Someone else changed this address a moment ago." Confirming is the same kind of guarded update, on `address = <shown> and address_changed_at = <read>`.

## Data

Migration `0033_counterparty_address_change.sql` (idempotent) adds `counterparties.address_changed_at timestamptz` and `address_confirmed_at timestamptz`. The 0018 table-wide tenant grant covers both, so no function or grant is needed.

## Testing

- **Validation:** good, bad, same-as-current and cleared addresses.
- **Permissions:** the `records.write` literal, and approvers and viewers refused.
- **The ledger entry's body.**
- **The guardrail:**
  - held while unconfirmed, for both invoice and milestone payments;
  - not held after a person's approval confirms the address;
  - not held for a counterparty created with its address;
  - the order relative to the other rules: a duplicate or high risk still flags first, and an over-limit amount is still held.
- **Approve-and-pay** confirms the address, and is refused when the posted address is stale.
- **Milestones** wait while unconfirmed and are decided after.
- **PGlite:** the migration's columns, the tenant's update of its own rows only, and replay.
- **UI:** the edit dialog, and the held reason shown on the decision card.
