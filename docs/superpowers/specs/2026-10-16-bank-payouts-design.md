# Pay a vendor to a bank account, through BlindPay

Date: 2026-10-16. Status: decided (autonomy grant 2026-10-05; the partner chose F25 on 2026-10-16 and left the order to
me). Roadmap: F25, "partner fiat payout for one corridor". Builds on CCTP payouts (`2026-10-01-cctp-payouts-design.md`,
X1–X11), the payout route (`2026-10-05-approval-payout-route-design.md`, P1–P5) and the new payee check
(`2026-10-05-new-payee-check-design.md`). Rulings carry their cost if wrong.

## 1. Why

A vendor who cannot or will not hold USDC is the first thing that stops a small business paying it with Vestiarion.
Its treasury is USDC on Arc; the vendor wants pesos in a Mexican bank account. A payout partner closes the gap: the
business pays USDC, the partner pays the vendor's bank in local currency, and the agent and a person see what the vendor
will actually receive before anything moves.

## 2. The partner, as of October 2026

Compared on 2026-10-16 (BlindPay, Conduit, Bridge, Noah, Mural, Circle Payments Network, Circle Mint and others):

- **Circle Payments Network** supports Arc and has quotes, encrypted beneficiary data and webhooks, but is for
  institutions, after Circle's eligibility review. **Circle Mint** pays fiat to the account holder's own linked bank
  only; third parties only on chain. Neither can pay a vendor's bank from a self-serve sandbox today.
- **BlindPay** lists Arc for payouts (USDC on Arc mainnet; its USDB test token on Arc testnet), lets a business pay a
  third party's bank account (`recipient_relationship` other than `first_party`), quotes an exact rate and fees that hold
  5 minutes, signs its webhooks (Svix format), takes an `Idempotency-Key` on every POST, and opens a development instance
  at once, free, with KYB approved automatically and outcomes forced by amount (666.00 fails, 777.00 refunds).

BlindPay is the partner. Its model: the paying business is a **customer** (`re_…`) that accepted BlindPay's terms and
passed KYB; each vendor's account is a **bank account** (`ba_…`) on that customer; a **quote** (`qu_…`) names the token
contract and the BlindPay contract to approve; an **EVM payout** (`po_…`) spends the approved amount from the sender's
wallet and pays the bank.

## 3. Decisions

**B1. One corridor: USDC to MXN over SPEI, for a vendor's bill.** A vendor's payable in USDC may be paid to the vendor's
Mexican bank account (CLABE) instead of an address. Milestones stay on Arc, as for every other route (0044). EURC is not
paid to a bank in this version.

**B2. On only with the partner.** `BLINDPAY_API_KEY` and `BLINDPAY_INSTANCE_ID` turn it on; `BLINDPAY_WEBHOOK_SECRET`
(`whsec_…`) lets the webhook in. Without them no card, no form, no route, and the webhook answers 404. The network is the
workspace's: `arc_testnet` (token USDB, a development instance) for Arc testnet, `arc` (token USDC) for Arc mainnet.
`BLINDPAY_NETWORK` and `BLINDPAY_TOKEN` override them, for a development instance BlindPay serves on another testnet.

**B3. The workspace's BlindPay customer.** On Settings, **Bank payouts**, an owner:
1. opens BlindPay's terms (a URL BlindPay makes, accepted on BlindPay's own page, which sends the owner back with a
   `tos_id`), then
2. sets the workspace up: Vestiarion creates the BlindPay business customer with that `tos_id`.

In this version the business details sent are BlindPay's test values, on a development instance only: BlindPay
approves a development customer whatever the documents, and real KYB (documents, owners) is BlindPay's own production
review, not built here. Vestiarion keeps the customer id, its KYB status and when it was set up; never a document or a
person's details. Cost if wrong: a production instance needs the KYB form this version does not have.

**B4. A vendor's bank account.** On a vendor's counterparty card, an owner or admin adds **Bank account in Mexico
(SPEI)**: the beneficiary's name and the 18-digit CLABE, checked by its control digit before anything is sent. It goes to
BlindPay at once as a third-party account (`recipient_relationship: vendor_or_supplier`). Vestiarion keeps BlindPay's
`ba_…` id, the CLABE's bank code and last four digits, the beneficiary's name, its status, who added it and when; never
the whole CLABE. Once added, the vendor is paid to the bank: the card says so, and its address is not used. Removing the
bank account pays the address again. Adding or replacing one is recorded (`counterparty_bank_account_set`).

**B5. What the vendor will receive, before anything moves.** For a payable to a bank, the Approvals card reads a quote
for the invoice amount and shows the pesos the vendor receives, the rate, BlindPay's fees, and that the quote is
indicative until Approve and pay asks for a fresh one. A quote that cannot be read says so; nothing is guessed.

**B6. A person approves every bank payout in this version.** A payment to a bank leaves through a partner and a bank
rail, and cannot be called back once BlindPay has it. So code holds the agent's decision to pay a bank payout
(`payout.bank_needs_person`), whatever the model says, as the 10% fee cap holds a bridge. The agent still decides
*whether* and *when*; the person confirms the money and the rail. Cost if wrong: one click per bank payout.

**B7. Approve and pay, to a bank** (the provider's `bank` route, as `cctp` is):
1. a fresh quote for the invoice amount (`currency_type: sender`, `cover_fees: false`: the business pays the invoice
   amount exactly, and fees come out of the pesos), refused when its sender amount is not the invoice's;
2. `approve(BlindPay contract, amount)` on the quote's token, from the operating wallet, through Circle's contract
   execution, under a UUID derived from the payment attempt's key and the step (Circle takes only UUIDs);
3. `POST /payouts/evm` with the quote and the operating wallet's address, under `Idempotency-Key` derived from the
   attempt's the same way, so a retried attempt never creates a second payout.

The payment intent's provider id is `blindpay:<payout id>`; its route `bank`. The quote carries no key: it moves
nothing, so a try after one expired gets a new one. The approve and the payout keep the attempt's keys, so a payout
whose answer was lost, or whose key BlindPay already holds, stays in flight and is asked for again under the same key,
never looked for on Circle.

**B8. In flight, then paid.** A created payout is `pending`: the invoice is **Payment in flight**. Reconciliation reads
the payout from BlindPay by id: `completed` is paid, with BlindPay's transaction hash; `failed` and `refunded` are failed,
with BlindPay's reason, and the invoice goes back to the person. `refunded` reads as Circle's `FAILED`, so a person's
Approve and pay opens a new attempt; `failed` does not, since BlindPay still holds the USDC. A webhook (`payout.update`, `payout.complete`) only
starts that read: what it says is never used as it is (the HubSpot and Pipedrive rule). BlindPay does not refund a failed
payout by itself: the card says to contact BlindPay, and the ledger keeps the payout id.

**B9. The webhook.** `POST /api/integrations/blindpay/webhook` checks the Svix signature (`svix-id`, `svix-timestamp`,
`svix-signature`, HMAC-SHA256 under the secret after `whsec_`, a 5-minute window) in constant time before reading the
body, answers at once, and for a payout reconciles the payment intent that names it. `tos.accept` and
`customer.update` refresh the workspace's customer status.

**B10. The ledger.** `approval_paid` carries `payout: { route: "bank", provider: "blindpay", rail: "spei", currency:
"MXN", receiverAmount, rate, feesUsdc, quoteId, payoutId, bankAccount: { bankCode, last4 } }`. The reconcile entry carries
BlindPay's status and transaction hash. `counterparty_bank_account_set` and `bank_payouts_set_up` are new actions
(changelog).

**B11. Migration 0124.** `workspace_payout_partners` (one per workspace: provider, customer id, `tos_id`, KYB status),
`counterparty_bank_accounts` (one active per counterparty), `payment_intents_payout_route_check` taking `bank` (only
while it does not yet), and `bank_payouts_ready(p_org_id)`. Additive and re-runnable.

**B12. Plain words.** The card: "Paid to a bank account in Mexico: BBVA ····1234, Ana López." The approval: "Ana López
receives about 1,812.40 MXN (rate 18.39 MXN per USDC, BlindPay's fees 2.10 MXN). The quote is fresh when you approve."
In flight: "With BlindPay, on its way to the bank." Failed: "BlindPay could not pay the bank: <reason>. Nothing more
leaves; contact BlindPay about the USDC it holds."

## 4. Not in this version

Production KYB (documents and owners), other corridors (US ACH, SEPA, Pix), a vendor entering its own bank details
through a payee link, EURC to a bank, milestones to a bank, the agent paying a bank without a person, partner fees.

## 5. Testing

- Pure: the CLABE check, the quote and payout mapping, `expires_at` in seconds or milliseconds, the Svix signature
  (good, wrong, stale, missing), the hold rule.
- The client against a recording fetch: auth, idempotency keys, the quote, the payout, errors in BlindPay's shape.
- The provider's `bank` route against a fake Circle client and a fake BlindPay: approve then payout, each under its
  derived key; a sender amount that is not the invoice's refused before anything is sent; reconcile to paid, to failed.
- The migration on PGlite: the tables, one active bank account per counterparty, the route check, tenancy.
- The card, the counterparty form and the Approvals card with sample data.
- Live: a development instance, a vendor with a test CLABE, a 5.00 payable paid, a 666.00 one failed.

**B13. Test USDB on Arc testnet** (added after the first live check). A development instance takes USDB, BlindPay's
test token, not USDC; on Arc testnet it is `0x83cD7E0a1e8ae37eC75842544d77E190F386B73A`, 18 decimals, and anyone may
mint it to themselves with `mintUSDB(uint256)`. BlindPay's dashboard mints only to a browser wallet, so the Bank
payouts card has **Mint 100 test USDB**: the operating wallet mints to itself through Circle's contract execution
(Arc testnet only, ledger `bank_payouts_test_token_minted`). Approve and pay counts the operating wallet's USDC only
when BlindPay takes USDC; `payToBank` reads the quote's token balance on chain before the approve and sends nothing
when it falls short. Circle takes only UUID idempotency keys, so each step's key is a UUID derived from the attempt's.
