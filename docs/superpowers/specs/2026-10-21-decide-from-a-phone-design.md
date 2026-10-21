# Decide from a phone: Approvals and Contractors at 375px

Date: 2026-10-21. Status: accepted.

## Why

A held payment waits for a person, and that person is often away from a desk. Approvals and Contractors already fit a
375px screen with nothing running off the side, but checked at that width (headless Edge, sample data, real frames):
- the address **Approve and pay** sends to was cut after about 38 characters, so its end, which is what tells two
  lookalike addresses apart, could not be read where the decision is taken;
- every decision button (Approve and pay, Reject, Return to agent, Add details; Pay now and Close without paying on a
  held milestone) was 32px tall, under a thumb's 44px;
- Contractors' four counts stacked one per row, pushing the milestones about a screen and a half down (two a row
  would not do: a paid total of 1,000 USDC or more is wider than half the screen);
- a milestone row's second line, which on a phone also carries its date ("Held Oct 2, 2026"), was cut;
- the line under every page ("Hash-chained decisions · Ed25519 signed · Arc testnet") ran past the edge.

## What

**P1. The whole address.** The approval card's "Pays to" line wraps instead of being cut, at every width.

**P2. Thumb-sized decisions.** A Button size, `touch`, is `sm` from 640px up and md's 44px below it. The approval
card's decisions and its callout links, Add details there, its shadow-mode verdict (Agree and pay, Agree, Disagree),
and a held milestone's Pay now and Close without paying use it. On a phone, Approve and pay spans the card and Pay now
its row, so the decision that moves money is the one that cannot be missed. Above 640px nothing changes. The verdict
stays small on the console and Bills & receivables.

**P3. Contractors' counts in three rows.** On a phone, "Needs you" spans the top, Awaiting verification and Verified
sit side by side, and "Paid" spans the bottom: a total in the millions (about 181px at the tile's size) is wider than
half a 375px screen. Two a row from 640px, four from `xl`, as before.

**P4. Lines that wrap.** A decision row's second line wraps below 640px, to two lines at most, with its date kept
whole; the page's footer line wraps on a phone.

The dialogs these buttons open already fit: full-width 44px buttons and 16px fields, which a phone does not zoom into.

## Not in this change

- The rest of the console at 375px (Bills & receivables, Settings): its own pass, with the 520px bug bash (D16).
- The New payment tabs (34px) and copy buttons (32px): secondary actions, left for that pass.

## Tests

- The approval card shows the whole address, with no truncation, and its decisions are `touch`-sized.
- A held milestone's actions are `touch`-sized; the verdict is on Approvals and nowhere else.
- `touch` gives every class of `sm` from 640px up and 44px below; "Needs you" and "Paid" span both columns on a
  phone; a row's second line and the footer wrap on a phone.
