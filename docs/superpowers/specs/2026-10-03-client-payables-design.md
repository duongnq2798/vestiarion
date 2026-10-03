# A payable to a client waits for a person

Date: 2026-10-03. Status: implemented on `fix/client-payables-treasury-bounds`. Found while testing the agent's
reminders in testnet-2.

## 1. Why

The invoice form's **Direction** started at **Payable** whatever the counterparty. A receivable for the client "Ho
Client" was entered as a payable (#1075), and the agent decided to pay the client 0.50 USDC (#1079). Only the day's
spending limit stopped it, and the follow-up would have paid it once the limit had room again.

A client pays the business. A payable to one is nearly always an invoice entered in the wrong direction; the rare
real one is a refund, which is a person's decision.

## 2. Rulings

- **R1 — the agent never pays a client on its own.** A payable whose counterparty's role is `client` is held for a
  person, pay or schedule, with the guardrail rule `counterparty.client_payable`. It comes after the duplicate check
  and the screening verdicts, ahead of the address and the limit. The card says: "*Name* is a client: it pays you. If
  this is a refund, pay it in Approvals; if it is money *name* owes you, reject it and add it as a receivable." No
  fact change reopens it. A person may still approve it, as any hold.
- **R2 — the form follows the counterparty.** Choosing a client sets **Direction** to **Receivable**; choosing anyone
  else, **Payable**. A person can still choose otherwise. The line under **Direction** says what it means: "Money
  *name* owes you.", "Money you owe *name*.", or, for a payable to a client, that the agent never pays a client on
  its own.

## 3. Tests

`tests/client-payables.test.tsx` (the rule, its order, the next step, the form) and `tests/ap-stage.test.ts` (a
payable to a client held, nothing sent).
