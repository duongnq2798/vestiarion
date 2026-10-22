# Accountant co-sign (2026-10-22)

## Why

A small business that runs Vestiarion alone has one person who can approve payments. Its control is two approvals
above a figure, which needs two such people. On Arc mainnet a figure always stands. So above it, the founder cannot pay
at all, or must make someone an approver, which lets that person pay.

Most of these businesses already have a second person they trust with their books: the outside accountant. The
accountant role reads everything and decides no payment. The usual control in small-business finance is the
accountant as the second key:
- the owner pays;
- the accountant countersigns what is large;
- the accountant checks a changed bank detail;
- the accountant never presses pay.

Co-sign gives the accountant exactly that, behind an owner's switch, and nothing more.

## Rules

**CS1. The setting.**
- One column on `approval_policies`, migration 0138: `accountant_cosigns boolean not null default false`.
- An owner turns it on or off in **Settings → Two approvals** (`approval.policy`, as the figure is).
- Each change is signed as `accountant_cosign_changed { by, from, to }`.
- Before migration 0138 the column is missing:
  - the setting reads off;
  - turning it on is refused with "Co-signing is not available in this workspace yet."
- Turning it off is always allowed. It is the safe direction: fewer people stand behind payments.

**CS2. What co-signing is.** With the setting on, a member whose role is accountant may co-sign a bill (a payable) that
needs two approvals:
- a co-sign is a recorded approval of the payment as it stands: its amount, currency and payee address;
- it is kept in `payment_approvals`, as a first approval is;
- it sends nothing, ever, even when another person's approval already stands;
- the payment is paid by an owner's, admin's or approver's **Approve and pay**, with the co-sign as the other approval.

**CS3. What a co-sign is refused for.** Each refusal applies before anything is recorded, in the words an approval gets:
- A bill that does not need two approvals: "Only a payment above the figure for two approvals is co-signed." Below the
  figure one approval pays, and the accountant gives none.
- A bill being decided, screened high risk, frozen, or held by the payee lock.
- A bill whose address changed since the card was shown.
- A bill paying a commission to the accountant.
- A bill the accountant already co-signed: "You already co-signed it."
- Payments off, by the platform or the network.

It goes through the same checks as an approval, in the same function, up to the point where an approval would pay. It
returns there, and a guard refuses any co-sign that reaches the claim.

**CS4. When a co-sign counts.** A co-sign stands as one of the two approvals only:
- while the setting is on;
- while its giver is still an accountant of the workspace;
- while it agrees with the payment's amount, currency and address.

`approvers_among`, which the paying approval and the database's claim both ask for a bill, counts accountants only
while the setting is on (migration 0138 redefines it). A milestone's approvals are read with the new `deciders_among`,
owners, admins and approvers only, so an approver moved to accountant gives no milestone approval that counts. Turning the setting off or changing the person's role leaves the co-sign
on file, counting for nothing, as an approval by someone removed does.

**CS5. Who counts as a second person.** For bills, with the setting on, accountants count among the people who can give
one of the two approvals, through the new `cosigners_besides`:
- when an approval is refused because only one person can approve;
- in how many of the two approvals whoever entered a bill may give;
- in the Settings line that counts who can approve;
- when an owner lowers the figure or turns it on.

A co-sign is never the approval that pays, so accountants fill one of a bill's two approvals at most. However many
co-sign, they count as one:
- when an approval is refused because only one person can approve;
- when whoever entered a bill gives one of its approvals because too few others can.

So with two accountants and no other approver, the founder still gives the approval that pays. A founder alone with a
co-signing accountant can turn on two approvals, and pay above the figure with the accountant's co-sign. Settings counts
every co-signing accountant in its line of who can approve. It also says that a milestone above the figure still needs two
people who can approve payments. Contractors' milestones are not co-signed, so for them nothing changes. A count that cannot be
read is taken as zero: the workspace then behaves as it did before co-signing.

**CS6. Confirming addresses.** With the setting on, an accountant may **Confirm address** on Counterparties:
- the confirmation takes the same record of how the address was checked as anyone else's (payee lock PL2);
- it counts as another member's confirmation, for the payee lock's second-person rule (PL3), the evidence pack, and the
  new payee check (N4), so the agent then pays that address as usual, a first payment included, within its limits;
  turning co-signing on says so;
- whoever entered an address may confirm it alone only when no one else may, and a co-signing accountant counts as
  someone else.

**CS7. Never pays.** The accountant still has no Approve and pay, Reject or Return. The co-sign action requires both:
- `approval.cosign`, a new permission held by the accountant alone;
- the setting on.

The approve action requires `approval.decide`, which the accountant does not hold. The co-sign returns before the
paying half of the approval. A test proves that a co-sign never claims the bill and never reaches the payment
provider, whatever approvals stand.

**CS8. What people see.**
- **Accountant, in Approvals:** a bill above the figure gives the accountant **Co-sign**, behind a confirmation: "This
  records your co-sign of {amount} to {payee} and sends nothing. An owner, admin or approver's Approve and pay then
  pays it." Once given, the card says "You co-signed it."
- **Owners, admins and approvers:** the card names the accountant among who approved it. It says when their Approve and
  pay is the one that pays.
- **Settings:** under the figure, **Accountants co-sign**, for the owner, with what it allows and what it never does,
  and how many accountants it adds.
- **Ledger:** a co-sign's `approval_given` entry carries `cosign: true`, and its summary says the next approval by an
  owner, admin or approver pays it.

## Not in this change

- A queue of what waits for an accountant's co-sign in the accountant console. That is the next item.
- Co-signing contractors' milestones.
- A co-sign that blocks a payment: no approval does today.
