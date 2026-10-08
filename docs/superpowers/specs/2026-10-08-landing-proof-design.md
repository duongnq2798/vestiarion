# Landing proof: live legs that link to their evidence, and the open numbers

Date: 2026-10-08. Follows `2026-10-08-landing-owner-hero-design.md`.

## Problem

Three things on the landing undersold what runs in production, or claimed it without a link:

1. The hero's strip "What runs live right now" said **Yield · USYC reserve · Simulated**. It read only the founding
   workspace, whose reserve is simulated, while a team workspace has run a real USYC reserve on Arc testnet since
   2 October, with sweeps and redemptions every week.
2. The hero says **Live on Arc mainnet**, and nothing on the page linked to a payment on Arc mainnet.
3. The measurements section showed the founding workspace's own figures (9 transfers, 92 decisions), the smallest set
   of numbers the product has, while /open counts every workspace, customers apart from the team.

## Decisions

**P1. The reserve leg says what the deployment runs.** The strip describes the deployment, as the Screening leg always
has. The Yield leg is live when the founding workspace's reserve is real, or when any live workspace runs a real one:
`reserveRunsLive()` counts `orgs` rows with `mode = 'live'` and `usyc_live_at` set, and returns only whether there is
one, never which. Its detail names the network, "USYC reserve, Arc testnet", since USYC runs only there. A live leg
links to the research note's section "The treasury, with real USYC", which walks through the reserve's moves by signed
entry. A simulated leg links nowhere. When the count cannot be read, the leg says simulated.

No migration: a tie from the leg to one team workspace's transaction would need a new security definer function, and
the research note already links the moves.

**P2. Live on Arc mainnet links to its receipt.** The hero's "Live on Arc mainnet" links to /open's Arc mainnet section.
The Payments leg links to the team's latest Arc mainnet payment on the explorer, the first of `open_numbers`'
`ourPayments` for Arc mainnet, or to /open's mainnet section when there is none. An explorer link opens in a new tab.
The amount is not printed in the hero.

**P3. The measurements are the open numbers.** The section reads both networks' all-time open numbers through
`readOpenNumbers` (memoized a minute, shared with /open) and shows two panels, Arc mainnet first, never added together.
Each panel has /open's headline figures: customer workspaces (live now, made a first payment), payments settled (by
customers, USDC in all), and how the agent's calls held up: customers' agreement rate in shadow mode once any customer
gave a verdict, otherwise invoices paid on time, every workspace's. Under them, the team's latest payment on that
network links to its explorer. A network whose numbers cannot be read says so, and the other still shows. Arc mainnet's
numbers are read before the hero (P2 needs them); Arc testnet's stream behind a skeleton.

The founding workspace's operational figures (median settlement, median chain fee, run records, ledger height) leave
the landing with `src/lib/landing.ts`: they described one workspace, beside figures that describe all of them.

## Tests

`tests/landing-proof.test.tsx`: the legs (live from another workspace's reserve, simulated with no link, the mainnet
link and its fallback, links rendered with a new tab for the explorer), the hero's mainnet link, the panels (order,
customers' figures with totals, never a sum across networks, explorer links, agreement rate, an unreadable network).
The copy and constants ratchets list the landing's reads of both networks' labels.
