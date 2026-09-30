# Getting started: a guide and an in-app checklist to the first payment

A first-time owner signs in, opens a workspace, and lands on the console with no idea that Settings → Go live is where a wallet comes from, or that counterparties need an Arc address before the agent can pay them. This design adds two things:

1. A user guide in the docs.
2. A checklist in the console that shows the next step and ticks itself off from the workspace's own data.

It was decided on 2026-09-30 by the implementer under the partner's standing instruction.

## 1. What this builds

- **A "Guides" section in `/docs`**, placed after Overview. The docs have been for integrators so far; this section is for people using the app. It has two pages:
  - **Go live on Arc testnet** (`guides/go-live`), covering both paths:
    - the hosted testnet wallet: one click, no Circle account needed;
    - your own Circle account: API key and entity secret from the Circle console.

    Then: create the treasury wallets, fund the operating wallet from Circle's faucet, check the balance, and go live. It also covers what going live changes (the 6-hourly schedule, pausing) and what to do when a step fails, with the exact on-screen messages.
  - **Your first payment** (`guides/first-payment`): add a counterparty with its Arc address, add an invoice, run a cycle or wait for the schedule, and see what the agent decided and why. That includes approving a held payment, and finding the transaction on the Arc explorer and the signed entry in the audit log.

  Every button, field and message named in the guides is the app's exact text. A test checks each quoted UI string against the source.
- **A "Get started" checklist on the console.** It shows to owners and admins while the workspace is not live, and has five steps:
  1. **Add a wallet**: done when the operating account has a Circle wallet. It links to Settings → Go live.
  2. **Fund it with USDC**: done when the operating account's stored balance is above 0 and it has a wallet, or once the workspace is live. It links to Settings → Go live, where the live balance shows.
  3. **Add a counterparty with an Arc address**: done when at least one counterparty has an address. It links to Counterparties.
  4. **Add an invoice**: done when at least one invoice exists. It links to Invoices.
  5. **Go live**: done when `mode = live`. It links to Settings → Go live.

  The next undone step is highlighted. A "Read the guide" link goes to `/docs/guides/go-live`. The checklist hides once the workspace is live. Viewers and approvers don't see it, because they can't act on it.

## 2. Decisions

- **G1. The checklist is computed, not stored.** Every tick comes from rows the console already reads or can read cheaply: accounts, counterparties, invoices, and `mode`. There is no new table and no dismiss state. It disappears when the work is done, which is the honest signal.
- **G2. The funding tick uses the stored balance, and makes no Circle call on the console.** A per-view Circle read would slow every console load. The stored balance is zeroed when the wallet is created, and becomes real after the first live reconcile. Until then, step 2 says "Check the balance in Settings" and links there, where the live read already happens.
- **G3. The guides describe the product as built.** They name Arc testnet plainly, with no disclaimers (see the product-copy rule), and quote the exact UI strings.

## 3. Testing

- **Docs:** the existing nav, loader, link and anchor tests cover the new pages. A new test extracts every quoted UI string from the two guides (text in "…" following a UI keyword, or a declared list) and asserts that each appears in the source files it names.
- **The checklist:**
  - a pure function `gettingStartedSteps(input)` is tested for each tick condition and for which step is next;
  - the component is tested with `renderToStaticMarkup` for owners and admins versus viewers, for hidden-when-live, and for the links;
  - the console page wires it with data it already has.

## 4. Out of scope

- Screenshots in the guides. (Superseded: the guides gained screenshots in #51, and this checklist has its own in the Go live guide.)
- A dismissable or stored onboarding state.
- Email onboarding.
