# Control: the approval inbox and the agent pause switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People with `approval.decide` can pay, reject or return the payables the agent refused to pay on its own. Anyone with `agent.pause` can stop the agent, and only `agent.resume` restarts it.

**Architecture:**
- **Migration `0025`:**
  - adds the `processing` invoice status and review columns;
  - adds the pause columns on `orgs`;
  - adds `claim_invoice_decision`, a tenant compare-and-set;
  - adds `pause_agent`/`resume_agent`, service-role functions that re-check the actor's role;
  - adds `agent_paused`, a definer boolean readable by the tenant role;
  - makes `begin_cycle_run` refuse while paused.
- **One payment step.** The AP stage's payment step moves into `src/lib/agent/pay.ts`, and the human path uses the same function.
- **Libraries:**
  - `src/lib/agent/approvals.ts` holds the three decisions;
  - `src/lib/platform/pause.ts` holds pause and resume;
  - both record signed ledger entries, best-effort after the commit, like the members library.
- **Pause in the cycle:**
  - the cron skips paused organizations;
  - the AP and contractor stages re-check the flag before each payment;
  - the console's Run button is refused.
- **UI:**
  - `/o/[slug]/approvals`, with a nav item carrying a count;
  - the pause control in the console header;
  - a paused banner in the workspace layout.

**Tech Stack:** Next.js 16.3.6, supabase-js, Postgres (Supabase), PGlite, Vitest, the component system in `src/components/ui/`.

**Spec:** `docs/superpowers/specs/2026-09-29-control-design.md`. The decisions D1–D7 are binding.

## Global Constraints

- **Next.js:** read the relevant guide in `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`):
  - a layout is not a gate;
  - `params` is a Promise;
  - every page calls `requireMembership` itself.
- **Dependencies and checks:** no new dependencies. `npm run verify` is green at every commit.
- **Migrations:** they are idempotent. `scripts/migrate.ts` replays every file from `0001` each run, each in its own transaction.
- **Permissions:** from `src/lib/auth/roles.ts`:
  - `approval.decide` and `agent.pause` for owner, admin and approver;
  - `agent.resume` for owner and admin.
- **Server actions:**
  - they live in `src/app/actions/`;
  - each first awaits `authorize(slug, "<literal>")`;
  - each does its work in `return inOrg(auth, async () => …)` (`tests/access-gates.test.ts`).
- **Data access:**
  - tenant data goes through `db()`;
  - platform tables and functions go through `platformDb()`;
  - new tenant RPC names go in `TENANT_RPCS`, and platform ones in `PLATFORM_RPCS` (`src/lib/dal/index.ts`).
- **Ledger:** entries record user ids, never email addresses.
- **UI:**
  - use the primitives in `src/components/ui/`: Button, ConfirmDialog, Dialog, Card, Badge, Callout, Field, Input, SubmitButton, useActionForm, EmptyState;
  - no raw `<button>`, `<select>`, `<textarea>` or visible `<input>` outside `src/components/ui/`;
  - no colour literals;
  - every nav section needs an icon.

  These rules are enforced by tests from the component system. See `docs/superpowers/specs/2026-09-28-component-system-design.md` and the `/design` page.
- **Safety:**
  - never print secrets or tokens;
  - never run anything against the Supabase project in `.env.local` (production), never run `db:migrate`, never start a dev server;
  - SQL is tested on PGlite only.
- **Commits:** subjects are neutral descriptions, followed by a blank line and the Co-Authored-By trailer your harness mandates, committed with `git commit -F <file>`.

## Review Focus

1. **Two people press Approve and pay on the same invoice at once, or a person and the follow-up stage act at once.** Expected: at most one payment; the loser is told it was already decided. Pinned by Task 1 (the claim) and Task 4.
2. **A person approves an invoice they created, by a crafted POST.** Expected: refused by the action and again by the claim. Pinned by Tasks 1 and 4.
3. **A high-risk counterparty's invoice is approved by a crafted POST.** Expected: refused; nothing is paid. Pinned by Task 4.
4. **The agent is paused while a cycle is mid-way through AP.** Expected: no further payment; the invoice is held with the pause note. Pinned by Task 3.
5. **An approver presses Resume by a crafted POST.** Expected: refused by the action and by `resume_agent`. Pinned by Tasks 1 and 5.

## Rulings made while writing this plan

- **`overrode` records the status the invoice waited in.** Deriving the guardrail rule would mean parsing reasoning text; the rule is already in the agent's own `ap_*` entry for the same invoice.
- **The human path checks funds against the operating balance.** In live mode it reads the balance from the chain first, through the moved `syncOperatingBalance`. It does not apply the treasury's liquidity buffer: a person approving one payment is choosing to spend.
- **Pause does not stop Approve and pay** (spec D6).
- **Approvals get their own nav section, `Approvals`, in the Controls group before Compliance.** The console's "Needs you" tile links to it.

---

### Task 1: Migration 0025

**Files:**
- Create: `supabase/migrations/0025_control.sql`
- Modify: `tests/account-deletion.test.ts`. It asserts the exact number of foreign keys to `auth.users`; 0025 adds two (`invoices.reviewed_by`, `orgs.agent_paused_by`).
- Test: `tests/control-migration.test.ts`

**Interfaces (produces):**

| Function | Returns | Rights |
|---|---|---|
| `claim_invoice_decision(p_org_id uuid, p_invoice_id uuid, p_by uuid, p_decision text)` | `public.invoices` | invoker; `vestiarion_tenant`, `service_role` |
| `pause_agent(p_org_id uuid, p_actor uuid, p_reason text)` | `public.orgs` | definer; `service_role` only |
| `resume_agent(p_org_id uuid, p_actor uuid)` | `timestamptz`, the time it had been paused since | definer; `service_role` only |
| `agent_paused(p_org_id uuid)` | `boolean` | definer, stable; `vestiarion_tenant`, `service_role` |
| `begin_cycle_run(...)` | unchanged signature | now raises `agent_paused: …` first when paused |

Error codes, each raised as `'<code>: <text>'`:
- from the claim: `invalid_decision`, `invoice_not_found`, `self_approval`, `already_decided`;
- from pause/resume: `not_a_member`, `pause_not_permitted`, `resume_not_permitted`, `already_paused`, `not_paused`.

- [ ] **Step 1: Write the failing tests.** Create `tests/control-migration.test.ts`, following `tests/members-migration.test.ts` and `tests/lifecycle-migration.test.ts`. Use `createDatabase`, `applyMigrations`, `createUser`, `createOrg`, `asTenant`, `asServiceRole`, `asRole` and `seedOrgRows`. Cover:
  1. `claim_invoice_decision` as the tenant of org A:
     - a `held` payable becomes `processing` with `reviewed_by` and `reviewed_at` set, and the row is returned;
     - a second claim raises `already_decided`;
     - `approve` by the invoice's `created_by` raises `self_approval`, and the row is unchanged;
     - `reject` by the creator succeeds;
     - a `processing` row whose `reviewed_at` is 11 minutes old can be claimed again; one 5 minutes old cannot;
     - a `paid` invoice raises `already_decided`;
     - an unknown id raises `invoice_not_found`;
     - `p_decision = 'pay'` raises `invalid_decision`.
  2. As the tenant of org B, claiming org A's invoice raises `invoice_not_found`: RLS hides it.
  3. `pause_agent`:
     - by a viewer raises `pause_not_permitted`, and by a non-member `not_a_member`;
     - by an approver it sets `agent_paused_at`, `agent_paused_by` and the trimmed reason;
     - a second pause raises `already_paused`;
     - a 281-character reason is refused by the column check.
  4. `resume_agent`:
     - by the approver raises `resume_not_permitted`;
     - by the owner it clears all three columns and returns the paused-since time;
     - a second resume raises `not_paused`.
  5. `agent_paused`: true while paused and false after, as the tenant role and as the service role.
  6. `begin_cycle_run` as the tenant raises `agent_paused` while the organization is paused, and opens a run after resume.
  7. anon and authenticated cannot execute any of the new functions; the tenant role cannot execute `pause_agent` or `resume_agent`.
  8. Replaying all migrations twice succeeds.

  Seed the payable with `seedOrgRows`, which creates one invoice. Set its status with a superuser update, and set `created_by` with `createUser`.
- [ ] **Step 2: Run and see it fail.** `npx vitest run tests/control-migration.test.ts`. Expected: the functions do not exist.
- [ ] **Step 3: Write the migration.**

```sql
-- Control: the approval inbox and the agent's pause switch
-- (docs/superpowers/specs/2026-09-29-control-design.md, D5–D7).
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

-- 1. `processing`: an invoice a person is deciding right now (D5).
--    Rebuild the status check by shape, whatever it is named, only while it
--    lacks 'processing', so a replay changes nothing.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.invoices'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%status%'
       and pg_get_constraintdef(oid) not like '%processing%'
  loop
    execute format('alter table public.invoices drop constraint %I', c.conname);
  end loop;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.invoices'::regclass and conname = 'invoices_status_check'
  ) then
    alter table public.invoices add constraint invoices_status_check check (status in (
      'pending', 'matched', 'paid', 'held', 'flagged', 'awaiting_info', 'received', 'rejected', 'processing'));
  end if;
end $$;

alter table public.invoices
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz;

-- 2. The pause lives on the organization's platform row (D7).
alter table public.orgs
  add column if not exists agent_paused_at timestamptz,
  add column if not exists agent_paused_by uuid references auth.users(id) on delete set null,
  add column if not exists agent_pause_reason text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orgs_agent_pause_reason_length') then
    alter table public.orgs add constraint orgs_agent_pause_reason_length
      check (agent_pause_reason is null or char_length(agent_pause_reason) <= 280);
  end if;
end $$;

-- 3. Claim a waiting payable for one person's decision (D4, D5). Invoker
--    rights: the tenant role runs it and RLS confines it to the token's
--    organization. The update is the compare-and-set: only one caller moves
--    the row out of a waiting status.
create or replace function public.claim_invoice_decision(
  p_org_id uuid, p_invoice_id uuid, p_by uuid, p_decision text
) returns public.invoices
language plpgsql
set search_path = ''
as $$
declare
  v public.invoices;
begin
  if p_decision is null or p_decision not in ('approve', 'reject', 'return') then
    raise exception 'invalid_decision: % is not approve, reject or return', p_decision;
  end if;

  update public.invoices
     set status = 'processing', reviewed_by = p_by, reviewed_at = now()
   where id = p_invoice_id and org_id = p_org_id and direction = 'payable'
     and (status in ('held', 'flagged', 'awaiting_info')
          or (status = 'processing' and reviewed_at < now() - interval '10 minutes'))
     and (p_decision <> 'approve' or created_by is distinct from p_by)
  returning * into v;
  if found then
    return v;
  end if;

  select * into v from public.invoices where id = p_invoice_id and org_id = p_org_id and direction = 'payable';
  if not found then
    raise exception 'invoice_not_found: no payable with that id in this organization';
  end if;
  if p_decision = 'approve' and v.created_by = p_by and v.status in ('held', 'flagged', 'awaiting_info') then
    raise exception 'self_approval: the person who created an invoice cannot approve it';
  end if;
  raise exception 'already_decided: the invoice is % now', v.status;
end;
$$;

-- 4. Is the organization's agent paused? Definer, because the tenant role has
--    no access to orgs; it reveals one boolean.
create or replace function public.agent_paused(p_org_id uuid) returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select coalesce((select agent_paused_at is not null from public.orgs where id = p_org_id), false)
$$;

-- 5. Pause and resume, told who is acting (the 0021 pattern). Anyone who can
--    approve money leaving can stop the agent; only an owner or admin starts it
--    again (spec §7 of the identity and tenancy design).
create or replace function public.pause_agent(p_org_id uuid, p_actor uuid, p_reason text) returns public.orgs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := public.member_role(p_org_id, p_actor);
  v_org  public.orgs;
begin
  if v_role is null then
    raise exception 'not_a_member: the acting person is not a member of this organization';
  end if;
  if v_role not in ('owner', 'admin', 'approver') then
    raise exception 'pause_not_permitted: a % cannot pause the agent', v_role;
  end if;
  select * into v_org from public.orgs where id = p_org_id for update;
  if v_org.agent_paused_at is not null then
    raise exception 'already_paused: the agent has been paused since %', v_org.agent_paused_at;
  end if;
  update public.orgs
     set agent_paused_at = now(), agent_paused_by = p_actor, agent_pause_reason = nullif(btrim(p_reason), '')
   where id = p_org_id
  returning * into v_org;
  return v_org;
end;
$$;

create or replace function public.resume_agent(p_org_id uuid, p_actor uuid) returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role  text := public.member_role(p_org_id, p_actor);
  v_since timestamptz;
begin
  if v_role is null then
    raise exception 'not_a_member: the acting person is not a member of this organization';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'resume_not_permitted: a % cannot resume the agent', v_role;
  end if;
  select agent_paused_at into v_since from public.orgs where id = p_org_id for update;
  if v_since is null then
    raise exception 'not_paused: the agent is running';
  end if;
  update public.orgs set agent_paused_at = null, agent_paused_by = null, agent_pause_reason = null where id = p_org_id;
  return v_since;
end;
$$;
```

  Then redefine `begin_cycle_run`:
  - copy its current body verbatim from `supabase/migrations/0022_workspace_lifecycle.sql`;
  - add as its first statement: `if public.agent_paused(p_org_id) then raise exception 'agent_paused: the agent is paused'; end if;`.

  End with the grants:

```sql
revoke execute on function public.claim_invoice_decision(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_invoice_decision(uuid, uuid, uuid, text) to vestiarion_tenant, service_role;
revoke execute on function public.agent_paused(uuid) from public, anon, authenticated;
grant execute on function public.agent_paused(uuid) to vestiarion_tenant, service_role;
revoke execute on function public.pause_agent(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.pause_agent(uuid, uuid, text) to service_role;
revoke execute on function public.resume_agent(uuid, uuid) from public, anon, authenticated;
grant execute on function public.resume_agent(uuid, uuid) to service_role;
-- begin_cycle_run keeps 0022's grants (create or replace preserves them).
```

  Before writing the constraint rebuild, read the current `invoices` status check (`0001_init.sql:60-62` and any later change). The new list must contain every value the current one allows, plus `processing`.
- [ ] **Step 4: Run it and see it pass.** Also update the foreign-key count in `tests/account-deletion.test.ts`. Then `npm run verify` must exit 0.
- [ ] **Step 5: Commit.** `feat(db): claim a payable for a person's decision, and pause the agent`

---

### Task 2: One payment step for the agent and a person

**Files:**
- Create: `src/lib/agent/pay.ts`
- Modify: `src/lib/agent/orchestrator.ts`:
  - in the AP stage, the `if (decision.action === "pay")` branch calls `payInvoice`;
  - `syncOperatingBalance` and `payoutAddress` move to `pay.ts` and are imported back.
- Test: `tests/pay.test.ts`. The existing `tests/orchestrator.test.ts` must stay green unchanged. It is the regression net.

**Interfaces (produces), from `src/lib/agent/pay.ts`:**

```ts
export interface PayInvoiceInput {
  invoiceId: string;
  counterpartyId: string;
  address: string | null;
  amount: number;
}
export interface PayInvoiceResult {
  status: "paid" | "matched" | "held";
  txRef: string | null;
  execution: PaymentExecution | null;
  /** Appended to the invoice's reasoning, exactly as the AP stage wrote it before. */
  note: string;
  /** The operating balance after a confirmed payment, else null. */
  operatingBalance: number | null;
}
export async function payInvoice(
  input: PayInvoiceInput,
  deps: { provider: ChainProvider; operating: { id: string } | null }
): Promise<PayInvoiceResult>;
export async function syncOperatingBalance(accountId: string): Promise<number>;
export function payoutAddress(address: string | null, counterpartyId: string): string;
```

**Behaviour.** This is identical to the AP stage today:
- no operating account → `held`, with the note ` [no operating account configured]`;
- otherwise `executePayment({ sourceType: "invoice", sourceId: invoiceId, fromAccountId, destination: payoutAddress(...), amount, memo: \`Invoice ${invoiceId}\` }, { provider })`;
- `confirmed` → `paid`, followed by `syncOperatingBalance`;
- `pending` → `matched`, with the note ` [transfer submitted; awaiting provider confirmation]`;
- `failed` → `held`, with the note ` [transfer failed: …]`;
- a throw → `held`, with the note ` [execution failed: …]`.

This is a pure move, with no behaviour change. The contractor stage keeps its own milestone payment.

- [ ] **Step 1: Write `tests/pay.test.ts`.** Use a fake provider object. Look at `tests/payments.test.ts` for how `executePayment` is exercised with a recorded fake. Cover:
  - each branch above, with its status and note;
  - that `executePayment` receives the same idempotent source, `invoice` plus the id.
- [ ] **Step 2: Run it and see it fail.** The module is missing.
- [ ] **Step 3: Implement it by moving code.** The AP stage keeps its variable names (`status`, `txRef`, `paymentExecution`, `reasoning`, `operatingBalance`) and assigns them from the result.
- [ ] **Step 4: Run the tests.** `npx vitest run tests/pay.test.ts tests/orchestrator.test.ts`, then `npm run verify`.
- [ ] **Step 5: Commit.** `refactor(agent): the invoice payment step is one function the agent and a person share`

---

### Task 3: Pausing stops the agent's cycle and its payments

**Files:**
- Create: `src/lib/agent/pause.ts`
- Modify:
  - `src/lib/dal/index.ts`: `TENANT_RPCS` gains `"agent_paused"` and `"claim_invoice_decision"`;
  - `src/lib/agent/orchestrator.ts`: map `agent_paused` from `begin_cycle_run`, and check the pause before each payment in the AP and contractor stages;
  - `src/lib/agent/cron.ts`: skip paused organizations;
  - `src/app/api/agent/tick/route.ts`: the shaping includes `skipped`;
  - `src/app/actions/agent.ts`: map `AgentPausedError`.
- Test: `tests/pause-cycle.test.ts`, extend `tests/cron.test.ts`, `tests/tick-route.test.ts`, `tests/agent-action.test.ts`.

**Interfaces (produces):**
- from `src/lib/agent/pause.ts`:
  - `class AgentPausedError extends Error`, whose message is `The agent is paused. Resume it to run a cycle.`;
  - `agentPaused(): Promise<boolean>`: `db().rpc("agent_paused")`, which throws on an error;
- `CronRunResult` gains `{ slug: string; ok: true; skipped: "paused" }`.

**Behaviour:**
- **Starting a cycle.** `runAgentCycle` turns an error starting with `agent_paused` from `begin_cycle_run` into `AgentPausedError`, the same way it maps `sandbox_cap_reached`.
- **Before each payment.** In the AP stage, just before `payInvoice`, and in the contractor stage, just before `executePayment`:
  - `if (await agentPaused())`, do not pay;
  - AP: `status = "held"`, and append ` [not paid: the agent was paused]` to the reasoning;
  - milestones: `status` stays `held`, with the same note.
  - The ledger entry the stage already writes records it, through that reasoning.
- **The cron.** `runLiveOrganizations` selects `id, slug, agent_paused_at`. For a paused organization it pushes `{ slug, ok: true, skipped: "paused" }` without entering its scope.
- **The tick route.** A skipped organization is shaped as `{ slug, ok: true, skipped: "paused" }`, and still counts as ok for the 200 status.
- **The console action.** `runAgentCycleAction` maps `AgentPausedError` to `{ ok: false, message: error.message }`.

- [ ] **Step 1: Write the failing tests.**
  - The cron skips a paused org and runs the others.
  - The tick shapes `skipped`.
  - The action returns the pause message when `rpc/begin_cycle_run` answers `400 { code: "P0001", message: "agent_paused: the agent is paused" }`, and no `advance_sim_day` is sent.
  - `tests/pause-cycle.test.ts`: drive the AP decision path the way `tests/orchestrator.test.ts` does. If a full cycle is too heavy there, test a small exported helper instead, e.g. `pauseNoteIfPaused()`, and say so in the report. With `rpc/agent_paused` answering `true`, no `payment_intents` claim and no transfer happens, and the invoice update carries status `held` and the pause note.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass, then `npm run verify`.**
- [ ] **Step 5: Commit.** `feat(agent): a paused workspace runs no cycle and moves no money`

---

### Task 4: The approvals library

**Files:**
- Create: `src/lib/agent/approvals.ts`
- Test: `tests/approvals.test.ts`

**Interfaces (produces), from `src/lib/agent/approvals.ts`, all called inside an organization scope:**

```ts
export type ApprovalErrorCode =
  | "invoice_not_found" | "already_decided" | "self_approval" | "high_risk"
  | "insufficient_funds" | "no_operating_account";
export class ApprovalError extends Error { readonly code: ApprovalErrorCode }
export interface WaitingPayable {
  id: string; counterpartyId: string; counterpartyName: string; riskLevel: string;
  amount: number; dueDate: string; status: "held" | "flagged" | "awaiting_info" | "processing";
  reasoning: string | null; decidedAt: string | null; createdBy: string | null; reviewedAt: string | null;
}
export async function listWaitingPayables(): Promise<WaitingPayable[]>;
export async function approveAndPay(input: { actorId: string; invoiceId: string }):
  Promise<{ status: "paid" | "matched" | "held"; txRef: string | null; note: string }>;
export async function rejectInvoice(input: { actorId: string; invoiceId: string; reason?: string }): Promise<void>;
export async function returnInvoice(input: { actorId: string; invoiceId: string }): Promise<void>;
```

**Messages.** Use the exact text from spec §6:

| Code | Message |
|---|---|
| `already_decided` | Someone else decided this invoice a moment ago. |
| `self_approval` | You created this invoice, so someone else must approve it. |
| `high_risk` | This counterparty is screened high risk. Clear it in Compliance first. |
| `insufficient_funds` | The operating account holds <n> USDC, less than this invoice. |
| `no_operating_account` | This workspace has no operating account. |
| `invoice_not_found` | That invoice is not waiting for a decision. |

**`listWaitingPayables`** reads through `db().from("invoices")`:
- selects `id, amount, due_date, status, agent_reasoning, decided_at, created_by, reviewed_at, counterparty_id, counterparties(name, risk_level)`;
- filters `direction = payable` and `status in (held, flagged, awaiting_info, processing)`;
- orders by `due_date` ascending.

**`approveAndPay`:**
1. Load the invoice with its counterparty's `risk_level` and `address`. If it is missing, or not in a waiting status, raise `invoice_not_found`.
2. Early refusals, before any claim:
   - `created_by === actorId` → `self_approval`;
   - `risk_level === "high"` → `high_risk`;
   - no `accounts` row of kind `operating` → `no_operating_account`;
   - the balance is below the amount → `insufficient_funds`. In live mode (`getChainProvider().mode === "live"`) the balance comes from `syncOperatingBalance(operating.id)`; otherwise from the stored `accounts.balance`.
3. Claim: `db().rpc("claim_invoice_decision", { p_invoice_id, p_by: actorId, p_decision: "approve" })`. Map the codes `already_decided`, `self_approval` and `invoice_not_found` to their errors.
4. `payInvoice(...)` with `getChainProvider()` and the operating account. Keep the waiting status (`previous`) for the ledger.
5. Update the invoice:
   - `status`: the result's status;
   - `agent_reasoning`: `(old reasoning ?? "") + " [approved and paid by a person]" + result.note`;
   - `decided_at`: now;
   - `settled_at`: now if `paid`, else null;
   - `tx_ref`.
6. Best-effort ledger entry, logged by id on failure:
   - action `approval_paid`, actor `human`, domain `ap`;
   - summary ``Approved and paid ${amount} USDC to ${counterpartyName}``;
   - detail `{ by: actorId, invoiceId, counterpartyId, amount, overrode: previous, txRef, status }`.
7. If anything throws after the claim and before step 5, set the invoice back to `held` with the note ` [approval interrupted: <message>]`, then rethrow. The payment's idempotency key protects a retry.

**`rejectInvoice`:**
- claim with `reject`;
- update `status = "rejected"` and `decided_at`;
- ledger entry `approval_rejected`, with detail `{ by, invoiceId, reason? }`.
- The reason is trimmed, capped at 280 characters, and omitted when empty.

**`returnInvoice`:**
- claim with `return`;
- update `status = "pending"`, `decided_at: null`, `escalated_at: null`;
- ledger entry `approval_returned`, with detail `{ by, invoiceId }`.

- [ ] **Step 1: Write the failing tests.** Use the recorded fake, as in `tests/members.test.ts` and `tests/workspace.test.ts`: a real scope and a real ledger key. Mock `payInvoice` and `getChainProvider` with `vi.mock` where needed. Cover:
  - every early refusal, and that none of them sends the claim;
  - a claim that loses the race gives `already_decided`, and no payment;
  - success: the claim, then `payInvoice` once, then the invoice update with the reasoning note, then `approval_paid` with the detail above;
  - a failed transfer gives `held`, and the ledger entry records `status: "held"`;
  - a throw inside `payInvoice` resets the invoice to `held` and rethrows;
  - reject and return: the claim decision, the status written, the ledger detail, and a reason capped at 280;
  - no ledger body ever contains an email address.
- [ ] **Step 2: Run them and see them fail. Step 3: Implement. Step 4: Run them and see them pass, then `npm run verify`.**
- [ ] **Step 5: Commit.** `feat(approvals): a person can pay, reject or return a payable the agent held`

---

### Task 5: Pause and resume, and the actions

**Files:**
- Create: `src/lib/platform/pause.ts`, `src/app/actions/approvals.ts`
- Modify:
  - `src/app/actions/agent.ts`: add `pauseAgentAction` and `resumeAgentAction`;
  - `src/lib/dal/index.ts`: `PLATFORM_RPCS` gains `"pause_agent"` and `"resume_agent"`.
- Test: `tests/pause.test.ts`, `tests/approvals-actions.test.ts`, extend `tests/agent-action.test.ts`.

**Interfaces (produces):**
- from `src/lib/platform/pause.ts`:
  - `class PauseError extends Error { readonly code: "not_a_member" | "pause_not_permitted" | "resume_not_permitted" | "already_paused" | "not_paused" }`, with these messages:
    - "You are not a member of this workspace."
    - "Your role cannot pause the agent."
    - "Only an owner or admin can resume the agent."
    - "The agent is already paused."
    - "The agent is already running."
  - `pauseAgent({ orgId, actorId, reason })`: calls the RPC, then records a best-effort `agent_paused` ledger entry inside `withOrg(orgId, …, { userId: actorId })`, with detail `{ by, reason }`. The reason is trimmed, at most 280 characters, and null when empty.
  - `resumeAgent({ orgId, actorId })`: calls the RPC, then records `agent_resumed`, with detail `{ by, pausedFor: seconds since the returned timestamp }`.
  - `pauseStateOf(orgId): Promise<{ pausedAt: string; pausedBy: string | null; reason: string | null } | null>`: `platformDb().from("orgs").select("agent_paused_at, agent_paused_by, agent_pause_reason")`.
- from `src/app/actions/approvals.ts`, all using `authorize(slug, "approval.decide")`:
  - `approveInvoiceAction`, `rejectInvoiceAction` and `returnInvoiceAction`, each `(previous: ApprovalActionResult, formData: FormData)`;
  - fields: `orgSlug`, `invoiceId` (a uuid), and `reason` (reject only);
  - result: `interface ApprovalActionResult { ok: boolean; message: string }`.
- from `src/app/actions/agent.ts`:
  - `pauseAgentAction` (`"agent.pause"`), with fields `orgSlug` and `reason`;
  - `resumeAgentAction` (`"agent.resume"`), with field `orgSlug`.

**Behaviour:**
- **The approval actions:**
  - validate the uuid;
  - map `ApprovalError` to its message, and anything else to "That did not work. Try again in a moment.", which is logged;
  - on success, call `revalidateOrgPages()`.
- **Messages on success:**
  - approve → "Paid." when `paid`; "Payment submitted; waiting for confirmation." when `matched`; "The transfer failed: <note>. The invoice is held." when `held`;
  - reject → "Rejected.";
  - return → "Returned to the agent. The next cycle decides it again.".
- **The pause and resume actions** use `auth.membership.orgId`, map `PauseError` to its message, and revalidate.

- [ ] **Steps.** Tests first, following `tests/members-actions.test.ts`: mock `@/lib/auth/authorize` and the libraries, and use the real `inOrg`. Cover:
  - refusal passthrough, uuid validation, the error mapping and the success messages;
  - the lib tests for pause/resume request bodies and ledger details, following `tests/members.test.ts`.

  Then implement, run the tests and `npm run verify`, and commit: `feat(control): approval and pause actions`.

---

### Task 6: The approvals page, the pause control and the paused banner

**Files:**
- Create: `src/app/o/[slug]/approvals/page.tsx`, `src/components/ApprovalCard.tsx`, `src/components/AgentPauseControl.tsx`
- Modify:
  - `src/components/vx/nav.ts`: an `approvals` item in Controls before Compliance, with label `Approvals` and path `/approvals`, plus its icon wherever the nav's icon map lives;
  - `src/app/o/[slug]/layout.tsx`: the paused banner, and the approvals count for the nav;
  - `src/app/o/[slug]/console/page.tsx`: the pause control next to Run cycle now; the "Needs you" tile links to `/approvals`;
  - `tests/navigation.test.ts`.

**Behaviour:**
- **The page**, in the shape the access-gates test requires:
  - `const access = await requireMembership(slug); return inOrg(access, async () => …)`, with `export const dynamic = "force-dynamic"` and the title `sectionTitle("approvals")`.
  - It loads `listWaitingPayables()`, and computes `canDecide = can(role, "approval.decide")`.
  - With nothing waiting, an EmptyState: "Nothing is waiting for a decision."
- **ApprovalCard**, a client component using `useActionForm`/`useActionState` for three forms. It shows:
  - the counterparty, the amount, the due date, a Badge for the status, the reasoning, and "stopped <decidedAt>";
  - for a `processing` row, "Being decided" and no buttons.
- **The buttons**, when `canDecide`:
  - **Approve and pay:** a ConfirmDialog, "Pay <amount> USDC to <counterparty> now?", with "(simulated)" when the workspace is a sandbox. It is disabled with a tooltip or explanatory text when:
    - the viewer created the invoice: "You created this invoice";
    - the counterparty is high risk: "Screened high risk".
  - **Reject:** a Dialog with an optional reason (at most 280 characters).
  - **Return to agent:** a ConfirmDialog.
- **Messages:** the action's message appears in a FormMessage, and the list refreshes through revalidation.
- **AgentPauseControl**, a client component:
  - **Running:** a "Pause agent" button when the viewer can pause. It opens a Dialog with a reason field (at most 280 characters) and a SubmitButton "Pause".
  - **Paused:** a "Resume agent" button, only for `agent.resume`.
  - The Run cycle now button is disabled while paused.
- **The banner,** in the layout:
  - it reads `pauseStateOf(membership.orgId)` (platform data only, as the layout's comment requires);
  - it resolves the pauser's address with `listMembers`, and falls back to "a member" when that person has left;
  - it renders a Callout above the page content on every workspace page: "The agent is paused since <time, UTC> by <address>: <reason>".
- **The nav count** is the number of waiting payables. It is loaded in the layout inside an organization scope, and is best-effort: on error, show no count.

- [ ] **Steps.**
  - Read the component system spec and `src/app/design/page.tsx` for usage.
  - Run `tests/navigation.test.ts` and any component-system rule tests: no raw controls, no colour literals, an icon for every section.
  - Implement, run `npm run verify` and `npm run build`, and commit: `feat(control): the approvals inbox, the pause control and the paused banner`.
  - `npm run build` must succeed, since this task changes pages. It reads no production data.

---

### Task 7: Documentation

**Files:** `README.md`, `ARCHITECTURE.md`

Describe only what is built:
- **The approvals inbox:**
  - the three decisions;
  - Approve and pay executes immediately through the agent's own payment step;
  - no self-approval;
  - never to a high-risk counterparty;
  - only once however many people click.
- **The pause:**
  - who can pause, who can resume;
  - it stops cycles and the agent's own payments, not a person's approval.
- **The ledger actions** added.
- **ARCHITECTURE's list of permissions not yet wired:** remove `approval.decide`, `agent.pause` and `agent.resume` from it.

No plan or task numbers, and no hackathon wording. Commit: `docs: the approvals inbox and the agent pause`.

---

## Rollout (controller)

1. **Before merging,** run `npm run db:migrate` to apply `0025`, then probe:
   - the grants;
   - `agent_paused(founding)` is false;
   - the status check includes `processing`.
2. **Merge when CI is green,** then:
   - run the cron for founding;
   - with the partner in `note-one`: a payable over a limit is held → Approve and pay → `paid` (simulated), with `approval_paid` in the ledger;
   - pause → Run cycle refused, the banner is shown → resume.
3. **Record the outcome** in the spec.
