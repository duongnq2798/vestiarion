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
- An address typed or pasted shows its primary ENS name, when its owner set one that points back to it. The owner writes
  that record as they like, so a name with a hidden or lookalike character (a zero-width space, a Cyrillic letter), which
  would read as the payee's, is not shown: only plain letters, digits and hyphens, in ENS's normal form.
- Names resolve on Ethereum mainnet, Basenames through Coinbase's gateway.
- Each answer is kept for ten minutes. A lookup tries the node once and gives up after ten seconds: the person can paste
  the address instead.
- The lookup is for whoever may add or change a payee (`records.write`), thirty at once and then one every 2 seconds per
  member.
- **Edit address** opens on the address on file each time: an address put in the field and cancelled is not left there
  to pass for it.

**EN2. Only an address is saved.**
- A name typed into the field and submitted is refused: "That is a name, not an address. Choose Use this address under
  the field to take the address it points to."
- A name can be pointed somewhere else later, so the payee's address on file is always the address that was chosen.

**EN3. A name unlike the payee's is a question.**
- The hint warns when the name's registered label, the one before `.base.eth` or `.eth`, does not look like the payee:
  it looks like them when it is the payee's name run together (`acmestudio.eth` for Acme Studio), or when a part of it
  between hyphens is one of the payee's own words or begins with one of four letters or more (`pay-northwind.eth`,
  `northwindpay.eth`). A word inside another (`notacme.eth`) does not count, nor do words every business uses, such as
  Supply, Pay or Services.
- It asks the person to check the name with the payee by a contact they had before. It never refuses: a person can own a
  name unlike their business's.

**EN4. Where it looks names up.**
- Ethereum's node is PublicNode's (`ethereum-rpc.publicnode.com`), or the one `ENS_RPC_URL` names.
- A resolver may ask the server to fetch a gateway it names (CCIP-read). The server fetches only an https gateway on
  `ENS_GATEWAY_HOSTS` (Coinbase's `api.coinbase.com`, for Basenames), refuses a redirect, and waits 5 seconds at most. A
  crafted name can never make it call an address of its choosing.
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
- the lookup both ways through an injected client, with its cache and its deadline;
- a primary name with a hidden or lookalike character dropped;
- the gateway allowlist, and the gateway fetch: no redirect, a deadline, the next gateway on a bad answer;
- the lookups a member may make;
- the default node and `ENS_RPC_URL`.

`tests/ens-address-edit-dialog.test.tsx`: Edit address opens on the address on file after a cancelled change.
