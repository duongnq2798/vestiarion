# ENS names and Basenames in an address field

Date: 2026-10-22. Status: accepted.

## Why

A payee often gives a name rather than an address: `northwind.eth`, or a Basename such as `jesse.base.eth` on Base.
Today the address field refuses anything but `0x` and 40 hex characters. So someone looks the name up elsewhere and
pastes what they find, a step where a lookalike address slips in. Looking it up in the field, and saying when a name
does not look like the payee's, makes the check part of entering the address.

## What

**EN1. A name is looked up under the field.**
- On **Add counterparty** and **Edit address**, an ENS name or Basename typed into the address field is resolved, and the
  hint shows the address it points to, with **Use this address**, which puts the address in the field.
- An address typed or pasted shows its primary ENS name, when its owner set one that points back to it.
- Names resolve on Ethereum mainnet, Basenames through Coinbase's gateway.
- Each answer is kept for ten minutes.
- The lookup is for whoever may add or change a payee (`records.write`).

**EN2. Only an address is saved.**
- A name typed into the field and submitted is refused: "That is a name, not an address. Choose Use this address under
  the field to take the address it points to."
- A name can be pointed somewhere else later, so the payee's address on file is always the address that was chosen.

**EN3. A name unlike the payee's is a question.**
- The hint warns when the name's registered label, the one before `.base.eth` or `.eth`, carries none of the payee's
  words.
- It asks the person to check the name with the payee by a contact they had before. It never refuses: a person can own a
  name unlike their business's.

**EN4. Where it looks names up.**
- Ethereum's node is PublicNode's (`ethereum-rpc.publicnode.com`), or the one `ENS_RPC_URL` names.
- A resolver may ask the server to fetch a gateway it names (CCIP-read). The server fetches only an https gateway on
  `ENS_GATEWAY_HOSTS` (Coinbase's `api.coinbase.com`, for Basenames). A crafted name can never make it call an address
  of its choosing.
- The privacy page names both, and what they receive: the name or address looked up.

## Not in this change

- A payee's own link taking a name.
- Reverse names on Base: Basenames' primary names do not resolve on Ethereum yet.
- Signing the name with the address change.

## Tests

`tests/ens-address-names.test.ts`:
- what reads as a name;
- a name refused as an address;
- whether a name looks like the payee, subnames included;
- the lookup both ways through an injected client, with its cache;
- the gateway allowlist;
- the default node and `ENS_RPC_URL`.
