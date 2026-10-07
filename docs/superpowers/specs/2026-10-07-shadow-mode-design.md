# Shadow mode

Date: 2026-10-07. Status: decided (autonomy grant 2026-10-05). Roadmap: SM1, SM2 (tameion-roadmap).

## Why

A business that is not ready to move its payments to Arc can still run Vestiarion on its real bills. It keeps paying
them as it does today, in its own currency. The agent reads the same bills and decides on each. A person agrees or
disagrees with each decision. Each payment the person agrees to is made in USDC on Arc testnet, at the bill's amount
converted to USDC. What comes out is a real business's real decisions, real Arc payments, and how often its people
agreed with the agent. When the business trusts it, a small slice moves to an Arc mainnet workspace that pays in real
USDC.

## Decisions

**S1. A switch on an Arc testnet workspace.**
- One row in a new tenant table, `shadow_modes(org_id pk, currency, started_by, started_at)`, means the workspace is in
  shadow mode. `currency` is the business's own currency (ISO 4217, three capital letters, for example VND).
- The owner turns it on or off in Settings, in a "Shadow mode" panel (permission `approval.policy`, owner only).
  Neither is allowed while a cycle runs: refused as two approvals refuses.
- Each change writes a signed entry: `shadow_mode_started` `{ by, currency }` or `shadow_mode_ended` `{ by, currency }`.
- Refused on Arc mainnet ("Shadow mode runs on Arc testnet."). On Arc mainnet the agent pays the real bills: that is the
  slice the business moves once it trusts the agent (SM5), in a workspace of its own.

**S2. The agent pays nothing on its own.**
- In shadow mode, an AP `pay` decision that passes every guardrail is held for a person:
  - status `held`;
  - `execution.heldBecause: "shadow_verdict"`;
  - reasoning ending "[shadow mode: held for a person to agree; nothing is paid until they do]".
- It is not a guardrail block. The decision passed every check, so `guardrailBlocked` stays false and the public count
  of code refusals is not inflated.
- A `schedule` decision stands as it does today. On its day the agent decides again, and that `pay` is held.
- A milestone release that passes every check is held the same way, with `heldBecause: "shadow_verdict"`. Its verdict
  control comes later; until then a person releases it on Contractors as any held release.
- The follow-up stage never reopens a payable held for a verdict. Only a person ends that hold.

**S3. A verdict on each decision.**
- A person who may decide payments (`approval.decide`) gives one verdict per agent decision entry: **Agree** or
  **Disagree**.
  - A disagreement needs a reason (at most 280 characters). An agreement may carry one.
  - The decision entry is the newest `ap_*` entry the agent wrote about the payable: `ap_pay`, `ap_schedule`,
    `ap_hold`, `ap_flag_fraud` or `ap_request_info`. `ap_reconcile` records a settlement, not a decision.
- A verdict is allowed only while the workspace is in shadow mode, and only on a decision written after shadow mode
  started.
- It is stored once:
  - in `decision_verdicts(org_id, entry_seq unique, subject 'invoice', subject_id, agent_action, verdict, reason,
    decided_by, decided_at)`;
  - and as a signed `decision_verdict` entry `{ by, entrySeq, subject, subjectId, agentAction, verdict, reason }`.
  - The entry names its payable as `subjectId`, never `invoiceId`, so the card keeps showing the decision.
- A second verdict on the same decision changes nothing and says which was given.

**S4. Agree and pay.**
- On a payable held for a verdict, the person's choices are **Agree and pay** and **Disagree**.
- **Agree and pay** records the agreement, then pays through the same path as **Approve and pay**, with every check a
  person's payment has.
- **Disagree** records the disagreement with its reason, then does what the person chose:
  - **Decide it again later** returns the payable to the agent;
  - **Do not pay it** rejects it.
- On any other decision of the agent's, the card offers **Agree** and **Disagree**. These record the verdict only; the
  payable's own actions stay where they are.

**S5. The agreement rate.**
- The rate is agreements out of all verdicts. A decision with no verdict yet counts in neither.
- The console's shadow mode panel shows: "You agreed with N of M decisions (P%)." It also shows how many decisions wait
  for a verdict.
- Each card with a verdict says "You agreed." or "You disagreed: reason".

**S6. Bills in the business's own currency (SM1b).**
- An invoice keeps the bill's own figure beside the USDC it is paid in. New columns, all set together or all null:
  - `original_currency` (ISO 4217, never USDC or EURC);
  - `original_amount` (> 0);
  - `fx_rate` (units of the bill's currency per 1 USD, > 0);
  - `fx_source`;
  - `fx_at`.
- The USDC amount is `round(original_amount / fx_rate, 2)`. `amount` and `currency` stay the USDC figure, so every
  limit, budget, approval and public number works unchanged.
- The rate comes from ExchangeRate-API's open endpoint (`open.er-api.com/v6/latest/USD`, 166 currencies, VND among them,
  daily, no key; attribution "Rates By Exchange Rate API"). A USD bill reads 1:1 ("USD = USDC").
- Only a workspace in shadow mode takes a bill in another currency. Elsewhere a foreign bill is refused as it is today.
- The reader learns VND: "₫", "đ", "VND" and "dong", and grouping such as 25.000.000.

**S7. A mirror address for a supplier with none (SM1c).**
- In shadow mode, a supplier with no Arc address gets one that Vestiarion creates for it: a wallet in the workspace's own
  Circle wallet set on Arc testnet. Its id is kept in `counterparties.mirror_wallet_id`.
- It is written through the address change with `via: "mirror"`. The new-payee check reads a mirror address as one no
  outsider could have given, because Vestiarion holds it.
- Its USDC stays in the wallet. Returning it to the operating wallet is left for later.

**S8. Proof out (SM2).**
- `npm run traction-digest -- --since YYYY-MM-DD` prints, per outside workspace in shadow mode:
  - each decision's reasoning in one line;
  - the person's verdict and reason;
  - the bill's own amount and the USDC paid;
  - the Arc testnet explorer link;
  - the agreement rate.
- It is ASCII, ready for `arc-canteen update-traction`.
- /open adds the customers' agreement rate to its outcomes.

**S9. One migration for all of it.**
- `0084_shadow_mode.sql` holds:
  - the two tables, with RLS and grants as `approval_policies` (0076);
  - the invoice columns;
  - `counterparties.mirror_wallet_id`.
- It is idempotent. The partner runs it before the first shadow PR merges, so no deployed code reads a table that is not
  there.

## Not now

- Verdicts on milestone decisions.
- Recurring bills in another currency.
- CSV and API intake in another currency.
- Returning a mirror wallet's USDC.
- A public shadow report page (SM4).

## Plan of PRs

1. **SM1a (this branch).** Covers S1–S5 and S9:
   - the migration;
   - the switch;
   - the hold;
   - verdicts;
   - Agree and pay;
   - the rate;
   - docs.
2. **SM1b.** S6: the currency, the reader, the form and the email and chat drafts.
3. **SM1c.** S7: mirror addresses.
4. **SM2.** S8: the digest and /open.
