# Plain reasoning: the agent's reasoning as a person reads it

Date: 2026-10-02. Status: shipped with this PR (design decided under the standing autonomy grant).

## 1. Why

The approval card for a held invoice read like a debug log: "Counterparty Jiren is riskLevel 'clear'…
goodsReceived is true… (earlyPayDiscount null, discountValue null)… operating balance of 49.443396
USDC… heldByOurPolicy 1 with paidWithoutIntervention 4". Measured on prod: 47 of 50 stored invoice and
milestone reasonings, and 116 of 125 treasury reasonings, contain field names, raw `null`/`true`/`false`,
or six-decimal amounts. The model writes what the prompt shows it (a JSON of camelCase facts), and the
system prompt asked it to "cite the specific facts you were given … next to the same data".

## 2. Rulings

- **R1. At the source.** Every decision prompt (AP, contractor, treasury, limit proposals) gives the model
  one rule, `REASONING_RULE`: 2 to 4 short plain-English sentences for the business owner, facts in words,
  never a field name, path, `null`, `true` or `false`, amounts to 2 decimals, dates as "Oct 2, 2026",
  only what decided it. Each response shape's `reasoning` says the same.
- **R2. One presentation layer.** `src/lib/reasoning-copy.ts` turns any stored reasoning into what a person
  reads, everywhere it is shown: decision cards (AP / AR, Contractors, Treasury), the approval card, the
  scheduled-payments list, limit proposals, and the waiting-for-you email.
  - Notes code adds in brackets (`[guardrail override: … — held for a person to approve]`) become
    sentences ("Held for a person to approve: …").
  - Plain prose is shown as written, amounts to 2 decimals and ISO days as dates.
  - Prose that reads as a log is replaced by the facts the decision recorded, in sentences
    (`explainPayable`, `explainMilestone`, `explainTreasury`): when it was due, screening and limit,
    the three-way match, funds, duplicates, what the agent decided. Only what decides a payment.
  - Where no facts are at hand (an email, the scheduled list), only the sentences that read plainly are kept.
- **R3. Nothing stored changes.** The invoice's and milestone's `agent_reasoning`, the signed ledger
  entries and the API's `agentReasoning` keep the model's words as written. Logic that reads the notes
  (the approval message, a held milestone's escrow reason) reads the stored text as before.
- **R4. Old records too.** The presentation applies to every record, whatever the model wrote then.
