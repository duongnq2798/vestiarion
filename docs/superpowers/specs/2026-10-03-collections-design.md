# The agent reminds clients of what they owe

Date: 2026-10-03. Status: in progress on `feat/collections`. Designed under the standing autonomy grant; each ruling
carries its cost if wrong.

## 1. Why

Receivables on Arc (2026-10-01) gave a client a pay link and matched what arrived. After that, nothing happens:

- A link is sent once, by hand, and nobody follows up.
- A client who forgets is never reminded, and a late payment is noticed only by someone reading AP / AR.
- The agent decides when to pay what the business owes, but never acts on what it is owed.

Chasing a late invoice is a judgement call: when to remind, how firmly, when to stop and leave it to a person. That
is the kind of decision this agent exists to take, explain and keep inside bounds.

## 2. What it does

- **An owner or admin turns reminders on, per receivable.** On **AP / AR**, under the receivable, **Remind the client
  by email**. It needs the client's billing email and an open receivable in a live workspace.
- **The agent decides when, within code's bounds.** Each cycle, for each receivable whose reminders are on and where a
  reminder is allowed now, the model decides whether to send one now or wait, and how firmly. The written policy's
  answer is computed beside it and recorded.
- **The email carries the pay link.** Same link every time; the client pays on Arc testnet and the agent matches the
  transfer as before.
- **It stops.** When the receivable is received or rejected, after the last reminder, or 30 days past its due date.

## 3. Rulings

- **R1 — opt-in per receivable, by an owner or admin (`records.write`, as the pay link).** No client is emailed
  because a receivable exists. Turning on is signed as `ar_reminders_on`, off as `ar_reminders_off`, with the person.
  Turning on raises the cycle event `reminders_on`, so a reminder already due goes within a minute. Cost if wrong:
  one click per receivable.
- **R2 — the link can be read again.** A pay link now keeps its token encrypted (`receivable_links.token_enc`,
  AES-256-GCM under the platform master key, bound to the workspace and the column), beside its SHA-256 as before.
  The receivable's card can show the link again, and every reminder carries the same link. A link made before this
  has no copy: turning reminders on for it makes a new link, which replaces it, and the card says so. Cost if wrong:
  a link sent before 2026-10-03 stops working when reminders are turned on for it.
- **R3 — when a reminder is allowed (code).** All of:
  - the workspace is live, and the receivable is open (`pending` or `matched`);
  - reminders are on, the client has a billing email, and the link has its token;
  - today is no earlier than 3 days before the due date, and no later than 30 days after it;
  - no reminder in the last 3 days, and fewer than 4 sent;
  - no wait the model chose is still running.
- **R4 — the written policy's schedule.** One reminder at each of: 3 days before the due date, the due date, 3 days
  after it, 10 days after it. Friendly up to the due date, firm after it, final for the fourth. The reference sends
  when the next step's day has come.
- **R5 — the model decides, code bounds the tone.** The model answers `send` or `wait` (1 to 3 days), a tone, and its
  reasoning. Friendly is always allowed; firm only after the due date; final only 7 or more days after it with at least
  2 reminders sent. A stronger tone than allowed becomes the strongest allowed, and the reasoning says so. A wait is
  signed as `ar_reminder_deferred`, with its end, and the model is not asked again before then.
- **R6 — the email is a template.** Subject, heading and lead by tone; the amount, what it is for, the due date, how
  late it is, and **Pay on Arc testnet** opening the pay link. Nothing the model wrote reaches the client. Cost if
  wrong: reminders read alike.
- **R7 — each reminder once.** A reminder is claimed before it is sent: a row in `ar_reminders`, unique per receivable
  and number. A failed send deletes the row, and the next cycle may try again. Signed as `ar_reminder_sent`.
- **R8 — the billing email.** The counterparty's one email (`notice_email`) serves both directions: a payee is told
  each payment (payment notices), a client gets the reminders turned on. The form and the edit dialog call it
  **Billing email**.
- **R9 — fail closed.** The `collections` stage runs after `proposals` and needs `receipts`: if the cycle could not
  read what arrived, it does not remind anyone who may just have paid. A sandbox never emails a client.

## 4. Pieces

- Migration `0065_collections.sql`: `receivable_links.token_enc`, `reminders_on_at`, `reminders_on_by`,
  `reminder_deferred_until`; table `ar_reminders` (number 1–4, tone, sent_at; unique per receivable and number;
  tenant RLS as 0062).
- `src/lib/collections.ts`: the pure rules (R3–R5): what is allowed, the reference, the tone bounds.
- `src/lib/agent/collections.ts`: the stage: read, decide, claim, send, sign.
- `src/lib/email/receivable-reminder.ts`: the template (R6).
- `src/lib/platform/pay-links.ts`: the encrypted token, the link read back, reminders on and off.
- AP / AR: the link shown again, and the reminders control with what was sent.
- The decision trail tells `ar_reminders_on`, `ar_reminders_off`, `ar_reminder_sent` and `ar_reminder_deferred`, and
  a receivable's card now shows its trail; the agent's activity tells `ar_reminder_sent`.
- The billing email on the counterparty form, its row (for every role now) and its edit dialog.
- Docs: the first-payment guide's "Let the agent remind the client", with a screenshot; the billing email; the
  changelog; the README (receivables, and the cycle's stages, held to `CYCLE_STAGES` by a test); ARCHITECTURE's
  emails to counterparties.

## 5. Rollout

1. The partner applies 0065 before the merge (the code reads its columns).
2. In testnet-2: a client with the partner's own billing email, a receivable of 0.5 USDC due today, a pay link,
   **Remind the client by email**.
3. Within a minute: `ar_reminder_sent` (friendly, due today) and the email arrives with the link.
4. The partner pays it from another wallet through the link; the agent matches it (`ar_received`), and no further
   reminder is sent.

### Done, 2026-10-03 (PR #165, merged as 683829b)

**Migration.** Applied by the partner before the merge, as 0064, then renumbered `0065_collections.sql` (same content)
because the Telegram bot's branch had taken 0064. A read-only check after the run confirmed:
- the four `receivable_links` columns, with `reminders_on_by` set to null when its user is deleted;
- `ar_reminders`: its checks, the unique key per receivable and number, and the composite foreign key to invoices;
- RLS on, with the permissive and restrictive tenant policies, and no grants to anon or authenticated;
- 0038, 0061, 0062 and 0063 intact after the replay.

**Testnet-2.**

| Time (UTC) | Entry | Step |
|---|---|---|
| 07:49:17 | #1082 `create_invoice` | A receivable of 0.50 USDC from Ho Client, due Oct 3, with the partner's own address as its billing email. |
| 07:50:10 | #1083 `pay_link_created` | Made by **Remind the client by email**, since the receivable had no link. |
| 07:50:11 | #1084 `ar_reminders_on` | `madeNewLink: true`. |
| 07:50:39 | #1087 `ar_reminder_sent` | DeepSeek, as the written policy would: reminder 1, friendly, on the due date. Resend: delivered, subject "testnet-2: 0.50 USDC due today". |
| 07:51:46 | — | The client paid 0.50 USDC through the link: tx `0xd97387354b0f88f9fe9b4baef4b20f534cbeaa61351c29d10721f7970f403ab8`. |
| 07:52:01 | #1089 `ar_received` | Matched by the sender, the client's address on file. No further reminder. |

**Found while testing, fixed in the PR that records this:**
- The toast said "a link sent before no longer works" when the receivable had no link at all.
  `ar_reminders_on` now records `replacedLink`, and the toast mentions an old link only when one was replaced.
- A first try entered the receivable as a payable: see 2026-10-03-client-payables-design.md.
- The same test window showed a treasury redemption of nearly the whole reserve: see
  2026-10-03-treasury-bounds-design.md.
