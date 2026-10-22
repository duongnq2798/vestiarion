# "Was this you?": the payee's contact checks an address change

Date: 2026-10-22. Status: accepted.

## Why

A changed payout address is how payment redirection usually arrives. Someone with a member's session, a forwarded payee
link or a lookalike email changes where a payee is paid, and the next payment goes to them. The payee lock
(`2026-10-20-payee-lock-design.md`) makes a member check the change with the payee by a contact they had before. But it
relies on a member making that call.

The payee's own contact is the one person who knows for certain whether they changed it. Banks send exactly this
message: "Your payment details were changed. If this was not you, tell us." Vestiarion has that contact on file, the
counterparty's notice email, and nobody asks it.

## What

**AC1. When the contact is asked.**
- A counterparty's address changes to a new one, by any path:
  - a member's edit on Counterparties;
  - the payee's one-time link;
  - `/payto` on GitHub.
- The workspace is live, not in shadow mode, and does not simulate its payments.
- The counterparty has a notice email on file.
- One email goes to that notice email: the contact on file when the change was made.
- These do not ask: a first address (none before), a cleared address, a sandbox, shadow mode, and a payee with no
  notice email.
- A change to a new address after the address was cleared asks too, about the address it had before, read from its
  signed entries. So clearing then setting cannot skip the check.
- A newer change replaces an open check, and the older link stops working. An ask that runs late, after the address
  changed again, makes nothing: the newer change's own check stands.
- The check is made after the change is written. A failure to ask never undoes the change: it is logged, and the
  change still waits for a member's confirmation as before.

**AC2. The email.**
- Subject: "Did you change where {business} pays you?"
- It shows the address before, shortened, and the new address in full.
- It says when the address changed and how:
  - "through your payment link";
  - "by someone at {business}";
  - "on GitHub, by @login".
- One button, "Review this change", opens the check's page. The link works once, for 7 days, and needs no account.
- Only the link's SHA-256 is kept (`vxw_` tokens).

**AC3. The page, `/address-change/{token}`.**
- It shows the business, the payee's name, both addresses and how the address changed, with two buttons:
  - **Yes, I made this change**;
  - **No, this wasn't me**.
- Opening the page changes nothing, so a mail scanner that follows the link answers nothing.
- An answer is taken once. A used, replaced, expired or unknown link shows one sentence and names no one.
- **Yes** is recorded and shown to the business beside the address. It confirms nothing: confirming stays a member's
  check.
- **No, this wasn't me**, while the address in question is still on file, freezes the payee:
  - its address's confirmation is withdrawn, so every payment to it waits again, as for any unconfirmed address;
  - confirming it is refused until an owner or admin unfreezes the payee. This covers **Confirm address** on
    Counterparties and **Approve and pay**, which confirms an address when the payee lock is off.
  - No approval pays it, to its address or its bank account: Approve and pay and Pay now refuse it before their claim,
    and again after it, for a freeze that lands meanwhile.
  - The owners and admins get an email.
- **No** when the address has changed again since is recorded, and the owners and admins are still emailed. Nothing is
  frozen: the address in question is no longer on file.

**AC4. Unfreezing.**
- An owner or admin unfreezes the payee on Counterparties, saying how they settled it. The note is required.
- The member whose edit made the disputed change does not unfreeze it while another owner or admin can.
- The unfreeze is signed with the note, or put back: no unfreeze stands unrecorded.
- The tenant role never sets or clears a freeze itself: a trigger refuses it, and only the functions below do.
- The address still needs confirming afterwards, under the payee lock's rules when it is on.
- Changing the address back is the usual edit, and asks the contact again.

**AC5. Where it shows.**
- Counterparties shows the check on the payee's row:
  - asked, with no answer yet;
  - "Their contact said this was them";
  - "Frozen: their contact said they did not make this change", with **Unfreeze** for an owner or admin.
- Approvals' card for a frozen payee says so, and that confirming waits for an owner or admin.
- New ledger entries, listed by `GET /api/v1/ledger` and sent as `ledger.appended`:
  - `address_change_check_sent`;
  - `address_change_answered`;
  - `counterparty_frozen`;
  - `counterparty_unfrozen`.
- Nothing in `/api/v1` request bodies or the webhooks' shapes changes.

## Data

Migration `0137_address_change_checks.sql`:
- `address_change_checks` holds:
  - the workspace and the counterparty;
  - the member whose edit changed the address, when one did;
  - the address before and after, and how it changed (`member`, `payee_link` or `github`);
  - the token's hash;
  - its status: `open`, `confirmed`, `disputed` or `replaced`;
  - when it was made, when it expires and when it was answered.

  The workspace reads its own rows under RLS. Every write goes through these functions, run by the service role:
  - `create_address_change_check`;
  - `address_change_check_preview`;
  - `mark_address_change_check_sent`;
  - `answer_address_change_check`;
  - `unfreeze_counterparty` and `restore_counterparty_freeze`.
- `counterparties.frozen_at` and `counterparties.frozen_check_id`.
- `answer_address_change_check` takes the answer and freezes the payee in one step. It withdraws the confirmation only
  while the address on file is still the one in question.
- Before 0137, nothing is asked and nothing is frozen. Every read of the new columns treats their absence as none.

## Not in this change

- Asking by SMS or by phone.
- An email to the notice email that was on file before the notice email itself changed.
- Freezing payees on any signal other than this answer.

## Tests

- **When the contact is asked:**
  - asked on a change to a new address, from the one on file or one cleared before;
  - not asked for a first address, a cleared address, a sandbox, shadow mode or no email;
  - a newer change replaces the open check.
- **The email:** its words for each path, and its link.
- **The page:**
  - a preview that changes nothing;
  - Yes recorded, confirming nothing;
  - No freezing the payee and withdrawing the confirmation only while the address is on file;
  - a second answer refused.
- **Confirming:** refused while frozen, by Confirm address and by Approve and pay. Unfreezing needs a note and an owner
  or admin.
- **The migration:** idempotent, RLS, the functions' checks.
- **Counterparties and Approvals:** what each shows.
