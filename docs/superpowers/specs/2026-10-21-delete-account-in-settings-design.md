# Delete account lives in Settings, not in the account menu

Date: 2026-10-21. Status: accepted.

## Why

**Delete account** was the last row of the account menu (spec §6, A1), the menu that opens from the email address at
the foot of the workspace sidebar and from the initial at the top of the workspaces page. That menu is where people go
to switch workspaces or sign out, many times a day. A red, irreversible action one row below **Sign out** is one slip
of the pointer away. The dialog behind it asks for a typed phrase, so nothing is lost by a misclick, but the row itself
reads as an everyday choice, and it is not where anyone looks for it. People look for deleting an account in settings,
at the bottom, under a danger zone, as **Delete workspace** already is.

## What

**DA1. The account menu holds no danger row.** It keeps who is signed in, the page's own rows (Create workspace, All
workspaces), **Account settings** and **Sign out**. **Account settings** opens `/account`.

**DA2. `/account` is the account's own page.** Any signed-in person reaches it, with or without a workspace: it says
which email is signed in, and ends with **Danger zone**, holding **Delete account**. It opens the same dialog as before,
with the same plan, rules and typed phrase. Someone with no workspace yet, or an accountant on `/accountant`, deletes
their account here.

**DA3. Settings ends with it too.** Inside a workspace, **Settings** ends with **Danger zone**: **Delete workspace** for
an owner, then **Delete account** for every member, whatever their role, since deleting an account needs none.

**DA4. Nothing else changes.** The dialog, `accountDeletionPlan`, `deleteAccount` and the action are untouched.

## Docs

- The privacy page's "Deleting your account" says where it is now.
- ARCHITECTURE's paragraph on deleting an account.
- CHANGELOG, under Changed.

## Tests

- The account menu has no danger row and no deletion dialog; it links to `/account`.
- `/account` and Settings each render **Delete account** inside a danger zone, Settings for any role.
- The privacy page names Settings and `/account`, not the menu.
