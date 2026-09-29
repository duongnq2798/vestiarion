# Control: the approval inbox and the agent's pause switch

Tier 1 of the "demo to usable product" work. It follows Tier 0, the identity and tenancy design (`2026-09-27-identity-and-tenancy-design.md`), which defined the permissions this tier wires up:
- `approval.decide`: owner, admin, approver;
- `agent.pause`: owner, admin, approver;
- `agent.resume`: owner, admin.

Decided on 2026-09-29 by the implementer under the partner's standing instruction to decide and proceed. Each decision below states its reason, so it can be revisited.

## 1. The problem

The agent refuses to pay some payables on its own, and it is right to:
- **Guardrails** (`src/lib/agent/guardrails.ts`) refuse a payment:
  - above a counterparty's payment limit, as `held`;
  - to a high-risk counterparty, as `flagged`;
  - of a bill that repeats one already settled, as `flagged`.
- **The model** itself can answer `hold`, `flag_fraud` or `request_info`.

Those invoices then wait. The follow-up stage (`src/lib/agent/follow-up.ts`) reopens one when its facts change, and escalates when nothing changes. The console's "Needs you" tile counts them.

But nothing lets a person decide. A held invoice over a limit that the owner is happy to pay can only be paid by raising the limit and waiting for a cycle. A flagged false positive can never be cleared. And nobody can say no: a bill that should not be paid stays in the obligations forever, and keeps holding cash out of the treasury.

There is also no way to stop the agent. If something looks wrong (a bad model answer, a compromised counterparty, a misconfigured limit), the only stop is removing credentials.

## 2. What this tier builds

1. **An approval inbox** at `/o/[slug]/approvals`. It lists every payable waiting on a person: `held`, `flagged` and `awaiting_info`. For each one it shows:
   - the counterparty;
   - the amount;
   - the due date;
   - why the agent stopped: its reasoning, and the guardrail rule if a guardrail stopped it;
   - when it stopped.
2. **Three decisions per invoice**, for anyone with `approval.decide`:
   - **Approve and pay:** the payment is executed now, not at the next cycle.
   - **Reject:** the invoice becomes `rejected` and leaves the obligations.
   - **Return to the agent:** the invoice goes back to `pending`, and the next cycle decides it again. This is for when the facts were fixed elsewhere.
3. **A pause switch** for the workspace's agent.
   - Anyone with `agent.pause` can pause it, with a short reason.
   - Only `agent.resume` can resume it. This asymmetry is from §7 of the Tier 0 spec: anyone who can approve money leaving can stop it, and starting again is deliberate.
4. **A ledger entry for every decision, pause and resume.** Each carries the acting person's user id, never an address.

Out of scope, recorded in §9: contractor milestones in the inbox, editing an invoice's facts from the inbox, notifications, and approval thresholds or multi-person approval.

## 3. Decisions

### D1. Approve and pay executes immediately

- **Why.** An approver cannot run a cycle, since `agent.run_cycle` is owner/admin only, and the cron runs every six hours. "Approve" that pays hours later, or never while the agent is paused, is not an approval an operator can rely on.
- **Rejected alternative.** Mark the invoice `approved` and let the next cycle pay it. Its only advantage was reusing the cycle's path, and D2 gets that by sharing the payment step instead.

### D2. One payment step for the agent and the human

The payment in the AP stage moves into a function both callers use, `payInvoice` in `src/lib/agent/pay.ts`. It covers:
- the operating account lookup;
- the live balance check;
- `executePayment` with its idempotency key;
- the status that follows from the transfer's result (`paid`, `matched` when pending, `held` when failed);
- the operating balance sync.

The agent and the human then cannot drift apart. Money moves through one code path, still guarded by `payment_intents`: an invoice is paid at most once, however many people click.

### D3. What a person may override, and what they may not

A person's approval overrides:
- the payment limit (the approval is the point);
- a duplicate flag: the person confirms the bill is not a repeat;
- the model's own `hold`, `flag_fraud` and `request_info`.

It never overrides:
- **A high-risk counterparty.** Screening may mean sanctions, and a click does not make a sanctioned payment lawful. The inbox offers only Reject or Return for such an invoice, and the server refuses the approval, with the message "This counterparty is screened high risk. Clear it in Compliance first." Once screening clears, the follow-up stage reopens the invoice on its own.
- **Insufficient funds.** The transfer would fail anyway, and the person should see why before it is attempted. In live mode the balance is read from the chain, as the cycle's reconcile stage does.

### D4. No one approves what they created

`invoices.created_by`, added in Tier 0 for exactly this, is compared with the approver:
- a person who created the invoice may Reject it or Return it, but not Approve and pay it;
- invoices created by the agent's importers or by seed data have a null `created_by`, and anyone may approve those.

The check runs in the server action and again inside the claim (D5), so a crafted request cannot skip it.

### D5. A decision claims the invoice first

A decision starts with a compare-and-set in the database, `claim_invoice_decision(p_org_id, p_invoice_id, p_by, p_decision)`. It is a tenant function with invoker rights, so RLS confines it:
- it moves the invoice from a waiting status to `processing` only if it is still waiting;
- for an approval, it refuses when `created_by = p_by`;
- it returns the row.

This covers two races:
- two people deciding the same invoice at once: the second one is told it was already decided;
- a person and the follow-up stage reopening it in the same moment.

After the claim:
- Approve and pay runs `payInvoice`, which ends in `paid`, `matched` or `held`, as the agent's path does.
- Reject sets `rejected`.
- Return sets `pending`.

The claim also sets `reviewed_by` and `reviewed_at`. An invoice left in `processing` by a crash is reported by the inbox as "being decided" for 10 minutes after `reviewed_at`. After that anyone may claim it again. The payment's idempotency key still prevents a double payment.

`processing` is a new invoice status (migration 0025). It is not an open obligation for the forecast, and the agent's AP stage does not select it.

### D6. Pausing stops the agent, not the people

While a workspace is paused:
- **The cron skips it.** The tick response says `{"slug":…, "ok":true, "skipped":"paused"}` for it, and nothing is written to its ledger.
- **The console's Run button is disabled.** The action refuses with "The agent is paused." The agent also refuses a cycle that starts anyway: `begin_cycle_run` raises `agent_paused`.
- **A cycle already running stops moving money.**
  - Before each payment, the AP and contractor stages re-read the pause flag. A paused workspace's pending payment is recorded as `held`, with "[not paid: the agent was paused]".
  - Before each deposit to or withdrawal from the reserve, the treasury stage re-reads the flag too. A paused workspace's move is recorded as not executed, with "[not moved: the agent was paused]".
  - Each of these ledger entries carries `heldBecause: "agent_paused"`.
  - A failure to read the flag stops the stage rather than paying.

Human decisions in the inbox continue while the agent is paused. Pausing is how you stop the automation, and an approval is a person's own deliberate act. Stopping people as well would make the switch unusable during exactly the incident it exists for, when someone must still pay the one bill that matters.

### D7. Where the pause lives

The columns are on `orgs`:
- `agent_paused_at timestamptz`;
- `agent_paused_by uuid references auth.users on delete set null`;
- `agent_pause_reason text`, at most 280 characters.

Three functions change them or read them:
- `pause_agent(p_org_id, p_actor, p_reason)` and `resume_agent(p_org_id, p_actor)` are service-role functions in the style of `0021`. Each re-reads the actor's role: pause requires owner, admin or approver; resume requires owner or admin.
- `agent_paused(p_org_id) returns boolean` is a security-definer function the tenant role may call. The running cycle and `begin_cycle_run` read the flag through it, because the tenant role has no access to `orgs`.

The pause belongs to the platform row: it is the workspace's state, not tenant data, and the cron reads it before entering any scope.

## 4. Data

Migration `0025_control.sql`. It is idempotent, and runs as `db:migrate` replays it.

- **`invoices.status`** accepts `processing`. `rejected` is already allowed since `0001`. The constraint is rebuilt by name, following `0019`'s shape-based pattern.
- **`invoices`** gains:
  - `reviewed_by uuid references auth.users on delete set null`;
  - `reviewed_at timestamptz`.
- **`orgs`** gains the pause columns from D7.
- **Functions:**
  - `claim_invoice_decision` (D5): invoker rights, executable by `vestiarion_tenant`;
  - `pause_agent` and `resume_agent` (D7): service role only;
  - `agent_paused` (D7): definer, executable by `vestiarion_tenant` and the service role;
  - `begin_cycle_run` from `0022`, which now also raises `agent_paused: …`.
- **Ledger actions**, with `domain` in brackets:

| Action | Domain | detail |
|---|---|---|
| `approval_paid` | `ap` | `{ by, invoiceId, counterpartyId, amount, overrode: <the status it waited in: held, flagged or awaiting_info>, txRef, status }` |
| `approval_rejected` | `ap` | `{ by, invoiceId, reason? }` |
| `approval_returned` | `ap` | `{ by, invoiceId }` |
| `agent_paused` | `system` | `{ by, reason }` |
| `agent_resumed` | `system` | `{ by, pausedFor: <seconds> }` |
| `ap_reconcile` | `ap` | `{ invoiceId, counterpartyId, reconciled: true, previousStatus: "matched", execution }`: a `matched` payable with a payment intent, reconciled through `payInvoice` instead of decided again (added in the final fix pass) |

- **`OPEN_PAYABLE_STATUSES`** stays `pending`, `matched`, `held` and `awaiting_info`:
  - `processing` is transient and is not an obligation;
  - `rejected` is final.

## 5. Interface

- **Navigation.** `Approvals` goes in the Controls group, before Compliance. It shows a count when anything is waiting. The console's "Needs you" tile links to it.
- **The inbox page** (`/o/[slug]/approvals`) is a list of cards, one per waiting invoice, oldest due date first.
  - Each card shows the counterparty, the amount, the due date, the status, why the agent stopped and when.
  - People with `approval.decide` see the three buttons.
  - Approve and pay opens a confirmation: "Pay <amount> USDC to <counterparty> now?" For a sandbox it adds "(simulated)".
  - Reject takes an optional reason, at most 280 characters, which is stored in the ledger, not on the invoice.
  - A viewer sees the list without buttons.
- **The pause control** sits in the console header, next to Run cycle now.
  - When the agent is running: a "Pause agent" button (for `agent.pause`), which opens a dialog asking for a reason.
  - When paused: a banner on every workspace page, "The agent is paused since <time> by <name>: <reason>", plus a "Resume" button for `agent.resume`.
  - The banner comes from the workspace layout, which already reads platform data.

The pages use the component system from `2026-09-28-component-system-design.md`: its button, dialog, card, badge and callout primitives.

## 6. Error handling

| Situation | Result |
|---|---|
| Invoice already decided by someone else | "Someone else decided this invoice a moment ago." The page refreshes. |
| Approver created the invoice | "You created this invoice, so someone else must approve it." |
| High-risk counterparty | "This counterparty is screened high risk. Clear it in Compliance first." |
| Not enough funds | "The operating account holds <n> USDC, less than this invoice." |
| Transfer failed | The invoice is `held` with the provider's reason, and the ledger records `approval_paid` with the failed status. The person sees "The transfer failed: <reason>. The invoice is held." |
| Agent paused, Run cycle now | "The agent is paused. Resume it to run a cycle." |
| Resume by an approver | Refused: "Only an owner or admin can resume the agent." |

## 7. Testing

- **PGlite:**
  - `claim_invoice_decision`: the compare-and-set, the self-approval refusal, and RLS confinement;
  - pause and resume role checks;
  - `agent_paused` for the tenant role;
  - `begin_cycle_run` refusing while paused;
  - replay.
- **The shared `payInvoice`** keeps the AP stage's existing tests green. The existing orchestrator tests are the regression net for D2.
- **The actions:**
  - permission literals, as `tests/access-gates.test.ts` requires;
  - each refusal message;
  - Approve and pay calling `payInvoice` once;
  - a claim that loses the race not paying.
- **The cycle:**
  - a paused workspace pays nothing, and its payable becomes `held` with the pause note;
  - the cron skips a paused workspace.

## 8. Rollout

1. Apply `0025` before the merge. It is additive: the old code never writes `processing` and never reads the pause columns.
2. Merge, then measure:
   - the cron cycle for founding is unchanged;
   - in `note-one`, create a payable over a counterparty's limit; the agent holds it; approve it from the inbox; it is paid (simulated), with an `approval_paid` entry;
   - pause `note-one`: Run cycle is refused, and the banner shows; resume it.
3. Record the outcome in this spec.

## 9. Out of scope, for later

- **Contractor milestones** that are held. Their verification has its own path (`manualMilestoneVerificationAction`), and it is already a human override.
- **Editing an invoice's purchase order or goods-received flag** from the inbox, which would let an `awaiting_info` invoice be completed in place. Until then, Return to the agent after fixing the facts where they come from.
- **Notifications** of new items waiting (Tier 2), approval thresholds, two-person approval, and delegation.
