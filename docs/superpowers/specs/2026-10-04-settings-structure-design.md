# Settings structure

Date: 2026-10-04. Scope: the workspace Settings page (`/o/[slug]/settings`) and four of its sections.

## Why

Settings has grown to ten sections on one page: Notifications, Go live, USYC reserve, API keys, Webhooks, Slack,
GitHub, Invoices by email, Ledger signing key and Delete workspace. They render in a single column with the same
spacing between every pair, under a 66-word line that lists them all. Finding one means scrolling and reading headings.
Revoked API keys sit among the working ones, the Slack card is prose, and an owner deleting a live workspace is sent
to the console to pause the agent first.

## Rulings

**S1. Groups.** The sections sit in six groups, in this order:

| Group | Sections |
|---|---|
| You | Notifications |
| Workspace | Go live, USYC reserve |
| Developers | API keys, Webhooks |
| Integrations | Slack, GitHub, Invoices by email |
| Security | Ledger signing key |
| Danger zone | Delete workspace |

Each group has a small mono label, styled like the sidebar's group labels, and a rule above it, except the first.
Groups are 40 px apart with the rule; sections inside a group are 40 px apart without one. The page lists every
section once, with its heading's id and its content, which is `null` where the viewer or the deployment does not get
it. `SettingsSections` leaves out a `null` section and a group left empty, from the page and from the contents alike,
so the contents never name a section the page does not show.

**S2. Contents.** From `xl` (1280 px), a 10rem column to the right of the sections stays in view while the page
scrolls, and marks the section being read: the last heading above a line 96 px below the top, or, once the page is
scrolled to its end, the heading the URL names if it is on screen, else the last one. The docs' "On this page" shares
the logic (`useActiveHeading`), which now looks again on every scroll event. Its earlier `IntersectionObserver` on a
band below the line missed jumps: a followed link lands its heading above the line, so nothing crossed the band and
the mark stayed where it was. Below `xl`, the same links sit in a bordered list above the
sections, one group per row, label then links. One page with anchors, not tabs: links into Settings
(`#notifications`, `#go-live-title`, `#usyc-reserve-title`) keep working, and find-in-page still finds everything.
Each section heading takes a scroll margin, so a link lands it below the narrow screen's sticky header.

**S3. The line under the title** says what the page is for and who may change what, in 40 words instead of 66:
"Your own notifications, and how this workspace goes live, connects to other tools and signs its ledger. An owner
takes it live, rotates the ledger signing key or deletes it; an owner or admin manages API keys, webhooks and integrations."
The contents now name the sections, and the sections that create a secret say it is shown once. The docs screenshots
carry the same line (`SETTINGS_SUB`).

**S4. API keys.** The table lists the keys that work, without a Status column. Revoked keys fold under it, closed,
in "Revoked keys (N)", with the day each was revoked. The header's note reads "N active, M revoked" when any key is
revoked, and "N in this workspace" otherwise. With revoked keys and no active one, the card says "No active keys."
Revoking keeps its confirmation, which already says what stops working.

**S5. Slack, connected.** The Slack workspace, where decisions go and since when are label and value rows. The parts
of the card (that summary, the file-reading notice, your account, deciding payments, reconnecting) are separated by
rules. Save on the decision limit is enabled only once the amount differs from the one saved.

**S6. Pausing from the danger zone.** When a live workspace's agent is running, the note "Pause the agent first, so
no cycle runs while the workspace is deleted." carries a **Pause the agent** button, in the section and in the
delete dialog. It pauses with the reason "Before deleting this workspace", which every page then shows. The page
refreshes, the note goes, and the delete button can be enabled. In the dialog the note sits beside the delete form,
not in it, since it holds a form of its own. The console link stays for anyone who would rather pause there. The
account deletion dialog shows the same note inside its own form, so there it keeps the console link alone.

## Considered and left as they are

- **Each section renders once.** A full-page capture of Settings can show a stretch twice where its seams meet; the
  page itself draws every section from one list, and `tests/settings-sections.test.tsx` holds that.
- **Text size and contrast.** Body text is 14 px and helper text 12 px; every text and surface pair is held to 4.5:1 by
  `tests/ui-tokens.test.ts`.
- **Two columns** for pairs of cards. The contents column uses the width on a wide screen, and a 520 px pane would
  stack the pairs anyway.
- **A row menu, a copy button for the key prefix, relative "last used".** Each key row has one action, and the prefix
  identifies a key but cannot be used as one.
- **Renaming status badges.** "Live" on Go live and on the USYC reserve each sit in their own section's header, next
  to what they describe.

## Tests

- `tests/settings-sections.test.tsx`: groups render in order with labels; the contents link every shown section's
  heading id; a `null` section and an empty group are left out of both.
- `tests/api-keys-panel.test.tsx`: active keys in the table, revoked keys only in the fold with their day, the
  header's counts, "No active keys."
- `tests/slack-panel.test.tsx`: the label and value rows; Save disabled until the amount changes.
- `tests/delete-workspace-panel.test.tsx`: the pause form, with its reason, in the section and beside the dialog's
  form; none once paused. `tests/delete-account-ui.test.tsx`: the account dialog's note holds no form.
