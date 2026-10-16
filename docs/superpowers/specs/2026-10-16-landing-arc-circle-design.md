# Landing integrations: Arc and Circle as what Vestiarion is built on

Date: 2026-10-16. Branch `feat/integrations-arc-circle`. This replaces the "Under the hood" row of the landing page's
integrations section (`2026-10-16-landing-integrations-design.md` L7).

## What was wrong

"Under the hood" gave Arc, Circle and npm three equal cells, so payment rails and an SDK package looked alike. Each cell
said one general line ("Payments settle in USDC on Arc", "Circle's wallets carry the live USDC payments"):
- nothing said which Circle products the product runs, or what it does on Arc;
- the only evidence links were the open numbers and one source file.

A reviewer, or a judge from Circle or Arc, could not tell from the page that they are the product's core rather than
logos.

## Decisions

- **AC1 — A pair of their own, larger.**
  - The row's title is now "Built on Arc, with Circle", with the summary "Where every payment is made, and the wallets
    that send it."
  - Arc and Circle are two cards side by side from a tablet's width, their marks at 28 px (no tool's is above 26).
  - Each card has a blue eyebrow for its role, "Where payments are made" and "Wallets and money movement", and the
    company's own site beside its name.
  - They stay below the three groups of tools and keep the same left column: the tools say how Vestiarion meets a
    business's work, and these two say why it can pay. Neither group outshines the other.
- **AC2 — What the product does on each, in three lines.** Every line is the README's ("Circle integrations",
  "Mainnet proof"), and the ones that run on Arc testnet alone say so.
  - Arc:
    - payments are made on Arc, each linking to its transaction on the explorer;
    - Arc testnet for shadow mode and trials, Arc mainnet for real USDC;
    - on Arc mainnet, an owner's wallet can cap the agent with a spending-limit contract it deploys;
    - the open numbers count mainnet and testnet apart.
  - Circle:
    - its wallets hold each workspace's treasury and send every payment the agent is allowed to make;
    - Developer-Controlled Wallets for treasury and agent wallets, transfers and balances;
    - Modular Wallets for passkey wallets: an owner's treasury on Arc mainnet, and payees';
    - CCTP, Gateway, Gas Station, USYC and EURC swaps on Arc testnet.
- **AC3 — Evidence, one click away.**
  - Arc: See the payments (`/open`) and Mainnet proof (the README's walk-through of the first payment on Arc mainnet,
    with its transactions and the spending-limit contract).
  - Circle: Circle products we use (the README's table) and Read the code (`src/lib/circle/liveProvider.ts`).
  - Both companies' own sites open in a new tab, as before.
- **AC4 — The SDK is a line, not a card.** "Building on Vestiarion? @vestiarion/sdk is a typed client for every
  endpoint. SDK docs" sits under the pair, npm's wordmark inline, kept for npm's trademark notice.

Rejected:
- "Powered by Circle" and "Official partner": the section never says a company vouches for Vestiarion, and the test
  holds "powered by" out. "Built on" and "with" say what the code does.
- Large logo tiles: the marks stay the owners' files, at a size beside a name.

## Checked

`tests/brand-marks.test.tsx`:
- the pair is two cards side by side, with marks at 28 px, larger than any tool's;
- the roles and site links;
- each Circle product named is in the README;
- the testnet-only line;
- both README anchors exist;
- the links in order;
- the SDK is a line, not a list item.

`tests/landing-arc-circle-links.test.tsx` still holds the sites in a new tab and See the payments.

`tests/network-copy-ratchet.test.ts` now allows the section's two "Arc testnet" mentions, with the reason. The landing
page is the platform's own, so naming what Arc testnet is for, and what runs only there, is true for every visitor;
that is the same reason the landing's FAQ has an allowance.

Headless Edge at 1440, 1024, 768 and 390 px: no horizontal overflow, and the two cards' links on one line each from
1024 px.
