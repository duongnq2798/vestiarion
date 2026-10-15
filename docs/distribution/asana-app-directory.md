# Asana App Directory: submitting Vestiarion

What to paste into the Asana developer console's **App listing details** and **Submit for review** pages, field by
field. The rules are Asana's [app listing guidelines](https://developers.asana.com/docs/app-listing-guidelines) and
[Publish your app](https://developers.asana.com/docs/publish-your-app). `tests/marketplace-listings.test.ts` holds the
text below to them and the scopes to the code.

Vestiarion is an OAuth app with no app components, so it goes through Asana's listing review only, not the app
component security review. Asana aims to answer within a week. Once it passes, **Publish app** lists it; until then the
app works for anyone who connects from Vestiarion, as it does today.

## Before you submit

1. **OAuth.** The redirect URL stays `https://www.vestiarion.xyz/api/integrations/asana/callback`. The scopes stay
   exactly the ones in the table below: Asana's authorize page refuses a scope the app is not registered for, and
   Vestiarion asks for every one each time (`ASANA_SCOPES`).
2. **Media**: the icon and three images in [`assets/asana`](assets/asana), and the screencast below.
3. **A reviewer path** that needs no help from us (below), with an Asana project whose task the reviewer can complete.

## App listing details

| Field | Value |
| --- | --- |
| App name | Vestiarion |
| App landing or login page URL | `https://www.vestiarion.xyz/integrations/asana/connect` |
| Company page URL | `https://www.vestiarion.xyz` |
| Support page URL | `https://www.vestiarion.xyz/docs/guides/asana` |
| Privacy policy URL | `https://www.vestiarion.xyz/privacy` |
| Terms of service URL | `https://www.vestiarion.xyz/terms` |

### Short description (about 100 characters, starting with a verb)

Pay contractors for work delivered in Asana, once a person accepts the completed task.

### Long description (at least 250 characters)

Vestiarion is an AI agent for bills and payments for small businesses. Connect Asana and link a contractor's milestone
to the task its work is delivered in. When the task is completed, the milestone is ready for acceptance: a person
checks the deliverables against the criteria you wrote and accepts the work, and Vestiarion's agent then decides the
payment in USDC on Arc, within the limits you set.

- A task completed in Asana is never by itself a reason to pay, and nothing from Asana sets an amount or a payee.
- If the task is reopened, or its deliverables change, after the work was accepted, the acceptance is taken back and
  the payment waits for a person again.
- Vestiarion reads as the Asana user who connects, and keeps the task's links and names, never the words of its
  description or comments.
- Every acceptance and payment is signed into a ledger you can verify.

### App icon

[`assets/asana/icon-128.png`](assets/asana/icon-128.png): 128 x 128 PNG, the Vestiarion mark. A 512 x 512 copy is in
[`assets/pipedrive/icon-512.png`](assets/pipedrive/icon-512.png) if a larger one is asked for.

### App images

From [`assets/asana`](assets/asana), each showing Vestiarion with an Asana task:

1. `1-link.png`: Link a milestone to the Asana task its work is delivered in.
2. `2-ready.png`: The task is completed in Asana: the milestone is ready for acceptance.
3. `3-accepted.png`: A person accepts the work against its criteria, and the agent decides the payment.

### Screencast (30 seconds to 2 minutes)

1. Connect Asana from Settings, agree, allow (0:00-0:20).
2. On Contractors, link a milestone to its task and write the acceptance criteria (0:20-0:45).
3. Complete the task in Asana; the milestone says it is ready for acceptance within a minute (0:45-1:05).
4. Accept the work; the agent decides the payment and it settles on Arc testnet (1:05-1:35).
5. Reopen the task in Asana; the acceptance is taken back (1:35-1:50).

No access token, email address or wallet address of a real person on screen.

## Setup instructions

1. Create a free workspace at https://www.vestiarion.xyz/signup with your email (no password). You are its owner.
2. Open Settings, then Integrations. Under Asana, choose Connect Asana. Only owners and admins connect it.
3. Read what Vestiarion does with Asana's data, tick I agree, and choose Continue to Asana. Allow access as yourself.
4. On Contractors, add a contractor and a milestone, or open one waiting for verification. Under Accept from Asana,
   paste the task's link (Copy task link in Asana) and choose Link the task, or choose the task in Asana instead.
   Then add the acceptance criteria.
5. Complete the task in Asana. Within a minute, the milestone says Ready for acceptance.
6. Check the deliverables against the criteria, tick that you checked each one, and choose Accept the work. The agent
   decides the payment within a minute, under every limit set in Settings.

Asana permissions it needs, read as the user who connects: workspaces, projects and tasks to pick from; a task's
attachments and comments for the deliverables' links; and webhooks on the linked tasks only, which it deletes when the
task is unlinked or Asana is disconnected.

Troubleshooting is in the guide: https://www.vestiarion.xyz/docs/guides/asana#status-and-errors

## Scopes

| Scope | Why Vestiarion needs it |
| --- | --- |
| `workspaces:read` | The workspaces to pick a task from. |
| `projects:read` | The projects in a workspace, to pick a task from. |
| `tasks:read` | The linked task: its name, whether and when it was completed and by whom, its assignee, the links in its description. |
| `attachments:read` | The task's attachments, the deliverables a person checks. |
| `stories:read` | The task's comments, for links to deliverables, and its activity, such as a reopen. |
| `users:read` | The Asana user the connection acts as (`/users/me`), named on the Settings card. |
| `webhooks:read` | Part of Asana's webhook permissions, registered with the two below. |
| `webhooks:write` | One webhook per linked task, so a completion or a reopen is read within a minute. |
| `webhooks:delete` | Deleting that webhook when the task is unlinked or Asana is disconnected. |

## Test credentials (for the reviewer only)

Reviewers need no account from us: the setup instructions above start with a free workspace, on Arc testnet, where
nothing is real money. If Asana asks for credentials anyway, give a Vestiarion workspace made for the review, with a
contractor and a milestone ready to link, and an Asana project shared with the reviewer.
