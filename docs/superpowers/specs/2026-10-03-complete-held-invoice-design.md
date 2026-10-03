# Add what a held payable was missing

Date: 2026-10-03. Status: implemented on `feat/complete-held-invoice`. Decided under the standing autonomy grant.

## 1. The problem

The agent pays a payable on its own only when its three-way match is complete: a purchase order on file and the goods
or services received. Without them the policy asks for information (`request_info`, **Awaiting information**), and the
model is told the same rule. It is the most common reason a payable waits on **Approvals**: the first live customer's
100 USDC payable stopped there on Oct 1, with no purchase order.

A purchase order and a goods receipt can be entered only when the invoice is added. Once the agent has stopped on one,
the person who has the missing fact cannot give it: they can only approve the payment themselves, overriding the
agent, or reject it and enter the invoice again. The follow-up stage was written for exactly this case. It compares a
frozen invoice's facts with those its decision recorded and reopens it when "the purchase order arrived" or "the goods
were received" (`factChanges`), but nothing in the product can change those facts.

## 2. Rulings

- **R1 — who.** Owners and admins (`records.write`), who enter invoices. An approver decides payments and does not
  enter facts (maker and checker), so the card offers them no **Add details**.
- **R2 — only what is missing.** A purchase order can be added to a payable without one, and the goods can be marked
  received on one not marked so. Nothing already on file changes: no edit and no withdrawal. A request that adds
  nothing is refused (`nothing_to_add`). The PO reference is validated as at intake: trimmed, at most 100 characters.
- **R3 — when.** The payable is held, flagged or awaiting information, and no payment was sent for it
  (`payment_in_flight`, as for Reject and Return). Not while someone is deciding it (`processing`). The write is a
  compare-and-set on those statuses, and on the purchase order still being empty when one is added, so a decision or
  another person's addition in between wins, and the person is told the invoice changed (`invoice_changed`).
- **R4 — the agent decides again, by its own follow-up.** Adding details does not change the payable's status. At the
  next cycle the follow-up stage sees that the facts moved since the decision ("purchase order PO-100 has since been
  supplied", "goods have since been confirmed received"), reopens it with a signed `invoice_reopened` entry, and the AP
  stage decides it in the same cycle, every guardrail included. A cycle event, `details_added`, starts that cycle within
  seconds; a paused agent or a sandbox at its daily cap waits for its next cycle, as for every event.
- **R5 — recorded.** The ledger records `invoice_details_added` (actor `human`, domain `ap`) with
  `{ by, invoiceId, counterpartyId, added }`. It carries no `observed`, so the follow-up and the card still read the
  facts of the agent's decision from the decision's own entry. The invoice's `reviewed_by` and `reviewed_at` are set,
  so `/open` never counts a payment completed this way as settled without a person.
- **R6 — the card.** Until the agent decides again, the card says what was added since the agent stopped it and that
  the agent decides it again at its next cycle. The explanation of the decision keeps the facts the decision recorded,
  so it does not read as though the agent held a payable whose match was complete.
- **R7 — said where it shows.** The first-payment guide's Approvals step; the changelog (a new ledger action and a new
  event kind reach webhooks).
- **R8 — where the payable is seen first.** Testing showed a person opening the payable on **AP / AR**, where its
  card offered nothing to do. A waiting payable's row there now says what it needs ("Needs a purchase order and goods
  received"), or that details were added; its card asks for what is missing, offers **Add details** to an owner or
  admin, and **Decide in Approvals** to anyone who decides payments, which opens Approvals at that payable's card. A
  payable with a transfer recorded against it (`tx_ref`) is not offered **Add details** there; the server refuses it
  anyway (R3). No popup: the row and the card say it where the person already looks, on every visit, without
  interrupting one.

## 3. Rollout

Proven on 2026-10-03 in testnet-2 (live, Arc testnet), merged as #153 and #154:

- 01:59:42 UTC, #963: a payable of 0.30 USDC to Jiren (screened clear, 30 USDC limit), due that day, with no PO
  reference and nothing received. #965 (02:00:04): the model asked for information, citing the incomplete three-way
  match and two earlier 0.30 USDC payments to Jiren (a daily retainer) as a duplicate signal.
- 02:20:25, #968 `invoice_details_added` from **AP / AR**: PO-131 and goods received.
- The event cycle (#974, `events: ["details_added"]`): #971 (02:20:43) `invoice_reopened` with the changes "purchase
  order PO-131 has since been supplied" and "goods have since been confirmed received"; #972 (02:20:53) `ap_pay` by
  the model, which judged the earlier payments a separate retainer; paid through the workspace's spending-limit
  contract (`onChainLimit.verdict` allowed), transaction
  `0x79445473359bc94cad18bf896a735fec6c44d561b29bcdd409b797dd74dd1eab`, 28 seconds after the details were added.
- Jiren's performance score moved from 0.857 to 0.750 in that cycle: the earlier `ap_request_info` counts as an
  information request, as it did before this change. `invoice_details_added` is not part of that history.

Steps, for the record:

1. Merge. No migration.
2. In a live workspace, add a payable within the counterparty's limit with no PO reference and nothing received: the
   agent asks for information. On **Approvals**, **Add details**: a PO reference and goods received. Within a minute:
   `invoice_details_added`, then a cycle with `events: ["details_added"]`, `invoice_reopened` naming both changes, and
   the agent's payment on Arc testnet.
