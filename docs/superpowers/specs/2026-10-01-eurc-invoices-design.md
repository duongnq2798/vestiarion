# EURC invoices: pay a European vendor in the currency they bill in

Date: 2026-10-01. Status: approved for implementation (decided under the standing autonomy grant;
rulings carry their cost if wrong).

## 1. Why

A vendor that bills in euros wants euros. Today every invoice and every payment is USDC, and the
`invoices.currency` column always says `USDC`. Arc and Circle already provide what is missing:

- EURC on Arc testnet (`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`, 6 decimals), available from
  Circle's faucet;
- a Circle wallet that holds both USDC and EURC;
- Circle's Stablecoin Service, which quotes EURC↔USDC on Arc testnet. It needs no key: on
  2026-10-01, 10 EURC was quoted at 12.161872 USDC, through a LiFi route.

After this change, an invoice can be in EURC. The agent pays it in EURC from the workspace's
wallet, and checks it against the counterparty's USDC limit at a quoted rate that the signed
decision records.

## 2. Behaviour

- **E1: currency on an invoice.** An invoice is in `USDC` or `EURC`. The form, CSV import and API
  accept the currency and default to USDC. A receivable may be EURC too; the agent decides
  payables only.
- **E2: the rate.** The USDC value of an EURC amount comes from a Stablecoin Service quote for that
  amount, EURC→USDC on `Arc_Testnet`. The quote is a GET, needs no key, and gives an estimated and
  a minimum output.
  - The guardrails use the **estimated** output.
  - Quotes are kept in process for 5 minutes per amount bucket.
  - The decision's ledger detail records the rate, the source (`circle-stablecoin-quote`) and the
    quote time.
- **E3: limits stay in USDC.** An EURC payable's USDC value is what counts against the
  counterparty's payment limit and against the duplicate and high-risk rules.
- **E4: no quote, no payment.** With no quote (timeout or no route), the payable is held for a
  person with `guardrailRule: "fx.rate_unavailable"`. A person may still approve and pay it, and
  the approval card shows the EURC amount.
- **E5: paid in EURC from EURC.** The transfer is EURC from the operating wallet: Circle
  `createTransaction` with the EURC token id, which is resolved from the wallet's own token list.
  - The EURC balance is read from the chain at decision time.
  - If it is short, the payable is held with `guardrailRule: "treasury.insufficient_eurc"`.
  - The agent never pays an EURC invoice with USDC.
- **E6: a record per token.**
  - `payment_intents.token` records USDC or EURC.
  - Open numbers count USDC only in "USDC paid" and in the wallet total. An EURC payment is still a
    payment settled on Arc testnet.
  - The payment's amount is in its own token everywhere it is shown.
- **E7: sandbox.** A sandbox simulates payments, and a simulated EURC payment behaves like a
  simulated USDC payment. A sandbox has no EURC balance to check, so E5's balance check applies to
  live workspaces only.

**Stretch (after the above):** when EURC is short and USDC is not, the agent may decide to swap
through the Stablecoin Service. The service answers `POST /v1/stablecoinKits/swap` with the
transaction to run, which goes through Circle `createContractExecutionTransaction`. The swap is a
decision of its own, with its reasoning and the rate it got.

## 3. Phases

The payment path (`orchestrator.ts`'s AP stage, `pay.ts`, `guardrails.ts`, `approvals.ts`,
`intake-validation.ts`) is being rewritten by the payment-timing branch (A1). To keep one of the
two changes from overwriting the other:

- **Phase 1, now.** Only pieces A1 does not touch:
  - `src/lib/fx/quote.ts`, the Stablecoin Service quote, its timeout and its cache;
  - `src/lib/circle/*` token support: `TransferParams.token`, `getTokenBalance(accountId, token)`,
    the EURC token id resolved per wallet, and the simulate provider's parity for EURC;
  - the migration `0040_eurc.sql`, with the currency check, `payment_intents.token`, and
    `open_numbers` counting USDC only.
- **Phase 2, after A1 merges.**
  - Currency in intake, CSV and API.
  - The AP stage's currency-aware guardrails and EURC payment, through
    `PayInvoiceInput.currency`, as agreed with A1.
  - Approvals, the UI, the docs and the changelog.

## 4. Rulings

- **R1: the Stablecoin Service quote is the rate.** It is Circle's own Arc testnet market and needs
  no key. A testnet pool's price is not the EUR/USD reference rate (about 1.22 here, against about
  1.1 in the market), and the ledger names the source so no one mistakes one for the other. Cost if
  wrong: limit checks follow a testnet pool.
- **R2: hold, never guess.** No quote means no automatic payment (E4). Cost if wrong: a held payable
  a person approves.
- **R3: no new accounts row for EURC.** The EURC balance is read live when needed. The treasury,
  the sweep and every total stay USDC-only, so no USDC figure can quietly include euros. Cost if
  wrong: the console shows no EURC balance until a follow-up adds a tile.
- **R4: one PR.** Phase 1 waits on the branch for Phase 2, so nothing unused ships. The provider
  files and the migration do not conflict with A1. Cost if wrong: none.

## 5. Tests

- **Quote:**
  - it parses estimated and minimum amounts;
  - an amount goes to base units and back;
  - timeout;
  - no route;
  - a malformed answer;
  - the cache window;
  - it asks for EURC→USDC on Arc_Testnet with `toAddress` and `tokenOutChain`.
- **Providers:**
  - an EURC transfer uses the EURC token id from the wallet's list;
  - a missing EURC token is a clear error ("fund EURC first");
  - `getTokenBalance` reads each token;
  - USDC stays the default;
  - the simulated EURC transfer.
- **Migration (PGlite):**
  - the currency check;
  - the `payment_intents.token` default and check;
  - `open_numbers` keeps EURC payments out of "USDC paid" but counts them as payments.
- **Phase 2:** each guardrail rule (limit at the rate, no quote, EURC short), the payment carries
  `token: "EURC"`, the decision detail carries the rate, and the approval card shows EURC.

## 6. Rollout

1. The partner runs `npm run db:migrate` (0040).
2. In testnet-2, fund the wallet with EURC from Circle's faucet.
3. Add an EURC payable to a counterparty with an address, then watch the event cycle pay it in
   EURC on arcscan.
4. Record the result here.

## 7. Rollout record

(pending)
