# Bring in a second person

Date: 2026-10-19. Status: built. Branch `feat/invite-nudge`. No migration.

## Why

No customer workspace had a second member (activation funnel, Oct 9). A workspace run by one person misses two things.
Nobody checks the maker: the new-payee check lets the only approver approve a first payment to an address they gave.
And the business's accountant, who would read the books, never sees them. The approver and the accountant are people the
business already works with, so they are the easiest real users to add. Today nothing asks for them: Members is a page
an owner has to think of opening.

## The rules (decided here)

- **I1. Where.** On Treasury (the console), one card under Get started, for an owner or admin (`members.manage`). It
  shows when:
  - the workspace has exactly one member and no open invitation;
  - the agent has decided at least one real bill, so the card comes once the workspace has shown what it does;
  - and it was not put off in this browser in the last 30 days.
- **I2. What it says.** "You run this workspace alone." Then two rows, each with its role's reason, an email field and
  **Invite**:
  - **An approver**: decides the payments the agent holds. "Once an approver joins, a first payment to an address you
    gave needs their approval, not yours alone." (An accountant decides no payment: with one, the owner is still the
    workspace's only approver.)
  - **Your accountant**: the accountant role's own summary: reads everything, books payments, decides no payment.
  - **Not now** hides the card in this browser for 30 days. A first-party cookie, `vx_invite_later`, is set on the
    workspace's own path; it holds no more than that.
  - Once an invitation is sent, the card says so where it stood: the email it went to, or the link to share when email
    is not set up. Once shown, the card stays until the page is opened again, since the invitation's result arrives with
    the page re-read in the same response.
  - The console reads the members only when nothing else rules the card out.
- **I3. The same invitation.** It goes through `inviteMember`, so the usual rules hold: the permission, the 50-a-day
  limit, the email, and the link shown once when email is not set up. Each person invited gets their own role's
  checklist.
- **I4. The weekly brief.** When the workspace has one member and no open invitation, the brief ends with "You run {name} alone on Vestiarion.
  Invite your approver or your accountant:" and a link to Members, with the approver role already chosen.
- **I5. Recorded.** `member_invited` gains `via`:
  - `console_nudge` for an invitation sent from the card;
  - `weekly_brief` for one sent from Members when it was opened through the brief's link.
  - Members passes `via` only when it was opened that way, and only `weekly_brief`. An invitation sent any other way has no `via`, as before.
- **I6. Gone.** The card goes once a second member joins or an invitation is open. It never shows to an approver, an
  accountant or a viewer.

## What it does not do

- Invite anyone on its own, or email anyone but the person whose address is typed in.
- Change who may invite, or which roles an admin may give.
