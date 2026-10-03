# How the agent decided: a trail on every payable, and news with its reasons

Date: 2026-10-03. Status: implemented on `feat/decision-trail`. Asked for by the partner after testing agent activity
(#156): "is it too plain, what is missing?"

## 1. The problem

In the test, a payable was added at 02:48:14 and paid at 02:48:40: DeepSeek decided, the written policy agreed, and
the spending-limit contract on Arc allowed it. What a person saw:

- for those 26 seconds, the payable's row read "Not yet decided" and "The agent has not evaluated this invoice yet",
  while the agent was evaluating it;
- then "Paid Centronex 0.27 USDC.", with no word of who decided, what was checked, or how long it took;
- and nowhere, the steps in order. Every step is a signed entry in the ledger, but the audit log lists the whole
  workspace's entries, and a payable's card showed only its latest decision.

## 2. Rulings

- **R1 — a payable being decided says so.** While a cycle runs, a payable not yet decided reads **Deciding now** (an
  agent-toned badge with a turning glyph, still under reduced motion) and "The agent is deciding this invoice now…" in
  place of its reasoning. AP / AR reads whether a cycle runs as it renders, and an open page re-reads as soon as a cycle
  starts as well as when it ends.
- **R2 — every payable's card carries its trail.** **How the agent decided**, folded at the foot of the card, lists the
  signed entries about the payable, oldest first, the latest ten: who added it (from a document, by its recurring
  schedule), what a person changed, the agent taking it up again and why, each decision — who decided (the model by
  name, or the written policy) and whether the written policy agreed, what it checked (purchase order and goods,
  screening, the amount against the limit, duplicates), what code refused, the spending-limit contract's verdict —
  what reached Arc testnet with its transaction, and a person's approval or rejection. Each step shows its time to the
  second, how long after the step before it, and links its entry in the audit log. Receipts and links are not steps.
- **R3 — a link opens it.** The trail's id is `trail-<invoice id>`; a link to it opens the trail and the row around it
  (`ScrollToHash`).
- **R4 — news says why and how fast.** A toast for a decision says how long after the person's action the agent
  decided ("· 28 s after details were added", from the latest `create_invoice`, `invoice_details_added` or
  `approval_returned` before it, within an hour), who decided and whether the written policy agreed, and what was
  checked for a payment, or why it stopped: the rule's next step, or the first sentence of the model's reasoning. A
  payment's toast offers **How it decided**, which opens the trail; a stop still offers the page that handles it.
- **R5 — nothing new is stored.** The trail is read from the entries AP / AR and the console already load; the
  activity route reads the people's actions on the payables it tells about, in one more query. No migration.

## 3. Rollout

1. Merge. No migration.
2. In testnet-2, add a payable: its row reads **Deciding now** while the cycle runs; the toast says how long after it
   was added the agent decided, who decided and what was checked; **How it decided** opens its trail.
