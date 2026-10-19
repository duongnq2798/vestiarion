# A payee sends its invoice, and picks where it is paid, through its payee link

Date: 2026-10-19. Status: building. Branch `feat/contractor-invoice-link`. Migration `0133_payee_link_invoices.sql`.

## Why

Arc mainnet now pays a vendor on Base (#453, #454), and both routes were proven with real USDC. The first real customer
payment is likely to be a business paying a contractor who already holds USDC on Base. Today that business has to type
the contractor's bill in itself and choose the contractor's chain when it adds the counterparty. A payee link only
asks for an address, on a chain a member chose (CCTP payouts R6). The contractor knows both things best: its invoice
and where its wallet receives USDC. Nothing lets the contractor say either.

This makes the payee link ask for them, without an account. Everything the payee sends stays untrusted until a member
acts:
- an address waits for a person's confirmation, as today;
- an invoice waits in Bills' review queue until a member adds it;
- nothing is paid because of the link alone.

## The rules (decided here)

- **P1. Two options on a payee link.** When a member creates a payee link from a counterparty's row on
  **Counterparties**, two boxes appear under **Ask for address**:
  - **Also ask for their invoice** (`asks_invoice`): for any payee except a client.
  - **Let them choose where they are paid** (`offers_chain`): only for a vendor, and only on a network whose payee
    chains are more than one. On Arc mainnet those are Arc mainnet and Base; on Arc testnet, Arc testnet and the
    Sepolia chains. The box is also hidden when the workspace pays through a version 1 spending-limit contract, which
    pays on its own chain only.

  Both are off by default, so a link made without them works as before. Pay a freelancer, **Ask every payee** and the
  API keep making links with both off; the API does not change in this version.
- **P2. Choosing the chain.** On the link's page, when the link offers it, the payee picks where its wallet receives
  USDC, among the workspace network's payee chains, before giving the address. The chain can only be chosen when:
  - the counterparty has no address on file;
  - and no payment to it exists.

  Otherwise the page names the chain on file, as today. The address and the chain are written together, in one
  compare-and-set: the address is then new, so `address_changed_at` is stamped and every payment waits for a person
  to confirm it, as today. The payee's checklist gains one box, "My wallet receives USDC on {chain}", naming the chosen
  chain.
- **P3. The chain is part of what a person confirms.**
  - Confirming an address on **Counterparties** shows its chain beside it.
  - `counterparty_address_changed` records `chain` (and `fromChain` when it changed).
  - The new-payee check counts an address as paid before only on the same chain: a first payment on Base to an address
    paid on Arc is still a first payment.
- **P4. The invoice.** Asked after the address step, or alone when the address on file is kept. The payee gives:
  - an invoice number (up to 100 characters);
  - the amount, in USDC, more than 0 with at most 6 decimals;
  - a due date, from today to a year ahead;
  - optionally a note (up to 500 characters) and the invoice as a PDF or text file, up to 4 MB.

  The file is read for its text only, with the same reader as **From a document**, with no model call. Its text and
  SHA-256 are kept on the draft; the file itself is never stored. One invoice per link.
- **P5. Where it lands.** In `invoice_drafts`, the queue the Chrome extension already fills. The draft has
  `source = 'payee_link'`, state `sent` and the link's counterparty. It shows on **Bills**, in **Waiting for review**,
  with the payee's name and "sent through their payee link".
  - A member adds it with the existing confirm, which runs the duplicate check and adds the bill as theirs, so whoever
    adds it is "whoever entered it" and cannot approve it alone.
  - A member can also discard it. Then the agent decides the bill like any other.
- **P6. Limits.**
  - Each link accepts one invoice, enforced in the database.
  - A per-link limit in memory stops a page from hammering the reader.
  - The address step keeps its one-use claim. The invoice can be sent while the link is unexpired, or within 30 days
    after its address step, and never after a member revokes it.
- **P7. Recorded and told.**
  - `payee_invoice_submitted` is signed: actor human, `by: null`, domain compliance, with `via: "payee_link"`,
    `linkId`, `draftId`, `counterpartyId`, `amount`, `currency`, `invoiceNumber` and `documentSha256` (or null).
  - The members who decide payments get one email, "{payee} sent an invoice through their payee link". It is a
    member email, with no counterparty loop link, metered as `payee_invoice`.
- **P8. Nothing pays because of the link.**
  - An address still waits for a person's confirmation.
  - An invoice still waits for a member to add it.
  - The agent's limits, the new-payee check and the counterparty limit all still apply.
  - A milestone is still never paid across chains (mainnet Base payouts B4).

## Database (0133, additive, idempotent)

- `payee_links` gets `asks_invoice boolean not null default false`, `offers_chain boolean not null default false`, and
  `invoice_at timestamptz`.
- `invoice_drafts` changes:
  - `connection_id` becomes nullable;
  - a new `payee_link_id uuid` column;
  - the source check takes `'payee_link'`;
  - a check that `connection_id` is present unless the source is `'payee_link'`;
  - a unique index on `payee_link_id` where it is present.
- `submit_payee_invoice(...)`: definer, service role only. It locks the link and checks P6, inserts the draft (state
  `sent`) and stamps `invoice_at`, all in one transaction.
- `payee_link_status` is redefined to add `asksInvoice`, `offersChain`, `invoiceSent` and the chains the payee may
  choose.
- A new options setter, since 0039's `create_payee_link` is re-run every time and is not overloaded. The new RPCs are
  registered in `PLATFORM_RPCS`.

## What it does not do

- Read the invoice with a model when the payee sends it.
- Store the file.
- Take EURC.
- Change a chain once an address or a payment exists.
- Change the API, the SDK or the bulk request.

## Cost if wrong

- A leaked link can send one invoice and one address. Neither pays anything until a member acts on both.
- If the payee picks the wrong chain, the address still waits for a person, who sees the chain beside it before
  confirming.
