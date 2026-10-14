# Contractor work accepted from Asana

Roadmap F23. Design, marketing and ops teams deliver work in Asana, not GitHub, and still need to pay contractors for
it. Until now a milestone was verified by a merged pull request or by a person by hand. This adds a third way: a
milestone linked to the Asana task its work is delivered in, accepted by a person against its criteria once the task is
completed.

## Rules

- **A1 Provider.** Asana is a provider of a third kind, `work`, on the connector core (`ConnectingProvider`): connect,
  token lease and refresh, consent version, disconnect, the 15-minute sweeper. No bills, no deals. On only with
  `ASANA_CLIENT_ID` and `ASANA_CLIENT_SECRET`. Its mark is not shown until Asana's own file is in `public/brands`.
- **A2 Connecting.** An owner or admin (`integrations.manage`) connects with OAuth, asking exactly the nine registered
  scopes, at `https://www.vestiarion.xyz/api/integrations/asana/callback`. A grant is one Asana user's; the connection
  reads what that person can see. Consent `asana-2026-10-14`.
- **A3 Schema (0115).** Provider checks take `asana`; `milestones.verification_method` takes `asana`, each replaced only
  while it does not take it yet (Pipedrive's 0116 lists `asana` too). `milestones.acceptance_criteria`;
  `asana_task_links` (tenant: one live link per milestone and per task); `asana_webhooks` (platform, sealed secrets);
  `accept_asana_task` and `hold_asana_acceptance`. Additive, idempotent; before it runs the code reads "not set up".
- **A4 Linking.** `records.write`. Paste a task link (read for its ids, never opened) or pick workspace, project and task.
  Only a pending milestone, not one verified by a pull request, not a task linked to another milestone.
- **A5 Criteria.** The milestone keeps the acceptance criteria it is held to, written by a person from the agreement.
  Asana never writes them. Without them a completed task is held. Accepted criteria do not change.
- **A6 Reading.** Task (completed, when, by whom, assignee), attachments, comments; deliverables are attachments (by id
  and upload time) and https links in the description and comments; their SHA-256 is the fingerprint. Words of the
  description and comments are not kept.
- **A7 States.** `waiting`, `ready` (completed, criteria written), `accepted`, `held` (reopened, deliverable changed,
  unreachable, no criteria, unlinked). A completed task is never accepted by a read.
- **A8 Accepting.** A person ticks that they checked each criterion against the deliverables shown and accepts. The task
  is read again first; the fingerprint and the criteria's hash must be the ones shown. `accept_asana_task` verifies the
  pending milestone (method `asana`); the agent then decides it under every guardrail, as any verified milestone.
- **A9 Self-acceptance.** The payee never accepts their own work or approves its payout: refused when the member's email
  is the payee's notice email, or (where Asana has them) the member's Asana user is the Asana user with the payee's
  email. Pay now on an Asana-linked milestone refuses the payee.
- **A10 Invalidation.** Reopened (or reopened and completed again), a deliverable changed, or the task gone, after
  acceptance and before payment: `hold_asana_acceptance` takes the verification back and holds the link for review.
  After a payment was sent, only the link is held, as a dispute. A held link stays held until a person accepts again.
- **A11 Re-reads.** Signed webhook deliveries (X-Hook-Secret handshake once, X-Hook-Signature HMAC-SHA256 compared in
  constant time) only nudge a read. Reads also run in the cycle before the contractor stage, every 15 minutes, on
  Check Asana now and before an acceptance, with the connection's token.
- **A12 Nothing from Asana moves money.** No amount, payee, address or payment intent is written from Asana. The paying
  and deciding path changes only through the milestone's verification state.
- **A13 Evidence links.** `app.asana.com` task and attachment links are checked at Asana's API, built from the id, with
  the workspace's own Asana token; never by fetching the link.
- **A14 Figures.** Acceptances (each a person's check of the evidence), disputes (acceptances taken back) and the median
  time from an acceptance to the agent's decision, over 30 days, on the Asana card.
- **A15 Words.** The consent, privacy and terms say what is read, kept and written, in plain English.
- **A16 Where it shows.** Settings: the Asana card. Contractors: a card under each milestone waiting for verification, or linked; ready and held count
  under Needs you. The evidence page: Asana's completion beside the person's acceptance.

## Not verified here

The live OAuth run, the webhook handshake against Asana, and the test tasks (`1219477646404728`, `1219477646404730`)
are run after the merge, on production, once migration 0115 is applied.

## Screens

At 1440 and 390 px, from `/docs-shots/asana/<state>` (sample data, `DOCS_SCREENSHOTS=1` only), in `asana-shots/`:

1. `01-settings`: the Asana card in Settings, connected, with its linked tasks and figures.
2. `02-link`: a milestone's card before a task is linked: paste the task link, or choose it in Asana; and the criteria.
3. `03-ready`: ready for acceptance: the deliverables, the criteria and Accept the work.
4. `04-accepted`: accepted: who accepted, when, and the deliverables accepted.
5. `05-held`: held for review after the task was reopened.
