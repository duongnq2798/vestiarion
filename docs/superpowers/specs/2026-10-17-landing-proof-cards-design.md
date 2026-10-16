# Landing proof cards: each network led by whoever has paid on it

A review of the landing's proof section, the Arc mainnet and Arc testnet cards under "Don't take our word for it."

## What the review found

- **Arc mainnet read as unused.** Its card led with three customer figures, "Not yet", "None yet", "None yet". The
  team's four real payments on Arc mainnet sat in small type on a line under them.
- **The figures were set in the mono**, which made "Not yet" and "None yet" look rough at that size.
- **The badges said "Real money" and "Test money"**, where the cards count USDC.
- **The descriptions under the figures ran to three or four lines** in a third of half the page.
- **"What runs live right now" was three pills of different widths**, wrapping unevenly.
- **The checks under "Check it without us" led with the open numbers**, not with the two checks that need no trust in
  us: verifying the signed ledger, and the agent's decisions against the rules.

## What changed

- **Each network leads with whoever has paid on it.**
  - Once a customer has paid on a network, its card leads with the customers' figures, as before. The team's own sit
    on a line under them, apart (landing clarity P2).
  - Until then, the card leads with the team's own payments, under the heading "Paid by the Vestiarion team":
    - how many, "from our own workspaces";
    - how much USDC, linked to the list of them on Open numbers;
    - the latest, by date, on its explorer.

    Where customers stand goes on the line under them: "None on Arc mainnet yet", or how many workspaces they opened
    with no payment yet.
  - A figure that counts the team never stands under "Customers", and the two sides are never added together.
  - When nobody has paid on a network at all, the customers' figures show, each saying so.
- **The figures are set in the sans** with even-width digits. Times and hashes keep the mono. A date is shown as it
  is, not counted up.
- **The badges read "Real USDC" and "Test USDC"**, on the landing and on Open numbers.
- **The descriptions are cut to a line or two**: "4 live, 3 have paid", "132.53 USDC paid", "in shadow mode, 100%".
- **Arc mainnet's card carries a thin rule in the proof colour** across its top. Arc testnet's stays neutral.
- **"What runs live right now" is a list**, one leg to a row: the leg, where it runs, then Live at the same place on
  every row. A row that shows the leg live is a link (`ProvenanceList`). The workspace status strip keeps its compact
  badges (`ProvenanceBar`).
- **"Check it without us" leads with the two checks that need no trust in us**: verify a ledger export yourself, then
  where the model and the rules disagreed. The open numbers and the source code follow.

## Not taken

- **Renaming "Check it without us" to "Don't take our word for it."** That is already the section's heading.
- **An illustration.** The section is proof; a picture would compete with the figures.

## Checked

- `tests/landing-proof.test.tsx` covers:
  - Arc mainnet led by the team, named as the team's, with the customers' state on its line;
  - Arc testnet led by customers;
  - customers leading once any has paid;
  - a network where customers opened workspaces but paid nothing;
  - a network where nobody has paid;
  - the list of live legs, its links and its unlinked row.
- Headless Edge, against production's figures, at 1440, 1024, 768 and 375 px: three figures a card from `sm`, the
  latest payment's hash on one line, and the list's statuses lined up.
