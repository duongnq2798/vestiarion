# Disconnecting an integration says it worked

Date: 2026-10-27. Status: built. Branch `fix/asana-disconnect-toast`. No migration, no API change. Follows the Asana
acceptance design ([2026-10-14-asana-acceptance-design.md](2026-10-14-asana-acceptance-design.md) A2) and the
connector designs it shares its Settings card with.

## Why

Choosing **Disconnect Asana** in Settings disconnected Asana, and nothing said so. The card turned to "Disconnected
from" the account, but the toast the button was meant to raise, "Asana is disconnected. Acceptances already recorded
stay in Vestiarion.", never appeared.

The Disconnect button is its own small component that holds its form's state (`useActionForm` with `toastOnSuccess`),
and `toastOnSuccess` raises the toast from an effect in that component once the answer arrives. The action revalidates
the page before it answers, so the answer and the revalidated page land in one render. In that render the card is
revoked and no longer draws the Disconnect button, so the component that would raise the toast is gone before its
effect runs. The repo already names this the revalidate unmount pattern (`GoogleSheetsPanel`, `DiscordPanel`,
`withSuccessToast`).

The same shape, a disconnect form that holds its own state and raises its toast with `toastOnSuccess` inside a part of
the card the page drops once it is disconnected, is in eight more forms. The Pipedrive and Zoho CRM guides promised
that the card says "… is disconnected", and nothing appeared there either.

## The rules (decided here)

- **DC1. The action raises its own confirmation.** These forms pass their action through `withSuccessToast`, made once
  at module scope, so the toast is raised when the action answers, whether or not the form is still on the page:

  | Card | Button | What the page drops | Toast |
  | --- | --- | --- | --- |
  | Asana (`AsanaPanel`) | **Disconnect Asana** | the button, once `view.revoked` | "Asana is disconnected. Acceptances already recorded stay in Vestiarion." |
  | Xero, QuickBooks, Zoho Books (`AccountingPanel`) | **Disconnect Xero**, and so on | the button, once `view.revoked` | "Xero is disconnected. Bills already added stay in Vestiarion.", and so on |
  | HubSpot, Pipedrive, Zoho CRM | **Disconnect HubSpot**, and so on | the button, once `view.revoked` | "HubSpot is disconnected. Deals already planned stay in Vestiarion.", and so on |
  | Slack (`SlackPanel`) | **Disconnect my account** | the button, once `view.youConnected` is false | "Your Slack account is disconnected." |
  | Slack (`SlackPanel`) | **Remove Slack** | the whole connected view, once `view.installed` is false | "Slack is disconnected. The agent's decisions no longer go there." |
  | GitHub (`GitHubPanel`) | **Disconnect**, on each account's row | the row, once the installation is deleted | "GitHub is disconnected from this workspace. To take the app's access away, uninstall it on GitHub." |
  | Chrome extension (`ChromeExtensionPanel`) | **Disconnect**, on each extension's row | the row, once the grant is revoked | "Disconnected. That extension can no longer send drafts." |

  `withSuccessToast` suits the per-row forms too, where lifting one `useActionForm` into the list would share one form
  between the rows.
- **DC2. One toast, never two.** A form whose action is wrapped in `withSuccessToast` never also passes
  `toastOnSuccess`. A disconnect form that does pass `toastOnSuccess` holds its `useActionForm` in a component the page
  keeps mounted and hands it down, as Discord and Telegram do; it never holds it in the component that draws the button.
- **DC3. A refusal stays beside the button.** A refusal of these actions answers before anything is revalidated (all
  but one race, below), so the button and its form are still there: the refusal shows in the form's message, as
  before, and raises no toast.
- **DC4. Nothing else changes.** The words, the buttons, the actions and what they record are as they were. The forms
  that already confirm are left as they are: Discord's and Google Sheets' forms live in their panels, Telegram's
  Disconnect sits at the top of a card that stays mounted, and Members' Leave is held by the members page. **Sync now**
  and **Check linked tasks now** stay mounted when they succeed, so their toasts already show.
- **DC5. The guides say where the answer appears.** Where a guide quoted the answer to a disconnect as the card's, it
  now says "Settings answers", as the Discord guide does: Pipedrive and Zoho CRM.
- **DC6. A guard.** A source scan of `src/components` fails when a form wrapped in `withSuccessToast` also passes
  `toastOnSuccess` (DC2), or when a disconnect form (an action named `disconnect…Action`, or `removeSlackAction` and
  `removeDiscordAction`, those integrations' disconnects) passes `toastOnSuccess` from the component that draws it.

## Considered and not done

- Moving each form's state up into its panel, as Discord and Google Sheets do. It keeps an answer on the card after the
  swap, which Google Sheets needs for its warnings. These answers add nothing the card's new status does not already
  say, the per-row lists would share one form between rows, and it is more code for each card.
- Making `toastOnSuccess` itself raise the toast from the action. It would fix every form at once, but it changes when
  every success toast in the app appears (102 uses) and would toast twice wherever an action is also wrapped.
- Sending the page to `?asana=disconnected` and showing a notice. It changes the action into a redirect for one card.
- **Sync now** on a card whose sync finds the connection gone: the action revalidates and then refuses, the card turns
  to "needs you to reconnect" and the refusal goes with the button. The card's status and its **Reconnect** button say
  the same, so it is left as it is.
- The Chrome extension's rare race, two people disconnecting the same extension at once: the second answer, "This
  extension was already disconnected.", comes after the page is revalidated, so the row is gone and the answer with it.
  The row going is the same news.
- Other remove and revoke forms outside the integration cards (members, invitations, webhooks, API keys, sample data,
  deal costs, client links, document requests) are not part of this change.

## Tests

- `tests/disconnect-confirmation.test.tsx` (happy-dom): for each form in DC1, the action answers only after the page
  has dropped its button: the toast is raised with the action's message and the button is gone. A refusal, with the
  page unchanged, shows beside the button and raises no toast. The source scan of DC6.
- The existing static tests of each card (`slack-panel`, `github-panel`, `hubspot-panel`, `pipedrive-render`,
  `zohocrm-render`, `xero-panel`, `quickbooks-panel`, `integration-marks`, `captured-drafts-render`) and
  `tests/docs-guides.test.ts`, which keeps the quoted button names in the panels' files.
