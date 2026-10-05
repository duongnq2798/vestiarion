# The three-way match, checked in code

Date: 2026-10-05. Status: designed under the standing autonomy grant (partner: "ok làm three-way match đi"); rulings
carry their cost if wrong.

## 1. Why

Week three of the research note found that the model paid or scheduled four payables with no purchase order: #1172,
#1182, #1297 and #1302. The written policy asked for information on each, and one of the model's reasons said "no
three-way match is required for this service invoice". No check in code stopped them. Every other rule the model has
broken so far was refused by code: a limit (#505), a fee cap (#686, #977).

Whether an invoice needs a purchase order is the business's rule to set, not the model's to waive.

## 2. Rulings

- **M1. The match.** A payable's three-way match is complete when its goods were received and, for a counterparty that
  needs purchase orders, a purchase order is on file.
- **M2. Purchase orders are needed by default.**
  - Migration 0073 adds `counterparties.purchase_order_required boolean not null default true`. This is the rule the
    written policy has applied all along.
  - An owner or admin (`records.write`, as for a limit) marks a counterparty "Paid without purchase orders" on
    Counterparties, or marks it as needing them again.
  - Each change is a `counterparty_purchase_orders_changed` entry: `{ by, counterpartyId, from, to }`.
- **M3. Code refuses an incomplete match.**
  - When the agent chooses to pay or schedule a payable whose match is incomplete, `enforceApGuardrails` refuses with
    `invoice.match_incomplete`.
  - The invoice goes to `awaiting_info`, as the policy's request for information does. The reasoning names what is
    missing.
  - The check runs after the address check, so a changed address still speaks first, and before the rate and the
    limit.
- **M4. One rule everywhere.**
  - The written policy asks for information on the same condition.
  - The model is told `counterparty.purchaseOrderRequired`, and its instruction names it.
  - The decision's `observed` records it.
- **M5. Relaxing it reopens what waited on it.** When a counterparty becomes "Paid without purchase orders", the
  follow-up step reopens its payables that waited for information, and the change raises a cycle event,
  `purchase_orders_waived`. Requiring purchase orders again reopens nothing: what waits still waits.
- **M6. People are unchanged.** Approve and pay in Approvals is a person's decision, and this rule binds only the agent.
- **M7. The next step says what to do.** Add the purchase order and confirm the goods with Add details in Approvals, or
  mark the counterparty as paid without purchase orders.
- **M8. Rollout.**
  - 0073 runs before the merge: the AP stage reads the new column.
  - Payables already scheduled with no purchase order are refused on their day, unless their counterparty is marked
    first.
  - Cost if wrong: some testnet-2 schedules wait for a person, as the policy said they should.

## 3. Testing

- **Guardrail:**
  - refused, as `awaiting_info`, for pay and for schedule;
  - passes with a purchase order, and with none when the counterparty needs none;
  - goods not received always refuses;
  - hold and request_info pass through;
  - the address check speaks first.
- **Follow-up:** a counterparty now paid without purchase orders reopens; the reverse does not.
- **Policy:** asks for information on the same condition.
- **Prompt:** the field and the instruction are present.
- **Migration:** the column, its default, and that existing rows read `true`.
- **Action:** permission, the write, the entry, and the event only when relaxing.
- **Privacy page:** the new field the model receives is named there.
