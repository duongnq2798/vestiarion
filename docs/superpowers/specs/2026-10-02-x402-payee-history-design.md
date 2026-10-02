# The agent buys what it needs to know: payee history over x402

Date: 2026-10-02. Status: shipped with this PR (design decided under the standing autonomy grant;
the partner chose option b of the A9 spike). Roadmap A9.

## 1. Why

Before the agent pays an Arc address for the first time, it knows only what this workspace knows:
the counterparty's name, screening and limit. Whether other businesses have paid that address
before is a strong signal against a fresh, mistyped or swapped address, and only a network of
payers has it.

Vestiarion has that network, so it sells the answer per call over **x402**, the HTTP 402 payment
standard, settled through **Circle Gateway nanopayments** on Arc testnet. A workspace's agent buys
it, from a small service budget a person gave it, before a first payment to an address.

The spike (A9, 2026-10-01) found no third-party x402 seller that accepts Arc testnet: the
marketplace services take only mainnet USDC. So Vestiarion is both the seller and, through a
workspace, the buyer. That is the weakness of this design, and it is stated where the feature is
described.

## 2. What it does

- **Seller.** `GET /api/x402/payee-history?address=0x…` answers `402 Payment Required` with an
  x402 offer: 0.001 USDC on Arc testnet (`eip155:5042002`), scheme `exact`, Gateway batching
  (`GatewayWalletBatched` on GatewayWallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`). Paid,
  it returns the address's history across Vestiarion: how many workspaces paid it, how many
  confirmed payments, the first and last. Circle's facilitator verifies and settles each payment.
- **Buyer.** A new cycle stage, `services`, runs before `ap`. For a counterparty about to be paid
  for the first time at its address, the agent buys that address's history and gives it to the
  model with the payment's other facts. Code does not act on it; the model weighs it.
- **The service budget.** A person adds USDC to the agent's service budget on Treasury. The
  operating wallet deposits it into Gateway for the workspace's Gateway signer, in one
  `executeBatch` of `approve` and `depositFor`. The agent pays only from that balance.

## 3. Rulings

- **R1 — what is sold.** For an address: `workspacesPaid` (distinct workspaces with a confirmed
  live payment to it), `paymentsConfirmed`, `firstPaidAt`, `lastPaidAt`, and `asOf`. No amounts
  and no workspace names. Only live payments count. Payments on Arc are public; what the answer
  adds is that the payers were Vestiarion workspaces, in aggregate. The privacy page says so.
- **R2 — price and payee.** 0.001 USDC a call, paid to Vestiarion's own workspace's operating
  wallet (`0x2fafddA3F973e8f993911F1c2196d5E72D51d71d`, workspace `founding`). Its Gateway
  balance holds the revenue.
- **R3 — when the agent buys.** All of the following:
  - a payable or milestone of the counterparty awaits a decision this cycle;
  - the counterparty has an Arc address, and no change to it awaits confirmation;
  - this workspace has never had a confirmed payment to that address;
  - it bought no history for that address in the last 7 days. A purchase answers for 7 days.
- **R4 — the agent's purse.** The buyer is the workspace's Gateway signer, a Circle EOA; Gateway
  verifies x402 signatures with `ecrecover`, so a smart account cannot buy. It signs the EIP-3009
  `TransferWithAuthorization` through Circle's `signTypedData`; Circle holds its key. It pays
  from its own Gateway balance, which only a person fills. The agent never moves money into it.
- **R5 — code's bounds on every purchase.** A purchase is refused, and the refusal signed, when:
  - the seller is not Vestiarion's own endpoint (the allowlist);
  - the offer is not USDC on Arc testnet through GatewayWallet, or pays anyone but R2's wallet;
  - the price is above 0.01 USDC;
  - the day's purchases would pass 0.05 USDC (UTC day);
  - the purse holds less than the price.

  At most 3 purchases are made in one cycle. A purchase that fails is signed too, and the payment
  is decided without the history.
- **R6 — the decision.** The AP and contractor prompts carry `addressHistory` for the counterparty
  when a purchase answered within 7 days, as do the decisions' `observed` facts. When none did,
  the field is absent and the decision is made as before.
- **R7 — records.** Each purchase is a row in `service_purchases` and a signed ledger entry:
  `service_purchased`, `service_purchase_refused` or `service_purchase_failed` (domain
  `compliance`). A sale is a row in the platform table `x402_sales`. Funding the purse is
  `service_budget_funded` (domain `treasury`).

## 4. Data

Migration `0058_x402_services.sql`:

- `service_purchases`, tenant-scoped like the other workspace tables.
- `x402_sales`, platform only: no tenant access.
- `payee_history(p_address text)`, security definer, service role only: R1's aggregate.

## 5. Proof

Done when, in production, the testnet-2 agent buys an address's history with a real Gateway
nanopayment before a first payment, and the purchase and the decision that used it are signed.
