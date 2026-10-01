# Payment receipts

Roadmap X3. A workspace can share a link to a receipt for a payment it made on chain. Anyone who opens the link can check three things:

- the workspace signed the receipt;
- the workspace recorded the payment in its ledger when it paid;
- the chain shows the transfer.

The receipt shows no names.

## 1. Why

Today a payee who wants proof of a payment gets a transaction hash. A hash shows that USDC moved. It does not show:

- who decided to send it;
- under what rules it was sent;
- that the payer's own record agrees.

Vestiarion already signs every decision into a hash-chained ledger, but only members can read the ledger. A receipt opens one payment to anyone the workspace chooses, without opening the ledger. The payee, an accountant or a reviewer can check it without an account and without trusting the page's own words.

## 2. Behaviour

### P1. What can be shared

- **Which payments.** A paid payable (an invoice the agent or a person paid) whose payment intent is `confirmed`, live (`provider_mode = 'live'`), and has a transaction on the payee's chain.
  - **Direct:** the transfer on Arc testnet.
  - **CCTP:** the mint on the payee's chain. A CCTP payout still waiting for its mint cannot be shared yet.
  - **Gateway:** the mint on the payee's chain.
- **What cannot be shared.** A simulated payment has nothing on chain, so it cannot be shared. Milestone payouts are out of scope for now.
- **Who can share.** An owner or admin (`records.write`). Sharing makes the payment's facts public.

### P2. The receipt entry

The first time a payment is shared, the workspace appends a ledger entry, signed and chained like any other.

```
actor "human", domain "ap", action "receipt_shared"
summary  "Receipt: 2 USDC paid on Arbitrum Sepolia"
detail   {
  receipt: {
    amount: 2, token: "USDC", paidAt: "<intent.confirmed_at>",
    payee: "<the address paid>",
    chain: "ARB-SEPOLIA",          // the chain the payee was paid on
    txHash: "0x…",                 // the transaction that paid the payee: the transfer, or the mint
    route: "direct" | "cctp" | "gateway",
    sourceTxHash: "0x…",           // CCTP only: the burn on Arc testnet
    feeUsdc: 0.107811              // CCTP and Gateway: the route's fee, from the intent
  },
  records: { seq: 580, hash: "<that entry's hash>" }
}
```

- **No names.** The detail holds no names, no reasoning and no user ids. Who shared it is kept on the receipt row instead. Because the whole body is public-safe, the page shows the entry in full, and anyone can recompute its hash and check its signature.
- **`records`.** This is the newest of the invoice's `ap_pay`, `approval_paid` and `ap_reconcile` entries whose detail contains `txHash`. If none does, it is the newest one that contains `sourceTxHash`. If no entry records the payment at all, the receipt is refused: "No ledger entry records this payment's transaction."

### P3. The link

- **Token.** A link is `/receipt/vxr_` followed by 43 base64url characters (32 random bytes). Only the SHA-256 of the secret is stored, as for payee links.
- **Shown once.** The member sees the link once, when it is made. They can copy it then.
- **One link per payment.** Making a new link replaces the old one, which stops working. This appends `receipt_link_renewed { by, receiptId }`.
- **Stop sharing.** It revokes the link (`receipt_revoked { by, receiptId }`). Sharing again later makes a new link (`receipt_link_renewed`); the receipt entry is not appended twice.
- **What a dead link shows.** A revoked, replaced or unknown link shows one sentence and names nothing: "This receipt link is no longer valid."

### P4. Keys

- The receipt row stores the public keys that verify the receipt entry and the `records` entry, as `{ keyId: pem }`. They are taken from the workspace's keyring at share time (the active key and any retired keys) and are public halves only.
- The page shows the key id beside each check. A reader can compare it with the key the workspace publishes. The audit page shows it, and `GET /api/v1/ledger/verify` names it.

### P5. The public page: `/receipt/[token]`

No session; the link is the credential. The page is `noindex` and dynamic.

**Shown.**
- The amount and token.
- When it was paid.
- The payee's chain.
- The payee's address, in full: it is on the public chain anyway, and the payee needs to recognise it.
- The route, with its fee.
- The transaction, linked to its explorer; for CCTP, the burn on Arc testnet as well.
- Three checks, each with its result:
  1. **Signed by the paying workspace.** The server recomputes the receipt entry's body hash, verifies its Ed25519 signature with the stored key named by its `signing_key_id`, and recomputes its chain hash, `sha256(prev_hash || body_hash || signature)`.
     - The browser then does the same again with Web Crypto: SHA-256 of the canonical JSON, Ed25519 verify, chain hash. It says so.
     - A browser without Ed25519 in Web Crypto says it could not check, and leaves the server's result.
  2. **Recorded when it was paid.** The server reads the `records` entry (seq and hash, within the same workspace). It checks that the hash matches, that the body hash and signature verify, and that the entry's detail contains the receipt's `txHash`, or `sourceTxHash`. That entry's content is never shown, because it has names and reasoning in it.
  3. **On chain.** The server reads the transaction's receipt from the chain's public RPC, with a 4-second timeout. It looks for a transfer to the payee of the amount, in the token:
     - **Arc testnet USDC:** a `Transfer` log from the native system address `0xff…fe` at 18 decimals, or from the ERC-20 interface `0x3600…0000` at 6 decimals.
     - **Arc testnet EURC:** from `0x89B5…D72a` at 6 decimals.
     - **Base, Arbitrum and Ethereum Sepolia USDC:** from that chain's USDC contract at 6 decimals. The sender is not checked, because for a mint it is the zero address.

     The transaction's status must be `0x1`. The results are:
     - **Matches:** with the block number.
     - **Does not match:** the transaction failed, or no transfer matches.
     - **Could not read the chain just now:** with the explorer link.
- **Check it yourself.** A collapsed section holds the canonical body, `body_hash`, `signature`, `prev_hash`, `hash`, the public key PEM, and the three formulas.

**Not shown.**
- No business, payee or person names.
- No reasoning.
- No invoice ids or user ids.

### P6. Members' view

- On **Invoices**, a paid payable that can be shared shows **Share receipt** in its card's footer, to an owner or admin.
- Pressing it shows the link once, with **Copy**, and this note: "Anyone with this link sees the amount, the payee's address and the transactions, and can check them. It shows no names."
- A shared one shows **Receipt shared**, with two actions:
  - **New link:** the old link stops working;
  - **Stop sharing**.

## 3. Rulings

- **R1. A new signed entry, not the decision entry.** The decision entry holds names and reasoning, and redacting it would break its hash. A separate entry carrying only public-safe facts is fully disclosable and fully verifiable. It also points at the decision by seq and hash, and the server proves that link.
- **R2. The trust anchor is the workspace's key, as published by Vestiarion.** The receipt stores the public key it was signed with. A forger who could write Vestiarion's database could forge both, so the page names the key id for comparison with the workspace's published key, and the chain check stands on its own.
- **R3. One link per payment, stored hashed.** It is shown once, as for payee links. Re-sharing replaces the old link. Sharing rotates the link, not the facts, so the receipt entry is appended only once.
- **R4. Live on-chain payments of payables only.** Milestones come later. A CCTP payout is shared only after its mint, because before then the payee has not been paid.
- **R5. The server checks; the browser checks the signature again.** The chain read needs RPC access and the `records` entry needs the database, so both are server-side. The receipt entry's own signature is re-checked in the browser, so the page does not only vouch for itself.

## 4. Data

Migration `0046_payment_receipts.sql` creates `payment_receipts`:

| Column | Type and constraint |
|---|---|
| `id` | uuid pk |
| `org_id` | → orgs, on delete cascade |
| `invoice_id` | → invoices, on delete cascade |
| `entry_seq` | bigint, the `receipt_shared` entry |
| `public_keys` | jsonb, `{ keyId: pem }` |
| `token_hash` | text, unique, `^[0-9a-f]{64}$` |
| `created_by` | → auth.users, on delete set null |
| `created_at` | timestamptz |
| `link_created_at` | timestamptz |
| `revoked_at` | timestamptz, null while shared |

- `unique (org_id, invoice_id)`.
- RLS `tenant_isolation`, plus the restrictive guard.
- Grants: select, insert, update and delete to `vestiarion_tenant`; all to `service_role`.
- `notify pgrst`.
- The public page reads through the service-role client, by `token_hash` with `revoked_at is null`.

## 5. Tests

- **Building a receipt.** For each kind of payment:
  - direct USDC;
  - direct EURC;
  - CCTP after its mint, and refused before it;
  - Gateway;
  - refused when simulated, unpaid, or with no entry recording it.
- **Tokens.** Format, hash, malformed tokens never looked up.
- **Server checks.**
  - **The receipt entry:** valid; tampered body; wrong signature; wrong chain hash; unknown key id.
  - **The `records` entry:** valid; hash mismatch; does not contain the transaction.
  - **The chain match:**
    - Arc native 18-decimal transfer;
    - ERC-20 6-decimal transfer;
    - a mint on Base;
    - wrong amount, wrong recipient or failed status;
    - not found, or an RPC error ("could not read").
- **Browser check.** The same verifier code run under Node's Web Crypto: valid, and tampered.
- **Actions.** Permission, live only, refusals, share then re-share, stop sharing.
- **The page view.** Renders the facts and the three checks; contains no names; a dead link shows the one sentence.
- **Migration.** The table, RLS and constraints, plus the tenancy, deletion, foreign-key and RLS inventories.

## 6. Rollout

1. The partner runs `npm run db:migrate` for 0046 before the merge.
2. In testnet-2, the partner shares the receipt of the Gateway payout to STM (Arbitrum Sepolia, mint `0x207f716e…97a9`).
3. The link opens in a private window, and all three checks pass. Record the link's entry seq here.
