# Every workspace names its network: phase 2c of the mainnet plan

Date: 2026-10-06. Status: designed on `feat/mainnet-copy`. Designed under the standing autonomy grant, after phase 2b
(#220, two people above a figure on Arc mainnet). Rulings carry their cost if wrong.

## 1. Why

- **Going live on Arc mainnet is closed because the words are wrong.** After 2b, a mainnet workspace starts with two
  approvals above 100 USDC and an agent capped at 50 USDC a day and 150 in 7 days. The profile's `goLiveOpen` stays
  false (2b L9) because pages and messages still say "Arc testnet" whatever the workspace's network.
- **An inventory of `src/` sized it.**
  - `git grep -i testnet -- src` gives 359 lines: 142 carry copy, 81 are identifiers or profile data, and 136 are
    comments. Six more strings name the network without the word (two faucet messages, two "Arcscan" labels, Sepolia
    names, a rendered chain id).
  - 46 strings belong to a workspace, or to a link, record or receipt of one, and name Arc testnet whatever its network.
    One more is API text with no workspace in scope. 7 already name the network from the profile. 77 stay as they are
    (platform pages, demo data, features only Arc testnet has). 17 raised a question, ruled below.
- **Who reads the wrong network, real money first:**
  1. **A client told how to pay:** the reminder email ("Pay on Arc testnet"), the `/pay` page ("From any wallet on Arc
     testnet") and its "I have paid" answer. On Arc mainnet they would name the wrong network for real money.
  2. **A payee:** the payment notice and payee-link emails, the payee page's paid screen, the receipt's route line, and
     the footer those pages share.
  3. **A member approving real money:**
     - Slack's Approve and pay confirmation and outcome lines;
     - the Slack and Telegram transaction links;
     - the approval card's in-flight callout;
     - the activity sentence that console toasts, Slack and Telegram share;
     - the bounty replies on a pull request.
  4. **Every workspace page:**
     - the shell's "Payments · Arc testnet" leg and footer badge;
     - the getting-started checklist, which offers a hosted wallet in one click and Circle's faucet, neither of which
       exists on Arc mainnet;
     - the pay-link and billing-email blurbs, and the GitHub panel;
     - the accounts list, which prints Circle's raw `ARC-TESTNET`.
  5. **Text stored or given to a model:**
     - two signed ledger summaries;
     - reasoning rebuilt on every view;
     - two LLM system prompts;
     - two "fund EURC from Circle's faucet" messages;
     - the API's `txHash` description.
- **Panels for features Arc mainnet lacks still render there**, with buttons that always refuse: the USYC reserve
  (Settings), milestone escrow (Contractors), Gateway (Console), and the shell's Yield leg.
- **2b's review deferred three issues:**
  - Settings offers "Turn off" for two approvals on Arc mainnet, and refuses it after the confirmation.
  - The agent budget dialog says "Leave a figure blank for no limit", which Arc mainnet refuses.
  - The status API answers a connected mainnet workspace `payments: live` while it is held, and `yield: simulate`
    where there is no USYC.
- **Done when:**
  - every workspace surface in the inventory names its workspace's network;
  - a ratchet keeps "Arc testnet", "testnet USDC" and "faucet" out of every other file;
  - a mainnet workspace shows no panel for a feature its network lacks;
  - the status API answers `unavailable` whenever nothing pays;
  - going live opens on Arc mainnet;
  - Arc testnet reads as before, apart from C9's four lines.

## 2. Rulings

- **C1. A network has one name: its profile's `label`** ("Arc testnet", "Arc mainnet").
  - Each surface takes the network from where it already stands:

    | Where the text is made | Its network |
    | --- | --- |
    | A cycle stage, a server action, an `inOrg` page | `workspaceNetwork()` |
    | A workspace page's client component, `ProductShell` | `membership.network`, passed as a prop |
    | A payment's notice or comment | the intent's own `network` |
    | A chain provider | `provider.network` |
    | A public link's page (`/pay`, `/payee`, `/receipt`) | the link's chain: `chainById`, `networkOfChain` |
    | A GitHub webhook reply (outside `withOrg`) | `orgs.network`, read with the name it already reads |

  - No helper phrases "on X". Each sentence keeps its own words, with `${network.label}` where the literal was.
  - *Cost if wrong:* none on Arc testnet, whose label is "Arc testnet". A surface threaded the wrong source names the
    wrong network on Arc mainnet; each surface's test checks that.
- **C2. Where Arc mainnet differs in substance, the text branches on the profile.**
  - **The faucet.** The profile gains `faucet: string | null`: `https://faucet.circle.com` on Arc testnet, null on Arc
    mainnet. These read it:
    - getting-started's funding step;
    - the EURC refusals ("fund EURC from Circle's faucet first");
    - the Go live panel's funding hint.
    On Arc mainnet they say to send USDC (or EURC) on Arc mainnet, and the funding step names the gas reserve kept
    aside.
  - **Hosted wallets.** Getting-started offers "a hosted wallet in one click" only where the profile has
    `hostedWallets`.
  - *Cost if wrong:* a mainnet owner is told to use a faucet that does not exist, which is today's state.
- **C3. A panel for a feature its network lacks is not drawn:**
  - the USYC reserve (`usyc`), in Settings and as the shell's Yield leg;
  - milestone escrow (`escrow`), on the Contractors page;
  - Gateway (`gateway`), in the Console.
  - Their Arc testnet copy is then true wherever it shows, and stays as written.
  - *Cost if wrong:* a mainnet owner does not see three panels, with which they could do nothing.
- **C4. Signed text is fixed forward.**
  - A ledger summary written after this names its network.
  - One written before stays as written: it was true then, and the chain is not rewritten.
  - Reasoning rebuilt on every view names the viewed workspace's network, old entries included.
- **C5. The platform's own pages keep Arc testnet:**
  - the landing page and social preview;
  - the docs site and its navigation;
  - the demo data;
  - `/wallet` (passkey wallets);
  - the hosted-wallet text;
  - terms and privacy.

  They describe the platform as it runs in production, where `MAINNET_ENABLED` is unset.
  - **Two lines would turn false with the first mainnet workspace, so they change:**
    - `/open`'s "where every workspace runs today";
    - onboarding's "An owner adds an Arc testnet wallet", which sits above a form that can offer Arc mainnet.
  - **Terms and privacy say the service runs on Arc testnet.** They change before a deployment switches Arc mainnet on,
    in the partner's words. That is a rollout prerequisite (section 4), not code here.
  - *Cost if wrong:* the platform's pages lag behind the product until launch.
- **C6. The compact footer names the link's network on link pages.**
  - `/pay`, `/payee` and `/receipt` pass their chain's network.
  - The platform pages that share the footer keep "Signed decisions on Arc testnet" (C5).
- **C7. An explorer link reads "View the transaction"**, not "View on Arcscan". The profile names no explorer, and the
  link already goes to the network's own.
- **C8. The accounts list names a chain by its label**: "Arc testnet · USDC", not "ARC-TESTNET · USDC".
- **C9. What changes on Arc testnet:** the explorer label (C7), the accounts list (C8), and the two platform lines
  (C5). Every other string reads letter for letter as before.
- **C10. A copy ratchet.**
  - A test counts "Arc testnet", "testnet USDC" and "faucet" in the code of every file under `src/`. It leaves out
    comments, as network foundation N8's ratchet does.
  - It allows them only in listed files, each with its count and a reason:
    - the profile;
    - the platform pages (C5) and demo data;
    - features only Arc testnet has: USYC, Gateway, escrow, the spending-limit contract, CCTP, the USDC/EURC swap,
      hosted wallets, passkey wallets;
    - branches that run only on Arc testnet, such as the Go live panel's.
  - A new literal anywhere else fails. So does a new one in a listed file, because its count rises.
  - *Cost if wrong:* a file allowed by mistake can carry a testnet literal on Arc mainnet. Each reason is written down
    for review.
- **C11. Settings on Arc mainnet says what stays.**
  - **Two approvals.**
    - There is no "Turn off".
    - A line says: "A workspace on Arc mainnet keeps two approvals above a figure. Raise it to let one person pay more."
    - Lowering it still needs two approvers, as before.
  - **The agent's spending limit.** The dialog says "A workspace on Arc mainnet keeps a daily or 7-day limit." in place
    of "Leave a figure blank for no limit."
  - The first-payment guide says both.
- **C12. The status API answers `unavailable` whenever nothing pays now.**
  - That is either of:
    - **no provider:** credentials stored but unreadable, or Arc mainnet with no Circle account connected;
    - **a network hold:** Arc mainnet switched off on the deployment, or the workspace not live there yet.
  - Yield is also `unavailable` on a network with no yield reserve.
  - The operation, the schema, the reference page, the changelog and SDK 0.3.2 say so. The `txHash` description says
    "on the workspace's network".
  - *Cost if wrong:* an integrator polling a held mainnet workspace reads `unavailable` where it read `live`, which is
    the truth.
- **C13. Going live opens on Arc mainnet:** `goLiveOpen` is true there.
  - Everything 2a required stays:
    - a person on the allowlist;
    - the word `mainnet` typed;
    - the workspace's own Circle account with a live key;
    - its EOA wallet;
    - the deployment's switch on.
  - Production does not change: `MAINNET_ENABLED` is unset there.
  - *Cost if wrong:* on a deployment with Arc mainnet switched on, an allowed owner can take a workspace live, and its
    payments move real USDC within the figures the workspace keeps. They start at 50 USDC a day, 150 USDC in 7 days, and
    two approvals above 100 USDC, and an owner can raise them, though not remove them (2a, 2b L2). So the bound is what
    the owner sets, not the starting figures (final review's note). That is the plan's phase 3, behind the partner's
    switch.
- **C14. No required limit for each payee.** 2a's section 3 listed it for 2b, which did not rule on it.
  - The agent's caps and two approvals above 100 USDC already bound every payment.
  - Approve and pay skips payee limits by design (#208).
  - *Cost if wrong:* the agent can pay one payee up to its daily cap, 50 USDC.

## 3. Testing

- **Each class-A surface on Arc mainnet.** A test builds or renders the text for an Arc mainnet input and finds
  "Arc mainnet", and never "Arc testnet". The existing Arc testnet tests stay as they are. The surfaces:
  - emails: payee link, payment notice, receivable reminder;
  - `/pay` and its answer, the payee page's paid screen, the receipt's route line, the compact footer;
  - Slack, Telegram, the bounty replies, the approval card, the activity sentence;
  - the shell, getting-started, the pay-link and billing-email blurbs, the GitHub panel, the accounts list;
  - the two prompts, the two ledger summaries, the decision trail, the EURC messages.
- **Panels:** on Arc mainnet, no USYC reserve in Settings, no escrow on Contractors, no Gateway in the Console, and no
  Yield leg in the shell.
- **Settings:** on Arc mainnet, no "Turn off" in the two-approvals panel, and the budget dialog's mainnet sentence.
- **Status:**
  - a connected mainnet workspace that is held answers `unavailable` for both;
  - the same workspace, live and switched on, answers payments `live` and yield `unavailable`;
  - Arc testnet answers as before.
- **Go live:**
  - a connected mainnet workspace with its wallet goes live for an allowed person who typed the word;
  - it is refused while the deployment has Arc mainnet off.
- **The ratchet**, and a check that it ignores comments.
- **The profile:** `faucet` on each network.

## 4. Rollout

- No migration.
- Production does not change on merge: `MAINNET_ENABLED` is unset, and every workspace is on Arc testnet.
- **Before the partner switches Arc mainnet on (phase 3):**
  - terms and privacy name Arc mainnet, in the partner's words;
  - the partner's dry run with a live Circle key;
  - SDK 0.3.2 published;
  - a read-only check that no mainnet workspace lacks a figure (2b's read-side default covers one anyway).
- Rollback: revert.
