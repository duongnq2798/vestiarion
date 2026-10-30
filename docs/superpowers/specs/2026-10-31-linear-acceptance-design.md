# Contractor work accepted from Linear

Date: 2026-10-31. Status: built on branch `feat/linear-acceptance` (server, console and docs), not merged yet. Needs
migration 0147. Not verified against a live Linear workspace: that is the partner's step 4 below.

## Why

Engineering contractors deliver in Linear as often as in GitHub. A milestone today is verified three ways:
- by a merged pull request;
- by a person by hand;
- by a person's acceptance of a completed Asana task (`docs/superpowers/specs/2026-10-14-asana-acceptance-design.md`,
  A1-A16).

This adds Linear: a milestone linked to the Linear issue its work is delivered in, accepted by a person against its
criteria once the issue is Done.

Linear works the way Asana does, on purpose. The rule a payment rests on stays the same:
- a completed issue is never accepted by a read;
- a person checks the deliverables against the criteria and accepts;
- a reopened issue, or a changed deliverable, takes the verification back before payment.

Anyone in the Linear workspace can mark an issue Done, the contractor included. "Done" alone must never pay.

Code comments and test names cite the ids, for example "(Linear acceptance LN7)".

## Linear facts this rests on (developer docs, read 2026-10-31)

- **OAuth.**
  - Authorize at `https://linear.app/oauth/authorize` with `client_id`, `redirect_uri`, `response_type=code`, `scope`
    (comma-separated), `state`, optional `prompt=consent`, `actor=user` (the default).
  - Token exchange and refresh: `POST https://api.linear.app/oauth/token`, form-encoded.
  - Access tokens last 24 hours, with a refresh token. Every app has used refresh tokens since 2026-04-01.
  - A refresh has a 30-minute grace period.
  - Revoke: `POST https://api.linear.app/oauth/revoke` with `token`.
  - Scope `read` is always present.
- **API.** GraphQL at `https://api.linear.app/graphql`, `Authorization: Bearer <token>`. `issue(id:)` takes the
  identifier (`ENG-123`) or the UUID.
- **Webhooks.**
  - An OAuth app can configure webhooks in its own settings. Linear then creates one for every organization that
    authorizes the app, and sends an `OAuthApp` revoked event when it is de-authorized.
  - Creating webhooks through the API needs the `admin` scope; the app's own webhooks do not.
  - Deliveries are signed with `Linear-Signature`: hex HMAC-SHA256 of the raw body with the webhook's signing secret.
  - The body carries `webhookTimestamp` (Unix ms), to be checked within 60 seconds.
  - Other headers: `Linear-Delivery` (UUID), `Linear-Event` (entity type), `Linear-Timestamp`.
  - The body has `action`, `type`, `data`, `updatedFrom`, `url`, `actor`, `createdAt`, `organizationId` and
    `webhookId`.
  - A delivery must answer 200 within 5 s, or it is retried after 1 minute, 1 hour and 6 hours. Linear may disable a
    webhook that keeps failing.

## The rules

- **LN1. Provider.**
  - Linear is a provider of kind `work` on the connector core, as Asana is (A1): connect, token lease and refresh,
    consent version, disconnect, the 15-minute sweeper. No bills, no deals.
  - On only with `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET`. Without the webhook secret
    there is no Linear card and no connect.
- **LN2. Connecting.**
  - An owner or admin (`integrations.manage`) connects with OAuth, scope `read` only, `actor=user`.
  - The callback is `https://www.vestiarion.xyz/api/integrations/linear/callback`.
  - A grant is one Linear user's; the connection reads what that person can see.
  - The connection keeps Linear's organization id and name, read with `viewer { organization { id name } }`, so a
    webhook delivery finds its workspace.
  - One live Linear connection per Vestiarion workspace. The same Linear organization may be connected to several
    Vestiarion workspaces: a delivery nudges each.
  - Consent `linear-2026-10-31`.
  - Disconnect revokes the token at Linear, as the core's disconnect does for the others.
- **LN3. Schema (0147).** Additive and idempotent, re-runnable by `scripts/migrate.ts`. It adds:
  - `linear` to the provider checks of `accounting_connections` and `accounting_tokens`, keeping every value the latest
    migration lists (0145 added `googlesheets`). Each check is replaced only while it does not take `linear` yet.
  - `linear` to `milestones.verification_method`, the same way, keeping every value it takes now.
  - `linear_issue_links`, tenant data, as `asana_task_links`:
    - one live link per milestone and one per issue;
    - the issue's UUID, identifier and team;
    - its state;
    - the deliverables' fingerprint and the criteria hash at acceptance;
    - who accepted and when;
    - hold reason and time.
  - `accept_linear_issue` and `hold_linear_acceptance`, as their Asana pairs.
  - `linear_connector_ready(p_org_id)`, true once 0147 has run.
  - No webhook table: the app's webhook is one URL and one secret, in env (LN11).

  Before 0147 runs, the code reads "not set up", as Asana's does before 0115.
- **LN4. Linking.** `records.write`. A person pastes:
  - an issue link (`https://linear.app/<workspace>/issue/ENG-123/...`), read only for its identifier, never opened;
  - or the identifier `ENG-123`.

  The issue is read once through the connection to confirm it exists. Only a pending milestone can be linked: not one
  verified by a pull request or by Asana, and not to an issue linked to another milestone.
- **LN5. Criteria.** As A5. The milestone keeps the acceptance criteria a person wrote from the agreement. Linear never
  writes them. Without them, a Done issue is held. The criteria do not change once accepted. Asana's
  `milestones.acceptance_criteria` column is the one used.
- **LN6. Reading.**
  - From the issue: its state (`state.type`: `completed`, `canceled`, or anything else), `completedAt`, who completed
    it where Linear says, the assignee, and `archivedAt` / `trashed`.
  - Deliverables are:
    - the issue's attachments (Linear attachments are links: id, url, title, `updatedAt`);
    - https links in the description and comments, uploaded files (`uploads.linear.app`) included.
  - Their SHA-256 over a stable listing is the fingerprint. The words of the description and comments are not kept.
  - At most 50 attachments and 100 comments are read, with the counts recorded: fewer than Asana's 100 attachments and
    300 comments.
  - At most 50 deliverables are kept and compared, as Asana's, and fewer when their links are long: the list stays within
    0147's check of 32,000 bytes (`octet_length(deliverables::text)`). The rest count in the fingerprint by number.
- **LN7. States.**
  - `waiting`: not completed.
  - `ready`: completed, criteria written.
  - `accepted`.
  - `held`: reopened, canceled, a deliverable changed, archived or deleted, unreachable, no criteria, or unlinked.

  A Done issue is never accepted by a read.
- **LN8. Accepting.**
  - A person ticks that they checked each criterion against the deliverables shown, and accepts.
  - The issue is read again first; the fingerprint and the criteria hash must be the ones shown.
  - `accept_linear_issue` verifies the pending milestone (method `linear`). The agent then decides it under every
    guardrail, as any verified milestone.
- **LN9. Self-acceptance.** As A9. The payee never accepts their own work or approves its payout. It is refused when:
  - the member's email is the payee's notice email;
  - or the Linear user with the payee's notice email, anywhere in the Linear workspace whoever is on the issue, is the
    accepting member's own Linear user: the connection's viewer when that member connected Linear, else the Linear user
    with the member's email.

  Both are looked up by email in one query at acceptance (`users(filter: { email: { eqIgnoreCase } })`); no email is
  kept. So a member's Linear account is known only when they connected Linear or their Vestiarion email is their Linear
  email, as with Asana. Pay now on a Linear-linked milestone refuses the payee, by email.
- **LN10. Invalidation.** As A10. A hold happens when, after acceptance:
  - the issue is reopened (or reopened and completed again);
  - it is canceled;
  - a deliverable changed;
  - or the issue is archived or deleted.

  Before payment, `hold_linear_acceptance` takes the verification back and holds the link for review. After a payment
  was sent, only the link is held, as a dispute. A held link stays held until a person accepts again. A person takes an
  acceptance back by unlinking the issue; Revoke manually is refused on a milestone accepted from Linear, which would
  leave its card saying it was accepted.
- **LN11. Webhooks only nudge a read.**
  - Each delivery:
    - is checked first: `Linear-Signature` against `LINEAR_WEBHOOK_SECRET` in constant time over the raw body, then
      `webhookTimestamp` within 60 s of receipt;
    - is answered 200 at once;
    - then reads again every live link of the matching organization's connections that the event touches (`Issue`
      by the issue id; `Comment` and `Attachment` by `data.issueId`).
  - A bad signature or a stale time answers 401 and reads nothing.
  - An `OAuthApp` revoked event marks the organization's connections as needing to reconnect.
  - Nothing in a delivery is trusted beyond which issue to read: no state, deliverable or person comes from the
    payload.
- **LN12. Other reads.** As A11, with the connection's token:
  - in the cycle before the contractor stage, and again for the accepted issues of the releases the stage is about to
    send;
  - every 15 minutes;
  - on **Check Linear now**;
  - before an acceptance.

  Asana's budgets apply: at most 20 accepted issues in 30 s, a 10 s stop and a 20 s wait before sending.
- **LN13. Nothing from Linear moves money.** As A12. Linear writes no amount, payee, address or payment intent.
- **LN14. Evidence links.** `linear.app` issue links are checked at Linear's API, built from the identifier, with the
  workspace's own token; never by fetching the link. Linear finds an identifier in the connection's own Linear
  workspace, so the issue's own `url` is asked for too: a link is checked only when that names the link's workspace,
  and a link to another Linear workspace is shown as not checked.
- **LN15. Figures.** On the Linear card, over 30 days:
  - acceptances;
  - disputes;
  - the median time from an acceptance to the agent's decision.
- **LN16. Words and places.**
  - Settings has the Linear card. Contractors has a card under each milestone waiting for verification or linked; ready
    and held count under Needs you. The evidence page shows Linear's completion beside the person's acceptance.
  - The consent, privacy and terms say what is read, kept and written, in plain English, as they do for Asana.
  - A guide, `content/docs/guides/linear.mdx`, mirrors the Asana guide.
  - The docs' integrations list, README, ARCHITECTURE, `changelog.mdx` (if any API or webhook output changes) and
    CHANGELOG are updated.
  - Linear's logo is not shipped with this change. The card uses the product's own icon for work tools until the
    partner adds the brand asset.

## What the partner does after the merge

1. Run migration 0147.
2. In Linear, create an OAuth application:
   - callback `https://www.vestiarion.xyz/api/integrations/linear/callback`;
   - webhooks on, URL `https://www.vestiarion.xyz/api/integrations/linear/webhook`;
   - resource types: Issues, Issue attachments, Issue comments, OAuthApp revoked.
3. Set `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET` in Vercel production.
4. Connect a test Linear workspace in a test Vestiarion workspace. Link a milestone to an issue, move it to Done,
   accept, and watch it verify. Reopen another to see the hold.

## Screens

From `/docs-shots/linear/<state>` (sample data, `DOCS_SCREENSHOTS=1` only), as Asana's:

1. `settings`: the Linear card in Settings, connected to a Linear workspace, with its linked issues and figures.
2. `link`: a milestone's card before an issue is linked: paste the issue's link or its ID; and the criteria.
3. `ready`: ready for acceptance: the deliverables, the criteria and Accept the work.
4. `accepted`: accepted: who accepted, when, and the deliverables accepted.
5. `held`: held for review after the issue was reopened.

On Contractors, `workToolCards` (`src/lib/work-tool-cards.ts`) picks which work tool's card a milestone shows: a linked
card always; on an open milestone linked in one tool, none for the other (Asana's link does not refuse a Linear-linked
milestone, so its card is not offered there); and on an open milestone linked in neither, a tool's card where that tool
is connected or the other one is not. Where both cards offer to link a milestone and Asana is connected, Asana's card
alone asks for the criteria, which are the milestone's (`linearCriteria`).

## What it does not do

- No issue is created, commented on or changed in Linear: scope `read` only.
- No per-team webhook is created through the API (that would need `admin`).
- No Linear logo yet (LN16).
