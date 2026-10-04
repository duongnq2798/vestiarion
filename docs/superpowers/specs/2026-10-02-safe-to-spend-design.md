# Safe to spend today, and the next 30 days

Date: 2026-10-02. Status: shipped with this PR (design decided under the standing autonomy grant;
rulings below carry their cost if wrong).

## 1. Why

The console shows the wallet's balance and a 14-day forecast, but not the question an owner asks
first: how much of this can I spend without being short for what is already owed? Nor does it
show the day the wallet would run out. The agent answers that question for itself before every
sweep (`planTreasury`); the owner could not see the answer.

## 2. What it shows

- **Safe to spend today.** It starts from the operating wallet's USDC and takes off:
  - every open USDC payable leaving within 30 days;
  - every open milestone;
  - a 15% cushion on what leaves within 7 days.

  A negative figure reads "Short by …", and a callout names the first day the wallet runs short.
- **Next 30 days.** Each UTC day with money due or expected, what moves and why, and the balance
  after it. The balance is shown both without and with expected receivables.

## 3. Rulings

- **R1 — the agent's own picture of what is owed.**
  - Open payable statuses are `OPEN_PAYABLE_STATUSES`. A held payable counts, since a hold is
    unresolved, not forgiven.
  - A scheduled payable leaves on `scheduled_for`; an overdue one, today.
  - Every pending or verified milestone counts today (a verified one is payable the same day), except
    one whose USDC is already locked in escrow.
  - The cushion is the treasury's `bufferRatio` 1.15 on what leaves within 7 days.
  - Cost if wrong: the figure differs from what the agent does.
- **R2 — receivables are expected, never cash.** They appear on the days they are due and in the
  "with expected" balance, never in the figure itself.
- **R3 — USDC only.** A EURC payable is paid from the EURC balance (EURC invoices E5), so it is
  left out and counted in a line of its own.
- **R4 — no new read.** It is computed from the rows the console already loads (accounts,
  invoices), plus milestones (`listMilestones`).

## 4. Pieces

- `src/lib/cash-outlook.ts`: `cashOutlook(input)`, pure.
- `src/components/vx/CashOutlook.tsx`: `SafeToSpendPanel` and `CashCalendar`.
- The console page, and the design page with a fixture that runs short.
- The try-it guide.

## Amendment 2026-10-04: the USYC reserve counts

The treasury keeps only a cushion in the operating wallet and sweeps the rest to the USYC reserve, so a figure from the
wallet alone read 0.00 USDC in testnet-2 while 154.38 USDC sat in the reserve. The reserve comes back within seconds at
any hour, and since PR #188 the cycle brings back what payables due today and verified milestones need before it pays
them. So Safe to spend today, the next 30 days and the chats' `/today` now start from the wallet and the reserve
together; the breakdown names the reserve on its own line, and the console tile says it is included.
