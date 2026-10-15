# Pipedrive Marketplace: submitting Vestiarion

What to paste into Pipedrive's Developer Hub, field by field, and what to prepare before choosing **Send to review**.
The limits are Developer Hub's own ([registering the app](https://pipedrive.readme.io/docs/marketplace-registering-the-app));
the review checklist is Pipedrive's [app approval process](https://pipedrive.readme.io/docs/marketplace-app-approval-process).
`tests/marketplace-listings.test.ts` holds the text below to those limits and the scopes to the code.

Pipedrive reviews a public app in up to 21 business days. An approved app stays unlisted until **Publish** is chosen
beside its name in Developer Hub.

## Before you submit

1. **Scopes.** Pipedrive asks reviewers to check that an app requests only what it uses, and a person accepts all of an
   app's scopes or none. In Developer Hub, **OAuth & access scopes**, keep exactly the scopes in the table below and
   remove `users:read` and `recents:read`: Vestiarion reads the user and company it acts as from `/users/me`, which
   `base` covers, and reads changed deals through its webhook and the deals list, never `/recents`. Then reconnect the
   sandbox company once, so its grant matches.
2. **Installation URL.** Set it to `https://www.vestiarion.xyz/integrations/pipedrive/connect`. A person who chooses
   **Install now** in the Marketplace lands there, signs in or signs up, picks the workspace, agrees, and is sent to
   Pipedrive's consent with Vestiarion's own state. An install that reaches the callback without that state, if
   Pipedrive sends one, is sent to the same page (`?installed=1`) and nothing is exchanged.
3. **Callback URL** stays `https://www.vestiarion.xyz/api/integrations/pipedrive/callback`. Pipedrive also sends its
   uninstall notice there (`DELETE`, Basic auth with the app's client id and secret); Vestiarion then asks the workspace
   to reconnect.
4. **Media**: the icon and four listing images in [`assets/pipedrive`](assets/pipedrive), and the demo video below.
5. **A sandbox company with deals** that reviewers can use, and a reviewer path that needs no help from us (below).

## Basic info

| Field | Value |
| --- | --- |
| App name | Vestiarion |
| Callback URL | `https://www.vestiarion.xyz/api/integrations/pipedrive/callback` |
| Installation URL | `https://www.vestiarion.xyz/integrations/pipedrive/connect` |
| App category | Accounting & Invoicing |

## OAuth & access scopes

| Scope | Why Vestiarion needs it |
| --- | --- |
| `base` | Always on: the user and company the connection acts as (`/users/me`), so one Pipedrive company maps to one workspace. |
| `deals:full` | Reads won deals and their values, close dates and stages; once an owner or admin allows writing, writes the receipt fields on the deals planned from Pipedrive. Pipedrive has no narrower scope that writes deal fields. |
| `contacts:read` | Reads each won deal's organization and persons, so the customer is on file when its collections are planned. |
| `deal-fields:full` | Makes Vestiarion's nine deal fields once (collected, still owed, last receipt and the like), when writing is allowed. |
| `webhooks:full` | Makes one webhook for the company's deals, so a changed deal is read again within a minute, and removes it on disconnect. |

## General info

### Short summary (150 characters at most)

Plan collections for every won deal, get paid in USDC on Arc, and see what was collected and still owed on the deal.

### Full description (1500 characters at most)

Vestiarion is an AI agent for bills and payments for small businesses. With Pipedrive connected, every deal you win
becomes money you can track to the last payment.

What it does:
- Brings your won deals in, with their organizations and persons, as soon as Pipedrive says a deal changed and every
  15 minutes.
- Plans each deal's collections: a deposit and a balance, milestones or a retainer, adding up to the deal's value.
  Each line becomes an invoice on its day, with a pay link your customer pays in USDC on Arc.
- Matches each payment to what was owed, and tells you when a deal changes in Pipedrive after you planned it, so you
  change the plan or keep it.
- Once you allow it, writes back to the deal what was collected, what is still owed and the last receipt, in
  Vestiarion's own deal fields, and reads them back. It never writes over a change a person made.

Every step is signed into a ledger you can verify. Nothing from Pipedrive moves money by itself: a person plans each
deal, and the agent pays and collects within the limits you set.

### App icon

[`assets/pipedrive/icon-512.png`](assets/pipedrive/icon-512.png): 512 x 512 PNG, the Vestiarion mark on its own dark
tile, which reads on Pipedrive's dark background.

### App listing images (1 to 5, 1280 x 800 or 2560 x 1600)

In this order, from [`assets/pipedrive`](assets/pipedrive), each with its annotation drawn in:

1. `1-deals.png`: Won deals from Pipedrive, waiting to be planned.
2. `2-plan.png`: Plan a won deal's collections: a deposit, then the balance.
3. `3-receipts.png`: Collected and still owed, written back to the deal.
4. `4-changed.png`: A deal changed in Pipedrive after it was planned: change the plan or keep it.

### YouTube video link

The demo below, once recorded.

## Setup and installation

### Instructions for users (1500 characters at most)

1. In Pipedrive, choose Install now. Vestiarion opens: sign in, or create a free workspace with your email (no password).
2. Pick the Vestiarion workspace the company connects to. Only owners and admins can connect it.
3. Read what Vestiarion does with Pipedrive's data, tick I agree, and choose Continue to Pipedrive.
4. Allow and install. Connect as a Pipedrive admin to bring every deal in: Vestiarion sees the deals the person who
   connects can see.
5. Back in Vestiarion, Settings says Pipedrive is connected and starts the first sync. On Bills & receivables, the
   Receivables tab lists your won deals under From Pipedrive.
6. Choose Plan collections on a deal, set its schedule, and save. Its invoices and pay links follow on their days.
7. To write receipts back to Pipedrive, choose Write receipts to Pipedrive on the Settings card. Writing is for
   payments on Arc mainnet outside shadow mode.

To disconnect, choose Disconnect Pipedrive on the Settings card: Vestiarion stops reading and writing at once and
revokes its access, which uninstalls it from the company. Uninstalling in Pipedrive does the same.

## Support and legal info

| Field | Value |
| --- | --- |
| Website URL | `https://www.vestiarion.xyz` |
| Terms of Service URL | `https://www.vestiarion.xyz/terms` |
| Privacy Policy URL | `https://www.vestiarion.xyz/privacy` |
| Pricing page URL | Leave empty while Vestiarion is free in its beta; say so in the description if Pipedrive asks |
| Support URL | `https://www.vestiarion.xyz/docs/guides/pipedrive` |
| Support email | The team's support address |
| Documentation URL | `https://www.vestiarion.xyz/docs/guides/pipedrive` |
| Issue tracker URL | `https://github.com/duongnq2798/vestiarion/issues` |

## App review info

| Field | Value |
| --- | --- |
| Main contact email | The person who answers the reviewers, reachable for the whole review |
| Installation flow recording URL | The demo video below |

### Use case (350 characters at most, for the reviewer only)

Small businesses plan the collections of the deals they win in Pipedrive and get paid in USDC. Vestiarion reads won
deals with their organizations and persons, and, once an owner allows it, writes what was collected back to each deal.

### Reviewer path

Reviewers need no account from us:

1. Create a free workspace at `https://www.vestiarion.xyz/signup` with any email; you are its owner. It starts on Arc
   testnet, where nothing is real money.
2. In Settings, Integrations, choose Connect Pipedrive, or start from Install now in the Marketplace, and connect the
   reviewer's sandbox company. Win a deal there, or use one already won.
3. On Bills & receivables, the Receivables tab lists the deal under From Pipedrive. Choose Plan collections and save.
4. Change the deal's value in Pipedrive: within a minute the deal in Vestiarion says it changed.
5. Writing back needs a workspace on Arc mainnet, which needs real USDC; the video shows it. On Arc testnet the card
   says why writing is off.
6. Uninstall in Pipedrive, and the Settings card asks to reconnect; or choose Disconnect Pipedrive there, which removes
   the webhook, revokes Vestiarion's access and so uninstalls it.

### Demo video (about 2 minutes, for the listing and the reviewers)

1. Install now in the Pipedrive Marketplace, sign in to Vestiarion, pick the workspace, agree, allow and install
   (0:00-0:30). Say which scopes are asked for and why, as the table above does.
2. The won deals come in; plan one deal's deposit and balance (0:30-1:00).
3. The customer pays the deposit through its pay link; the receipt shows on the deal in Vestiarion and, with writing
   on, in Pipedrive's Vestiarion fields (1:00-1:30).
4. Change the deal's value in Pipedrive; Vestiarion says it changed (1:30-1:45).
5. Disconnect, and the app is gone from the company (1:45-2:00).

No access token, email address or wallet address of a real person on screen.
