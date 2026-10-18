# Ask every payee for an address at once

Date: 2026-10-18. Status: built. Branch `feat/ask-every-payee`. No migration.

## Why

A payee with no address of its own holds every payment to it. Today an owner or admin asks one payee at a time:
**Ask for address**, **Create link**, copy it, and send it by hand. That is fine for one new supplier. It is not fine
for the workspace a business has just opened on Arc mainnet with the live slice, where most vendors arrive with no
address. It is not fine either for a shadow workspace whose suppliers are all paid at mirror addresses, which the report
asks to replace with each supplier's own before a live slice. The step that stands between a business and its first
real payment should be one press.

## The rules (decided here)

- **A1. Where.** On **Counterparties**, above the Counterparty book, for an owner or admin (`records.write`, as for a
  single link). It shows when at least one payee needs an address: **Ask every payee for an address**.
- **A2. Who is asked.** A vendor or contractor that has no address of its own and no unused link out. A payee paid at a
  mirror address (shadow mode S7) has no address of its own, so it is asked too.
  - Never asked: a client, sample data, a payee with an address of its own (confirmed or waiting), and a payee with an
    unused link out. The panel says how many already have one.
  - At most 25 at a press, by name. The panel says when more remain, for the next press.
- **A3. What it shows first.** A dialog lists each payee to be asked and how its link goes: **By email** to its notice
  email, or **No email: copy its link**. Nothing is sent until **Send the links**.
- **A4. What it does.** For each payee listed, still eligible when the press arrives:
  - It makes a link through the command a single link uses (`issuePayeeLink`). So the same permission, the same refusal
    for a client, the same `payee_link_created` entry, and the person who pressed counts as having given the address
    that comes through it.
  - It emails the link to the payee's notice email when it has one: which business asks, the network it pays on, and
    that nothing is paid to the address until someone there confirms it. A business in shadow mode still pays its
    suppliers its own way, so its email says it is getting ready to pay in USDC and names no network.
  - The links are made one after another, then emailed five at a time, so a press of 25 ends well within the page's
    300 seconds.
  - A workspace that simulates its payments emails no payee: every link is shown to copy.
  - A link with no email to go to, or whose email did not go, is shown once to copy, as a single link is.
  - A link that could not be made is named, and the rest still go.
- **A5. Recorded.** Beyond each link's own `payee_link_created`, the workspace signs `payee_addresses_requested` with
  who pressed, each link made with whether it was emailed, and each payee whose link could not be made. Best effort, as
  the link entries are: a link already made is never undone for want of this entry.
- **A6. The same rules after.** An address that comes in through any of these links waits for a person's confirmation,
  and its first payment needs a second person, exactly as for a single link (first payment guide, Ask a payee for their
  address). Emails are metered as `address_request`.
- **A7. A daily most.** A workspace sends at most 100 address emails in 24 hours, counted from its metered emails. Past
  it, or when that count cannot be read, the links are shown to copy, and the dialog says why.

## Known limits

- Two people pressing at the same moment can both ask the same payee: the second link replaces the first, and the
  payee gets two emails, the first link no longer working.

## Where it helps

- The live slice: once it opens, its card says to ask the vendors with no address on the new workspace's Counterparties.
- Shadow mode: the report's third step, each supplier's own Arc address, says the same.

## What it does not do

- Change an address, or send a second link to a payee that has one out: **Revoke** it in the row first.
- Email anyone but the payee's own notice email.
- Run on its own: a person presses it each time.
