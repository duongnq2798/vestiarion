# One capability state, and asking why in the moment

Date: 2026-10-14. Status: decided (autonomy grant 2026-10-05). Roadmap: I03 and I29. Builds on the workspace frame
(`2026-10-10-workspace-shell-design.md`, S5), shadow mode (`2026-10-07-shadow-mode-design.md`, S3-S5), Arc mainnet
behind a switch (`2026-10-06-mainnet-go-live-design.md`, M4) and the payments switch (payment safety S5, S7).

## Why

A person must never read on one page that a payment is real and on another that it is simulated, or held, for the same
workspace at the same moment. Before this change the header worked out what payments do from the platform switch, the
workspace's hold, shadow mode and the chain mode; most other surfaces used one fact each, often the workspace's mode
(sandbox or live), which is not the same thing: a sandbox connected to Circle pays for real, and a live workspace whose
payments are switched off pays nothing.

And when a person goes against the agent, the reason is the most useful thing the team can learn, but only if it is asked
right then and costs nothing to skip. Shadow mode required one for a disagreement; Approvals asked only on Reject.

## What disagreed (audit, 2026-10-14)

| Surface | Said | From | Wrong when |
| --- | --- | --- | --- |
| Agree and pay (`VerdictControl`) | "paid in USDC on Arc testnet now" | provider mode only | payments off, held, or the shadow read failed |
| Shadow mode summary (console) | "made in USDC on Arc testnet" | chain mode and held | payments off |
| Shadow mode panel (Settings) | "made in USDC on Arc testnet" | nothing | the workspace simulates |
| Go live badge (Settings) | "Live · paying on Arc testnet" | go-live step | payments off, held, in shadow mode |
| Approve and pay, held milestone ("(simulated)") | org mode | org mode | a sandbox connected to Circle |
| Pay a freelancer | "the agent pays them simulated" | org mode | a sandbox connected to Circle; payments off |
| Balance tile | "Sandbox workspace: these funds are simulated" | chain mode | a held Arc mainnet workspace |
| Payee page and payee email | "You're paid on Arc testnet", "on Arc testnet" | link chain only | the paying sandbox simulates |
| Workspace report and shared report | "Sandbox: payments here are simulated" | org mode | a sandbox connected to Circle; Arc mainnet not live |
| Receipt | "Through CCTP from Arc testnet", "Burn on Arc testnet" | hard-coded | any other network |
| Status API `provenance.payments` | `live` / `simulate` | hold and chain mode | payments switched off or unread |
| Header reserve row | Live / Simulated | hold only | payments switched off |
| `/open` method note | "Sandbox workspaces simulate their payments" | | a sandbox connected to Circle |

Left as they are, on purpose: the workspace's standing badge (Live, Sandbox, Not live yet) in the sidebar and switcher,
which names the workspace's mode, not what payments do; the pay link page, which shows where to send money *to* the
business, true in every situation; and per-payment labels (Paid on Arc, simulated), which read each payment's own
record.

## Requirements

### One capability state (I03)

- **R1. One source.** `src/lib/capability.ts` turns the facts into one of five situations: `live-mainnet`,
  `live-testnet`, `simulated`, `shadow` (with what an agreement pays: on chain or simulated) and `unavailable` (with a
  cause: switched off, the switch not read, shadow mode not read, held, and the sentence why). It also holds every word
  and tone a surface uses for them. Pure, so client components and tests read the same module.
- **R2. The same facts.** `src/lib/capability-read.ts` reads them inside the workspace's scope: the platform switch as
  every page reads it, the hold as `shellModes()` says it, the chain mode, shadow mode. The order is the payment gates'
  own: the switch, then the hold, then shadow mode, then the chain. A fact that cannot be read is never said as its
  healthy value.
- **R3. The hold in words.** `paymentsHoldReason()` names why nothing can be paid (the network's hold, an Arc mainnet
  workspace with no Circle account, a wallet that cannot be reached); `shellModes()` hands it to the header.
- **R4. The header reads it.** The chips and the Payments row take the capability's words and tones. Live on Arc mainnet
  is drawn in the brand colour on every surface. The reserve row says Held while payments are switched off. The status
  API's `provenance.payments` is `unavailable` while payments are switched off or the switch cannot be read, as the
  header says.
- **R5. Every other surface reads it.** Agree and pay, the shadow mode summary and panel, Approve and pay's and a held
  milestone's "(simulated)", Pay a freelancer, the workspace and shared report, the payee's page and email. While nothing
  can be paid, Agree and pay is not offered: Agree records the verdict and says why. The reports, the payee's page and
  email need only whether the workspace makes simulated payments (`simulatesPayments(mode)`): the chain mode, or, while
  the workspace is held and the chain mode cannot be told, the workspace's mode, as the report always read it; never on
  Arc mainnet. So a sandbox whose credentials cannot be read still counts its simulated payments.
- **R6. The balance tile** says a held workspace's figure is not read from the chain where the chain cannot be read, and
  never calls it a sandbox; a held workspace whose wallet can still be read (Arc mainnet connected, not live yet) keeps
  reading it.
- **R7. Go live's badge** keeps its step's words while they agree with the capability, and otherwise says the standing
  and the situation: "Live · payments off", "Live · shadow mode, paying after a verdict".
- **R8. The receipt** names the network a payout left from, never a fixed one.

### Asking why, in the moment (I29)

- **R9. Shadow mode.** Disagree asks "Why do you disagree?" in the same dialog, optional. A disagreement with no reason
  is recorded; the reason, when given, stays in `decision_verdicts` and the signed `decision_verdict` entry.
- **R10. Approvals.** Reject asks "Why reject it?" (it already took an optional reason); Return to agent's confirmation
  asks "Why return it?"; Approve and pay's confirmation asks "Why pay it anyway?" on a payable the agent flagged or held
  on one of its rules (not one held for cash or for a verdict). All optional, one line, at most 280 characters, never
  blocking. A return's reason is kept in its `approval_returned` entry, as a rejection's is.
- **R11. Kept with where it came from.** Each reason given is a row in `decision_reasons` (migration `0120`): the
  feature and decision (`shadow_mode.disagree`, `approvals.reject`, `approvals.return`, `approvals.pay_held`), the
  surface (console, Slack, Telegram, API, GitHub, from the command's actor), the subject, who gave it, when, and the
  app's version (`appVersion()`: the deployment's git commit from `VERCEL_GIT_COMMIT_SHA`, cut to 12 characters, or the
  package version). Written by the command layer for the console only, the one surface that says where the reason is
  typed that Vestiarion's team reads it ("Optional. One line helps Vestiarion's team improve the agent."). Slack sends
  no reason today and the other surfaces decide no payable; a reason one sends still goes into the decision's ledger
  entry, and nowhere else. A decision settling a verdict keeps none twice.
- **R12. Never in the way.** Keeping a reason is best effort: before migration `0120` runs, or when the write fails,
  nothing is saved and the decision goes on exactly as before.
- **R13. Owners see them.** Insights shows owners and admins the workspace's latest 20, "Why people went against the
  agent": what was done and where, the reason, when, and the build.
- **R14. The team sees them.** The founder dashboard (`/admin/growth`) lists the latest 200 across workspaces in its
  window, by workspace slug and side, through `growth_decision_reasons(p_since)`: a definer, for the service role only,
  naming no person.
- **R15. Privacy.** The privacy page says what is kept, who sees it (the workspace's owners and admins on Insights,
  without a name; Vestiarion's team across workspaces, by slug, never a name or email), how long (until the workspace is
  deleted), and what deleting an account does: reasons in a workspace deleted with the account go with it; in a
  workspace that stays, `given_by` is set null by the foreign key when the auth user is deleted, so the reason stays
  without the account's id, and the decision's ledger entry keeps the id as every entry does.

## Migration 0120

Additive and idempotent. `decision_reasons`: tenant table, row-level security with the restrictive guard, the tenant
role may select and insert only; foreign keys to `orgs` (cascade) and `auth.users` (set null). Check constraints on
every enumerated column, the reason 1 to 280 characters, the version 1 to 64. `growth_decision_reasons`: security
definer, empty search path, execute revoked from public, anon and authenticated, granted to the service role. `notify
pgrst`. Down: drop the function, then the table.

## Tests

- `tests/capability-surfaces.test.tsx`: table-driven over the five situations and the causes of the fifth: each
  surface's words and tone, then that no surface can be told apart wrongly (no network named for a simulated payment,
  nothing called simulated on chain, no paying words while unavailable).
- `tests/decision-reasons-migration.test.ts` (PGlite): the table's constraints, isolation, append-only, cascade, and the
  team function's grants and output.
- `tests/decision-reasons.test.ts`: the reason's cleaning, the version, best effort before the migration, and the
  command layer keeping a console reason, and none from another surface.
- `tests/approval-card-reasons.test.tsx` (happy-dom): the card rendered, each dialog opened, a reason typed and the
  confirmation pressed; the action receives the reason in the form's data, and nothing waits on an empty field.
- `tests/legal-pages.test.tsx`: the privacy entry, checked against migration 0120 and the command layer.
