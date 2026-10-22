# Payee addresses in the weekly brief

Date: 2026-10-22. Status: accepted.

## Why

A changed payee address is where a business is most often robbed: an email that looks like the vendor's says the bank
or the wallet changed. Vestiarion now checks those changes in three ways: the payee lock (a second person records how a
new address was checked), "Was this you?" (the payee's own contact is asked) and the agent's holds for an address no one
confirmed, or one an invoice asked for instead. Each leaves a signed entry, but nobody reads the ledger on a Monday. The
weekly brief is what the owner, admins and approvers do read, so it is where a week's address changes, and a payee left
frozen, should be said.

## What

**WP1. What the brief reads.** For the last 7 days, from the workspace's signed entries:
- `counterparty_address_changed` entries that set an address (a cleared address is no change to check);
- `counterparty_address_confirmed` entries;
- the agent's decisions held for an address: `guardrailRule` `counterparty.address_unconfirmed`,
  `counterparty.cooling_off` or `invoice.pay_to_differs`;
- `address_change_check_sent` entries, and the `address_change_answered` entries that say `not_me`.

And, as of now:
- whether the payee lock is on;
- how many payees are frozen. Before migration 0137 there is no freeze, so none is.

When these cannot be read, the brief goes without them. The figures are signed with the rest of the week in
`weekly_brief_sent`, as `payees: { lockOn, changed, confirmed, held, asked, notMe, frozen }`.

**WP2. What it says.** A **Payee addresses** section, between **Waiting for you** and **Next 7 days**, only in a week
when something happened:
- a frozen payee first, since a person must act on it: "1 payee is frozen: their contact said they did not make a change
  to their address. An owner or admin unfreezes one on Counterparties after checking with them.";
- the addresses changed and confirmed;
- the payments the agent held for an address;
- the contacts asked, and how many said they did not make the change;
- where the payee lock is off, a last line: "The payee lock is off: turn it on in Settings to have a second person
  record how each changed address was checked."

A week with only payee events is reason enough to send the brief.

## Not in this change

- Naming the payees in the email. The brief gives counts and links to the console, as it does for payments.
- The shadow-mode brief's verdict lines. Payee addresses are said in either mode.

## Tests

`tests/weekly-brief.test.ts`:
- the sentences, in order, and none in a quiet week;
- the payee lock line, only where it is off and something happened;
- payee events alone send the brief, in a section of their own;
- what `payeeWeek` reads, and the agent holds it filters on;
- nothing when the entries cannot be read, and no frozen payee before 0137;
- the figures signed in `weekly_brief_sent`.
