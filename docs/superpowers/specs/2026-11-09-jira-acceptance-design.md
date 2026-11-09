# Contractor work accepted from Jira

Date: 2026-11-09. Status: designed, not built. Branch `feat/jira-acceptance`. It needs migration 0149, which the owner runs. Nothing has been checked against a live Jira site yet. The live checks are listed under "Proven today, and proven only live" and wait for the owner's Atlassian app (Owner steps).

## Why

A milestone can be verified four ways today:
- by a merged pull request;
- by hand;
- by a person accepting a completed Asana task (`2026-10-14-asana-acceptance-design.md`, A1-A16);
- by a person accepting a done Linear issue (`2026-10-31-linear-acceptance-design.md`, LN1-LN16).

Many small businesses track contractor work in Jira Cloud. This adds Jira. A milestone is linked to the Jira issue its work is delivered in, and once the issue is Done, a person accepts the work against the milestone's criteria.

Jira works the way Linear does on purpose. It uses the same files, the same state machine, the same two SQL writers and the same budgets, and changes only what Jira forces. The rule a payment rests on does not change:
- a done issue is never accepted by a read;
- a person checks the deliverables against the criteria and accepts;
- a reopened or canceled issue, or a changed deliverable, takes the verification back before payment.

Anyone on the Jira site can move an issue to Done, the contractor included, so "Done" alone must never pay.

Code comments and test names cite the rule ids, for example "(Jira acceptance JR9)". Where a Linear helper names no tool, Jira imports it rather than copying it:
- `planRead`, `acceptable`, `DELIVERABLES_BYTES`, `storedBytes`, `writeCriteria`, `milestonesForAcceptance` and `criteriaHash` from `src/lib/linear/`;
- `fingerprintOf`, `linksIn`, `linkLabel`, `deliverablesFrom` and `MAX_DELIVERABLES` from `src/lib/asana/deliverables.ts`;
- `CRITERIA_MIN` and `CRITERIA_MAX` from `src/lib/commands/asana.ts`;
- `cycleEventOf` from `src/lib/commands/actor.ts`.

## Jira facts this rests on (Atlassian developer docs, read 2026-11-09)

- **OAuth 2.0 (3LO)** (developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/; /cloud/oauth/getting-started/implementing-oauth-3lo/; /cloud/oauth/getting-started/refresh-tokens/):
  - Authorize at `https://auth.atlassian.com/authorize` with `audience=api.atlassian.com`, `client_id`, a space-separated `scope`, `redirect_uri`, `state`, `response_type=code` and `prompt=consent`. Asking for `offline_access` adds a refresh token.
  - Tokens come from `POST https://auth.atlassian.com/oauth/token`, with a JSON body.
  - Refresh tokens rotate, and the one used is disabled. A dead one answers `403 {"error":"invalid_grant"}`.
  - The access token's lifetime is given only as `expires_in`.
  - Assumed, and not on the refresh-tokens page: a 90-day inactivity expiry and a 10-minute reuse leeway.
- **Sites.** `GET https://api.atlassian.com/oauth/token/accessible-resources` answers `[{id, name, url, scopes, avatarUrl}]`, where `id` is the cloudId.
  - Ids are not unique across Atlassian products, so only the entries with Jira scopes count.
  - A grant may reach several sites, unless the app opted into resource-restricted tokens when it was created (OAuth changelog, June 2026).
- **API.** Requests go to `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`. A trailing slash before `?` answers `401 scope does not match`.
- **No revoke endpoint for apps** (developer forum, not official). People remove an app under Connected apps in their Atlassian account. An admin can block user apps (community article).
- **Dynamic webhooks** (/cloud/jira/platform/webhooks/ and the REST spec's webhooks group):
  - `POST`, `GET` and `DELETE /rest/api/3/webhook`. Refresh is `PUT /rest/api/3/webhook/refresh` in the spec but `PUT /rest/api/3/webhook` in the guide.
  - At most 5 per app, per user, per site. They expire 30 days after creation or refresh.
  - The JQL filter takes a subset of JQL: `project`, `issueKey` and others, with `=`, `!=`, `IN` and `NOT IN`. It has no `statusCategory`.
  - Jira retries on 408, 409, 425, 429 and 5xx, up to 5 times, 5 to 15 minutes apart. Only a 200 counts as success.
  - Primary deliveries arrive within 30 s; secondary ones within 15 minutes.
  - `matchedWebhookIds` may hold several ids.
  - A delivery carries a bearer token signed with the app's client secret. Its algorithm and claims are not documented.
  - The spec's POST description (and only that) says that for a non-public app, Jira delivers only to webhooks the app owner registered.
  - A 3LO app has no API for failed deliveries.
- **Issues:**
  - `fields.status.statusCategory.key` is one of `new`, `indeterminate`, `done` or `undefined`. Match on the key, never the name.
  - "Won't Do", "Duplicate" and the like usually sit in the Done category, and only `fields.resolution` tells them apart.
  - `resolutiondate` is null when a workflow sets no resolution. Whether `statuscategorychangedate` is always present has not been checked.
  - A 404 means "not found" and "no permission" alike. What Jira answers for an archived issue is not documented.
  - An issue keeps its numeric id when it moves; its key changes.
- **Rate limits** (/cloud/jira/platform/rate-limiting/):
  - The Tier 1 pool is 65,000 points an hour, shared by every tenant of the app.
  - Each request costs 1 point, plus 1 per core object returned, plus 2 per user object.
  - A 429 carries `Retry-After` and `RateLimit-Reason` (`jira-quota-global-based`, `jira-quota-tenant-based`, `jira-burst-based` or `jira-per-issue-on-write`).
- **Personal data.** Storing Atlassian accountIds brings a weekly `report-accounts` duty (user-privacy developer guide).

## The rules

- **JR1. Provider and its switch.**
  - Jira is a provider of kind `work` on the connector core, as Linear is (LN1). That covers connect, the token lease and refresh, the consent version, disconnect and the 15-minute sweeper. Jira brings no bills and no deals, and nothing is ever booked to it.
  - It is on only when both `JIRA_CLIENT_ID` (`/^[A-Za-z0-9_-]{6,64}$/`) and `JIRA_CLIENT_SECRET` are set. There is no third variable, because deliveries are signed with the client secret (JR15).
  - When only one is set, it logs once, for example "Jira is off: JIRA_CLIENT_SECRET is not set". The log names the variable, never a value.
  - When Jira is off, the feature says so:
    - the four API routes answer `404 {error:"not_found"}`;
    - for a signed-in person, `/integrations/jira` and `/integrations/jira/connect` show an EmptyState that says "Jira is not set up on this deployment yet.";
    - commands answer the same sentence;
    - Settings and Contractors show no Jira card, as Linear's convention is (`linearPanelFor` answers null);
    - the accountant read skips `jira_issue_links`;
    - the sweeper's `providerFor("jira")` is null.
  - The variables are set for Production only. Preview and local deployments stay off, because the app has one callback URL.

- **JR2. Connecting.**
  - An owner or admin (`integrations.manage`) connects from `/integrations/jira/connect` with consent `jira-2026-11-09`. If the merge day is later, the consent version takes that date.
  - The authorize URL carries exactly `audience=api.atlassian.com`, `client_id`, `scope` (the four `JIRA_SCOPES`, space-joined, JR3), `redirect_uri`, `state`, `response_type=code` and `prompt=consent`.
  - The callback is `https://www.vestiarion.xyz/api/integrations/jira/callback`.
  - The code is exchanged at the token endpoint with a JSON body. An answer without `refresh_token` fails the connect.
  - The grant is one Atlassian user's. The connection reads what that person can see.
  - Sites (`organisations` = `grantSites`) come from `accessible-resources`. A site is kept when its `id` is a UUID, its `url` is https and its `scopes` include `read:jira-work`. Sites are de-duplicated by id, and names are cut to 200 characters.
    - **One site:** it is connected. `externalOrgId` is the cloudId and `externalOrgName` is the site's name.
    - **Several sites:** the core keeps a pending grant for ten minutes. The connect page offers the sites, and `POST /api/integrations/jira/choose` calls the generic `chooseConnect`. This is the flow Xero and Zoho Books use; Linear never built it.
    - **None:** `organisations` throws `ConnectRefusal("no_site")`. The person lands on `/o/<slug>/settings?jira=no_site#jira`, and nothing is kept.
  - A workspace has one live Jira connection (the core's `accounting_connections_one_active`).
  - Several workspaces may connect the same site (`exclusive` is unset, as for Linear). Each has its own webhook.
  - Reconnecting the same site keeps the connection row, its links and its site row. Connecting another site while one is live answers `other_organisation`.
  - After the answer is sent, `firstSync` runs `ensureJiraSite`, using `afterConnect: (work) => after(work)`, Pipedrive's pattern (`src/lib/pipedrive/connect-deps.ts`). It saves the site row, cleans up orphan webhooks, and makes the webhook only when links exist.

- **JR3. Tokens and staying connected.**
  - **Scopes.** `JIRA_SCOPES = ["read:jira-work", "read:jira-user", "manage:jira-webhook", "offline_access"]`, classic scopes only.
    - `read:jira-user` is needed for `/myself` and user search (JR12).
    - A table in `jira/settings.ts` records each consent version's scopes, and a test checks that `JIRA_SCOPES` equals the scopes recorded for `CONSENT_VERSIONS.jira`. A change of scope without a new consent version fails CI.
  - **Refresh.** `POST /oauth/token` with `{grant_type:"refresh_token", client_id, client_secret, refresh_token}`.
    - It is single-flight under the core's token-row lease (`freshAccessToken`), and the rotated token is stored atomically (`accounting_token_store`).
    - `expires_in` is read, and 3600 is used when it is missing.
  - **What each refresh answer means:**
    - 200 gives new tokens. If the answer has no `refresh_token`, the one sent is kept and the fact is logged.
    - 400, 401 or 403 with `error: "invalid_grant"` means `reconnect`. This is the one signal Atlassian gives that a grant was revoked.
    - `invalid_client` or `unauthorized_client` means `unavailable`, and the process logs once: "jira: Atlassian refused this deployment's client credentials (<code>): check JIRA_CLIENT_ID and JIRA_CLIENT_SECRET". A wrong or rotated secret therefore never sends every customer to reconnect.
    - Any other 4xx means `unavailable`, and its status and error code (cut to 40 characters) are logged.
    - 429, 5xx or no answer means `unavailable`, with `Retry-After`.
    - No token and no body is ever logged.
  - **Staying alive.** The daily webhook upkeep (JR14) calls `accessible-resources` for every connection, with or without links. That call refreshes an expired access token, and the refresh rotates the refresh token, so a connection stays far inside the 90 days. The 10-minute reuse leeway is never relied on: refresh runs under the lease.
  - **A site that disappears.** A 200 answer from `accessible-resources` that lacks the connection's cloudId sets `jira_sites.site_missing_at`. A second such answer at least 10 minutes later marks `needs_reconnect`, with JiraSiteGoneError's words. An answer that has the cloudId clears the mark, and a renamed site updates `site_url`.
  - **Reconnect words.** `PROVIDER_WORDS.jira.idleDays = 90` and `revokedIn = "the Atlassian account"`. The work-kind branch of `status.ts` builds: "Jira no longer accepts this connection: the app's access was removed in the Atlassian account, or it went unused for 90 days. Reconnect Jira to go on reading the issues linked to milestones." Asana and Linear have `idleDays` 0 and no `revokedIn`, so their words stay as they are.

- **JR4. Disconnecting.**
  - It needs `integrations.manage`, and follows Asana's order (`src/app/actions/asana.ts`):
    1. `stopJiraWebhooks` calls `DELETE /rest/api/3/webhook` `{webhookIds}`, current and retired, with the token while it still works. Then the `jira_sites` row is deleted.
    2. The core's `disconnectConnection` runs with `revoke: async () => false`, which makes no request. Its ledger entry is `accounting_disconnected {revokedAtProvider: false}`.
  - When the token is already dead, the row is deleted anyway. Jira ends the webhook within 30 days, and deliveries for it find no row and are ignored.
  - A pending grant that lapses (the person never chose a site) is deleted by the sweeper. Its revoke makes no request.

- **JR5. Schema (0149).** It is additive, idempotent and re-run by `scripts/migrate.ts`, and it is merged after any open change that redefines the three checks it widens. It contains:
  - `jira` in both provider checks and in `milestones.verification_method`;
  - `jira_issue_links`, a tenant table;
  - `jira_sites`, a platform table;
  - `accept_jira_issue`, `hold_jira_acceptance` and `jira_connector_ready`.

  Before 0149 runs, the code reads PGRST205, PGRST202, PGRST204, 42P01, 42703 and 42883 as "not set up". The full definition is under "Data".

- **JR6. Linking.**
  - It needs `records.write`, through `milestone.link_issue`. The five `milestone.*_issue` commands now cover both Linear and Jira; `policy.ts` and ARCHITECTURE say so.
  - The person pastes one of:
    - `https://<host>/browse/KEY-1`, optionally followed by more path or a query;
    - any https Jira URL whose query has `selectedIssue=KEY-1`;
    - a path ending in `/issues/KEY-1`;
    - a bare key, upper-cased.
  - Only https is taken, with no port, no credentials and at most 1,000 characters. The link is read only for its host and key, and never opened.
  - A host other than the connected site's is refused (`other_site`).
  - The issue is read once by key on the connected site (JR8), and its numeric id is stored. Every later read is by id.
  - Only a pending milestone can be linked. Linking is refused when:
    - the milestone is verified by a pull request (`github`);
    - it is linked in Asana (`asana`);
    - it is linked in Linear (`linear`);
    - it is already linked in Jira (`milestone_linked`);
    - the issue on this site is linked to another live milestone (`issue_linked`).
  - **One tool per milestone, enforced on the server:**
    - Linear's link refuses a milestone linked in Jira (`jira`).
    - Asana's link now refuses a milestone linked in Linear or Jira (`linear`, `jira`). This changes Asana's live command; today only `workToolCards` hides that card.
    - Each lookup reads as "not linked" before its own migration has run (0115, 0147, 0149).
  - After the insert, the webhook is made sure of (JR14). This is best effort, raced against 5 s, and never fails the link.

- **JR7. Criteria.** As LN5. They are the shared `milestones.acceptance_criteria`, written through Linear's `writeCriteria` and only while the milestone is pending. With no criteria, a done issue is held (`no_criteria`). Saving them makes such a link ready at once, from what was last read of it, by `writeState`: its state alone moves, compared against the state and reason it was seen in, and `last_read_at` stays as it was, since no read was made (JR15).

- **JR8. Reading an issue.**
  - **Status read** (1 request): `GET /rest/api/3/issue/{id}?fields=summary,status,resolution,resolutiondate,statuscategorychangedate,updated,project`.
  - **Full read** (2 requests):
    - the same GET with `,description,attachment,comment` added;
    - `GET /rest/api/3/issue/{id}/remotelink`;
    - plus `GET /rest/api/3/issue/{id}/comment?orderBy=-created&maxResults=50`, only when the embedded comment page holds fewer comments than its `total`.
  - **Which depth:**
    - A full read when the link's last read said done (`status_category = 'done'`, or state `ready` or `accepted`), and always before an acceptance.
    - Otherwise a status read, followed in the same call by a full read when it answers done and not canceled.

    An open issue costs one request a read, and its deliverables are read only once there is something to accept. A status read writes the facts it has and keeps the stored deliverables and fingerprint.
  - **Every request:**
    - only `api.atlassian.com`;
    - no trailing slash before the query;
    - the cloudId, id and key are checked by regex before any URL is built;
    - `redirect: "error"`, a 15 s timeout and `no-store`;
    - an answer for another id than the one asked throws `bad_response`.
  - **Deliverables, once done.** They are sorted and de-duplicated as Linear's, and their fingerprint is Asana's `fingerprintOf`. At most 50 are kept, within 30,000 bytes (Linear's `storedBytes`); the rest are counted by number.

    | Source | Kind | id | Label and href | Version |
    |---|---|---|---|---|
    | File attachments (at most 50) | `attachment` | `file:<id>` | the filename; `<site>/secure/attachment/<id>/<encoded filename>` | `created` |
    | Remote (web) links (at most 50) | `attachment` | `remotelink:<id>` | the title; the https url | the url |
    | Links in the description's ADF | `link` | the link | | |
    | Links in the comments' ADF (the newest 50 comments) | `comment_link` | the link | | |

    Links to the issue itself are dropped.
  - **ADF.** A bounded walk (depth 50, 20,000 nodes) collects:
    - `link` marks (`attrs.href`);
    - the `attrs.url` of `inlineCard`, `blockCard` and `embedCard`;
    - bare https links in text nodes (Asana's `linksIn`).

    Each goes through `httpsLink`.
  - The key, title (at most 255 characters), browse URL (`<site>/browse/<KEY>`), project id and project key are refreshed on every read, so a moved issue keeps its link.
  - The words of the description and the comments are never kept, and no person field is ever requested (JR19).

- **JR9. Done, canceled, and when.**
  - **Done** means `status.statusCategory.key === "done"` (the key, never the name) and not canceled. Any other key, or none, means not done.
  - **Canceled** means category done and a resolution name (lower case, trimmed, curly apostrophes straightened) in this list: won't do, won't fix, cancelled, canceled, duplicate, declined, rejected, cannot reproduce, incomplete, obsolete, abandoned, not a bug, invalid. The card shows the resolution.
  - A site whose admin named a cancel resolution differently reads as done. That still only makes the link ready: a person accepts against the criteria and sees the resolution.
  - **`completedAt`** is `statuscategorychangedate`, else `resolutiondate`, else null.
    - The first changes every time the issue leaves Done and comes back, even in workflows that leave the resolution set on reopen. So a reopen and redo between two reads is still seen (L10 pins this).
    - Dates such as `+0700` are normalised to ISO UTC.

- **JR10. States.** As LN7, without `archived`:
  - `waiting`: not done;
  - `ready`: done, with criteria;
  - `accepted`;
  - `held`: `reopened`, `canceled`, `deliverable_changed`, `issue_unreachable`, `no_criteria` or `unlinked`.

  A done issue is never accepted by a read. Linear's `planRead` and `acceptable` are reused with `archived: false` always. Jira's `HeldReason` is Linear's without `archived`, and one narrowing line (an unreachable `archived` is read as `issue_unreachable`) keeps the types honest. A test pins that no read yields `archived`.

  One rule is Jira's own (`planJiraRead`): a read that finds the issue gone (a 404 or 403, or a link of another site) holds the link `issue_unreachable`, whatever it was held for, even after an acceptance. Linear's plan keeps a link held after an acceptance held for its old reason; in Jira that would leave Accept offered on an issue Jira no longer shows, since the facts last read still say done, and its id in every change check, which Jira refuses whole (JR16). The link stays held.

- **JR11. Accepting.** As LN8:
  - the person ticks that they checked each criterion against the deliverables shown;
  - the issue is read again, in full;
  - the fingerprint and the criteria hash must be the ones shown, otherwise the refusal is `stale` or `criteria_changed`;
  - `accept_jira_issue` verifies the pending milestone with method `jira`;
  - `runCycleSoon(cycleEventOf(actor, "milestone_verified"))` follows.

  The agent then decides the payment under every guardrail, as for any verified milestone.

- **JR12. Self-acceptance.** As LN9. The acceptance is refused when:
  - the member's email is the payee's `notice_email` (`payee_member`); or
  - an Atlassian account found by the payee's email is the member's own (`payee_jira`). The member's own account is `GET /rest/api/3/myself` when that member connected Jira, else the account found by the member's email.

  The lookups are `GET /rest/api/3/user/search?query=<email>&maxResults=10`.
  - A result counts when its `emailAddress` equals the email (case-insensitive) or is hidden. A hidden email errs toward refusing, the safe direction.
  - accountIds are compared in memory only.
  - Nothing is asked when there is no payee email.

  Pay now on a Jira-linked milestone refuses the payee by email (`approvesOwnJiraPayout`).

- **JR13. Invalidation.** As LN10. After an acceptance, the acceptance is taken back when:
  - the issue left Done, or is done again with another `completedAt` (`reopened`);
  - it was `canceled`;
  - a deliverable changed (`deliverable_changed`);
  - Jira no longer shows it (`issue_unreachable`): a 404 or 403, a deleted issue, an archived one if Jira answers 404, lost access, or another site connected now.

  Before payment, `hold_jira_acceptance` takes the verification back and holds the milestone. After a payment was sent, only the link is held, as a dispute. Revoke manually is refused on a milestone accepted from Jira; Verify manually is refused while one is linked.

  An issue Jira stops showing after its acceptance was taken back is held `issue_unreachable` from then on (JR10), and an acceptance whose own full read finds it gone is refused, whatever the link said before, so it is never accepted again from what was read before.

- **JR14. One webhook per connection.**
  - It is registered with the connecting person's token:
    - url `<siteOrigin()>/api/integrations/jira/webhook`;
    - events `jira:issue_updated`, `jira:issue_deleted`, `comment_created`, `comment_updated` and `comment_deleted`;
    - `jqlFilter` `project in (10000, 10001)`: the numeric ids of the projects of live links on open milestones (pending, verified, held) on this site, sorted, at most 100. Ids never change when a project's key does.
    - No field filter, because attachment and comment changes must arrive.
  - With no open link there is no webhook.
  - **`ensureJiraWebhook`** runs on connect, after a link or unlink, on Check linked issues now (forced), and in every sweep. It makes no request when the site row was checked in the last 24 hours, its JQL is the one wanted, and its webhook does not expire within 7 days. Otherwise:
    1. Call `accessible-resources` (the keep-alive and site check of JR3).
    2. If no JQL is wanted, delete ours.
    3. If the JQL differs, or there is no webhook, register a new one, then retire the old: delete it and keep its id routable for 2 hours in `retired_webhook_ids`.
    4. If the JQL is the same, `GET /rest/api/3/webhook` (paged until `isLast`, at most 3 pages) is the truth. Our id missing from it means register; an expiry within 7 days means renew.
  - **Renewing:**
    1. `PUT /rest/api/3/webhook/refresh` `{webhookIds}`, as the spec says.
    2. On a 404 or 405, `PUT /rest/api/3/webhook`, as the guide says.
    3. If neither returns an expiry more than 7 days away, rotate: register a new webhook and retire the old.

    No undocumented path is ever required.
  - The expiry is read from the list, or else taken as 30 days after registration.
  - **Registration errors:**
    1. Clean orphans once: list, and delete the ids whose url is ours and that no live `jira_sites` row anywhere holds as current or retired.
    2. Retry once.
    3. If it is still refused, write `webhook_error` (JR22) on the row and the card. The sweep goes on.

    Orphan cleanup is also how the 5-per-user cap is respected.

- **JR15. Deliveries only nudge a read.**
  - `POST /api/integrations/jira/webhook`, `maxDuration` 60.
  - **The token is checked before the body is read:**
    - `Authorization: Bearer <jwt>`, at most 4,096 characters, three base64url parts;
    - header `alg` must be HS256, HS384 or HS512, all keyed by `JIRA_CLIENT_SECRET`. `none`, RS* and ES*, or a missing alg, are refused, so the algorithm cannot be confused;
    - the HMAC is compared with `timingSafeEqual`;
    - `exp`, when present, may be at most 300 s past;
    - `nbf`, when present, may be at most 300 s ahead;
    - no other claim is required.

    A failure answers 401 and the body is never read.
  - **Then the body:**
    1. It must be at most 4,000,000 bytes, under Vercel's 4.5 MB request cap, else 413.
    2. It must be JSON, else 401.
    3. `deliveryOf` takes only `webhookEvent`, `matchedWebhookIds` (1 to 20 positive safe integers), `issue.id` (`^[0-9]{1,18}$`), `issue.self` and `timestamp`. Any other event or shape is ignored with a 200.
    4. Every signed delivery answers exactly 200, and its work is deferred through `after()`.
  - There is no timestamp window, unlike Linear's 60 s. Jira retries 5 to 15 minutes later and never retries a 401. Nothing in a delivery is believed, and reads are idempotent (the `writeRead` compare-and-set and the SQL row locks), so a replay costs at most a read.
  - **Fan-out.** Every `jira_sites` row whose current ids, or retired ids within their 2 hours, overlap `matchedWebhookIds` is found by a GIN overlap, at most 20 rows.
    - A row is skipped when `issue.self` parses and names another site host (the `https://<host>/rest/api/<n>/issue/<id>` form) or another cloudId (the `https://api.atlassian.com/ex/jira/<uuid>/...` form). A `self` that does not parse is read anyway.
    - Each remaining row runs in its own workspace's scope (`withOrg`):
      1. its connection must still be the workspace's live Jira connection;
      2. it takes the live links with that cloudId and that issue id, at most 5;
      3. a link is skipped when its last read **started** at least 5 s after the delivery's `timestamp`, since that read already saw the change (`last_read_at` is the read's start time; failed reads, and criteria saved with no read, do not set it);
      4. the rest are read with `readLinks`.

      A comment followed by Done 30 s later is therefore read twice, never left for the sweep.
    - `last_delivery_at` is touched on each matched row.
    - One workspace's failure is its own, logged by error name.
  - **Logs.** Claim names, never values, are logged once per process. For an expired token, the seconds past `exp` are logged. For a refused delivery, `X-Atlassian-Webhook-Retry` and `-Flow` are logged.
  - There is no delivery table. The header `X-Atlassian-Webhook-Identifier` is not needed, because the `timestamp` rule already makes retries free.
  - Risk recorded: whether the token binds the body is not documented. A captured token could be replayed with another body until it expires. Nothing is believed and reads are capped per delivery, so the worst case is a few extra reads of a workspace's own linked issues.

- **JR16. The sweep, and the other reads.**
  - **Sweep** (`syncJiraConnection`, every 15 minutes, under a 5-minute lease):
    1. If the global pause is on (JR17), finish `rate_limited` with `next_sync_after` set to the pause's end, making no request.
    2. Run `ensureJiraWebhook`. A refusal is recorded on the site row, and the sweep goes on.
    3. Take the links of open milestones (`linksOfMilestones`, statuses verified, held and pending), at most 100. A link on another cloud is read as `gone` with **no request** and held `issue_unreachable`. This is how an old site's links are kept from being read as the new site's issues, whose numeric ids may collide.
    4. Unless forced, check for changes: `GET /rest/api/3/search/jql?jql=id in (…)&fields=updated&maxResults=50`, in chunks of 50 (at most 2 calls), over this cloud's links whose last read succeeded and that are not held `issue_unreachable`.
       - If it answers 400 (an id deleted or hidden), fall back to treating every such link as a candidate, oldest `last_read_at` first. The fallback is logged once per run.
    5. Choose the links to read, in this order, at most `SWEEP_READS` = 20 reads that make a request:
       - links never read, or with a `read_error`;
       - links whose `updated` differs from `issue_updated_at`, or that are missing from the search's answer;
       - floors: accepted links not read in the last hour, and other links not read in the last 24 hours. The floors catch web-link edits that may not move `updated`.

       Accepted links come first, then ready, held and waiting; within each, the oldest read first.
    6. Read them with `readLinks` within 60 s.
    7. Finish `synced`, then `recordUsage(connector_sync, "jira")`.

    Errors map as in Linear's sweep, with `syncErrorWords("…", "Jira")`. A `JiraAccessError` that needs reconnecting, and JiraSiteGoneError (on its second miss), finish `reconnect`.
  - **The cycle** (`refreshJiraMilestones`): accepted links of milestones verified with method `jira` that are verified or held, at most 10 within 30 s, read in full.
  - **The read before sending** (`recheckJiraBeforeSending`): the accepted links of the releases about to be sent. The reads stop starting after 10 s, and the stage waits at most 20 s.
    - If Jira does not answer or is paused, `complete` is false and the acceptances stand as given, as with Linear. The webhook and the sweep read them again.
    - Both cycle helpers never throw.
  - **Check Jira now** on a card reads that link. **Check linked issues now** is a forced sweep.

- **JR17. Atlassian's shared rate limit.**
  - A 429 whose `RateLimit-Reason` starts with `jira-quota-global` sets a process-wide pause until its `Retry-After`. The default is 60 s and the cap is 1 hour.
  - While paused, every Jira call fails at once with `rate_limited` and makes no request. So one sweep does not walk every connection into the wall, and the rest of that run's Jira connections finish `rate_limited` with `next_sync_after` set.
  - Any other 429 is waited out once by the session when short (`waitInRun`), or fails the run with its `Retry-After`.
  - The budget is under "Read budget".

- **JR18. Nothing from Jira moves money.**
  - Jira code never imports payment code.
  - It writes no `payment_intents`, and no amount, payee, address or escrow.
  - It writes no `milestones` row directly. The only milestone writes are the two SQL functions and Linear's shared `writeCriteria`.

- **JR19. No Atlassian person data is kept.**
  - `jira_issue_links` has no `completed_by_*` or `assignee_*` columns, and no read asks for those fields.
  - No ledger detail or row carries an accountId, an Atlassian name or an email.
  - Identity lookups (JR12) happen per acceptance, in memory.
  - So there is no `report-accounts` duty, and the guide and the privacy page say so.

- **JR20. Evidence links.**
  - On Contractors and the evidence page, a link to `https://<connected site host>/browse/KEY` is checked at `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/issue/<KEY>?fields=summary`, with the workspace's own Jira token. The link a person typed is never opened.
  - The site's host and cloudId are loaded once per check, only when Jira is on, the check runs in a workspace's scope, and some link's host is none of GitHub's, Asana's, Linear's or storage's.
  - `requestAllowed` takes only that exact path shape.
  - Links on other Atlassian hosts, and other paths on the site, are "Not checked".

- **JR21. Figures, and whether Jira's notices arrive.**
  - The figures are as LN15: acceptances, disputes and the median time from an acceptance to the agent's decision, over 30 days. They come from `jira_work_accepted`, `jira_acceptance_withdrawn`, `milestone_release` and `milestone_hold`.
  - The sweep records `jira_sites.missed_change_at` when it reads a changed link that no delivery told it of: the issue's `updated` is at least 2 minutes old, and `last_delivery_at` is null or older than it.
  - The card's notice line (JR22) shows it while it is under 24 hours old and newer than `last_delivery_at`. That line is how Atlassian's owner-only delivery rule, a lapsed webhook or a refused token becomes visible.

- **JR22. Words and places.**
  - Settings has the Jira card (`section id="jira"`, after Linear's).
  - Contractors has a Jira card under each milestone that is waiting for verification or linked to an issue. Ready and held count under Needs you.
  - The evidence page shows Jira's word that the issue was done beside the person's acceptance.
  - The consent, privacy, terms and security pages, the guide, the docs and the repo docs say what is read, kept and written, in plain English (see "Words").
  - No Atlassian logo ships: `jira` joins `UNMARKED_PROVIDERS`, and the cards use the work-tool icon (SquareKanban).
  - The landing page does not change until Jira is proven live with a second Atlassian account.

## Every gap in map a4, resolved

| Gap | Decision | Rule |
|---|---|---|
| A1 Number and guard | 0149, listing all 11 providers and all 7 methods, guarded by `like '%jira%'`, merged last | JR5 |
| A2 Linear sentinels | `tests/linear-migration.test.ts` lines 140, 161, 178 and 186 change from `'jira'` to `'sage'` | Tests |
| B1 SDK types | Edit `src/lib/api/schemas.ts:224` and `src/lib/api/milestones.ts:13`, run `npm run sdk:types`, release SDK 0.4.3 and run `npm run sdk:pack`. The CLI does not change | Files |
| B2 Refresh 403 | `invalid_grant` on 400, 401 or 403 means reconnect; `invalid_client` and `unauthorized_client` mean unavailable plus a deployment log line | JR3 |
| B3 Disconnect | Webhooks deleted first (Asana's order), then the core disconnect with a revoke that makes no request | JR4 |
| B4 Consent | Its own `JIRA_STATEMENT`: one webhook, no person data, and the Connected apps removal | Words |
| B5 Several sites | Both: the owner opts into resource-restricted tokens, and the code takes any count (choose flow, `no_site`) | JR2 |
| B6 Site storage | `jira_sites`, a platform table, plus `cloud_id` on every link; `firstSync` and `afterConnect` | JR5, JR2 |
| B7 Env | Two variables only | JR1 |
| B8 Timestamp window | No window. A link is skipped when its last read started at least 5 s after the delivery's `timestamp`. No delivery table | JR15 |
| B9 Several webhook ids | Fan-out to every row whose ids overlap, cross-checked against `issue.self` | JR15 |
| B10 JWT | Written by hand with `node:crypto`, about 40 lines (the repo signs HS256 by hand in `src/lib/dal/request-token.ts` and checks HMACs in `src/lib/connectors/state.ts`). No new dependency | JR15 |
| B11 CSP | `FORM_TARGETS` gains `https://auth.atlassian.com` and `https://id.atlassian.com`. `form-action` is report-only in production (`REPORT_ONLY_DIRECTIVES`, csp.ts:101), so a missed host shows in `/api/csp-report` and never breaks connecting | Files, L4 |
| B12 Landing | No change until it is proven live; a follow-up adds Jira and Linear to the FAQ in words | JR22 |
| B13 Command names | Linear's `milestone.*_issue` names are reused | JR6 |
| B14 90 days | A daily `accessible-resources` call for every connection; `idleDays` 90 in the words | JR3 |
| B15 Scopes | Four classic scopes. `read:issue-details:jira` is decided by L13 **before** sharing is turned on, when no customer has consented yet | JR3, L13 |
| B16 accountIds | None stored | JR19 |
| B17 65k pool | Status reads first, a batched change check, floors, caps and the global pause | JR8, JR16, JR17 |
| B18 Keys | Links keyed by `(cloud_id, issue_id)`; key, URL and project refreshed on every read; a bare key resolved to its id at link time | JR6, JR8 |
| B19 Canceled | A resolution list on top of the done category; `completedAt` order fixed; archived taken as 404 | JR9, JR13 |
| C Owner-only delivery | Sharing on before any customer; a second-account test; the sweeper as fallback; the card's notice line | JR21, L8 |
| C Field filter name | No field filter is used | JR14 |
| C Refresh path | `/webhook/refresh`, then `PUT /webhook`, then rotation, reconciled through the list | JR14 |
| C Items without an official URL | Token lifetime read from `expires_in`; only the key `done` counts; revoke makes no request; vendor and privacy fields, a second admin and Block user apps are owner steps and guide text | JR3, JR9, Owner steps |
| C Undocumented items | JWT claims are logged by name. Event order does not matter (every delivery causes a fresh read). Webhook-id collisions are covered by the fan-out and the `self` check. Visibility of deliveries: reads use the same user's token. The changelog is never read. Comments: the newest 50, with an extra request when the page is truncated. ADF: a bounded walk. Callback: one production URL | JR8, JR15 |
| C Contradictions | One site against several: B5. Archived as 404: noted risk L11. The 90-day and 10-minute windows: both assumed, and neither is relied on | JR3, JR13 |

## Data: migration `supabase/migrations/0149_jira_acceptance.sql`

The owner runs it. It is merged last.

**Header.** The header says:
- the migration is additive and idempotent;
- "A later widening must keep jira beside its own value";
- merge it after any open change that redefines `accounting_connections_provider_check`, `accounting_tokens_provider_check` or `milestones_verification_method_check`;
- before it runs, the app reads PGRST205, PGRST202, PGRST204, 42P01, 42703 and 42883 as "not set up";
- a Down section, in comments.

1. **Provider checks.** One `do` block, following 0147's template. Each constraint is replaced only while `pg_get_constraintdef(oid) not like '%jira%'`, by `check (provider in ('xero','quickbooks','hubspot','asana','pipedrive','zohobooks','zohocrm','googlesheets','linear','googledrive','jira'))`, on `accounting_connections` and on `accounting_tokens`.
2. **Method check.** While no check on `milestones` that mentions `verification_method` contains `jira`, every such check is dropped and replaced by `milestones_verification_method_check check (verification_method in ('unverified','github','manual','seed','asana','linear','jira'))`.
3. **`public.jira_issue_links`** (tenant data). The same as 0147's `linear_issue_links`, except:
   - `cloud_id` text not null (UUID check);
   - `issue_id` text not null `^[0-9]{1,18}$`;
   - `identifier` `^[A-Z][A-Z0-9_]{0,49}-[0-9]{1,18}$`;
   - `project_id` (`^[0-9]{1,18}$` or null) and `project_key` (`^[A-Z][A-Z0-9_]{0,49}$` or null) in place of team;
   - `issue_title` 1 to 255 characters;
   - `issue_url` null, or `~ '^https://[^/[:space:]]{3,253}/browse/[A-Z][A-Z0-9_]{0,49}-[0-9]{1,18}$'` and at most 500 characters;
   - `held_reason` in (`reopened`, `canceled`, `deliverable_changed`, `issue_unreachable`, `no_criteria`, `unlinked`);
   - `status_category` `^[a-z_-]{1,40}$`, `status_name` 1 to 200, `resolution_name` 1 to 200 or null;
   - `attachments_read`, `remote_links_read` and `comments_read` each 0 to 50.

   Kept from 0147:
   - `id`, `org_id`, `milestone_id`, `connection_id`, `state`, `after_payment`, `held_at`, `completed`, `completed_at`;
   - `deliverables` (array, 32,000 bytes or fewer), `deliverable_fingerprint`, `more_unread`, `issue_updated_at`, `last_read_at`, `read_error`;
   - `accepted_by`, `accepted_at`, `accepted_fingerprint`, `accepted_completed_at`, `accepted_criteria_sha256`, `accepted_deliverables`;
   - `linked_by`, `linked_at`, `unlinked_by`, `unlinked_at`, `updated_at`;
   - the `(org_id, id)` unique key, the foreign keys to `milestones` and `accounting_connections` with on delete cascade, and the held, accepted and completed checks.

   Not present: `completed_by_*`, `assignee_*`, `team_*` and `archived` (JR19).

   Indexes:
   - unique `jira_issue_links_milestone_key (org_id, milestone_id) where unlinked_at is null`;
   - unique `jira_issue_links_issue_key (org_id, cloud_id, issue_id) where unlinked_at is null`;
   - `jira_issue_links_connection_idx (org_id, connection_id) where unlinked_at is null`.

   RLS exactly as 0147: select, insert and update to `vestiarion_tenant` (no delete), `tenant_isolation`, the restrictive `tenant_isolation_guard`, and all to `service_role`.
4. **`public.jira_sites`** (a platform table, as `asana_webhooks` is; the webhook route finds rows by webhook id before any workspace is known):

   | Column | Type and check |
   |---|---|
   | `connection_id` | uuid primary key; `(org_id, connection_id)` references `accounting_connections (org_id, id)` on delete cascade |
   | `org_id` | uuid not null, references `orgs` on delete cascade |
   | `cloud_id` | text not null, UUID check |
   | `site_url` | text not null, `~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'`, at most 261 characters |
   | `webhook_ids` | bigint[] not null, default `'{}'`, `cardinality(webhook_ids) <= 5` |
   | `retired_webhook_ids` | bigint[] not null, default `'{}'`, `cardinality <= 5` |
   | `retired_until` | timestamptz |
   | `webhook_jql` | text, 1 to 4,000 characters |
   | `webhook_expires_at`, `webhook_registered_at`, `webhook_checked_at` | timestamptz |
   | `webhook_error` | text, 1 to 300 characters |
   | `last_delivery_at`, `missed_change_at`, `site_missing_at` | timestamptz |
   | `updated_at` | timestamptz not null, default `now()` |

   GIN indexes on `webhook_ids` and on `retired_webhook_ids`. RLS is enabled; everything is revoked from `anon`, `authenticated` and `vestiarion_tenant`, and all is granted to `service_role`.
5. **`accept_jira_issue(p_org_id, p_link_id, p_by, p_fingerprint, p_criteria_sha256, p_note) returns public.jira_issue_links`.** A copy of `accept_linear_issue`: plpgsql, security invoker, `search_path ''`.
   - It locks the link and raises, in order, `link_not_found`, `already_accepted`, `after_payment`, `issue_unreachable` (a link held because Jira stopped showing its issue, in place of Linear's `archived` step), `not_completed` and `stale`.
   - It locks the milestone and raises `milestone_not_open`, `no_criteria` and `criteria_changed`.
   - It sets the milestone verified, `status 'verified'`, `verification_method 'jira'`, `verification_status 'verified'`, and `verified_at` and `checked_at` to now. `verification_detail` is `{note, jiraIssue: issue_url, issueId, identifier, cloudId, completedAt, fingerprint, criteriaSha256, acceptedBy}`.
   - It sets the link accepted, as 0147 does.
6. **`hold_jira_acceptance(p_org_id, p_link_id, p_reason) returns text`.** A copy of 0147's function, with reasons `reopened`, `canceled`, `deliverable_changed`, `issue_unreachable` and `unlinked`, else `bad_reason`.
   - The same underway rule, and `deferred` while `decision_claimed_at` is under 10 minutes old.
   - The milestone is updated only when `verification_method = 'jira'`.
   - It answers `held`, `held_after_payment`, `deferred` or `not_accepted`.
7. **`jira_connector_ready(p_org_id uuid) returns boolean`**, `language sql stable as 'select true'`.
8. Execute on the three functions is revoked from public, `anon` and `authenticated` and granted to `vestiarion_tenant` and `service_role`, followed by `notify pgrst, 'reload schema'`.

## Files

### New, under `src/lib/jira/`

Each file is the twin of `src/lib/linear/<same name>` unless noted.

- **`settings.ts`**
  - `JiraSettings {clientId, clientSecret}`.
  - `jiraSettingsFromEnv(env = process.env)`.
  - `JIRA_SCOPES`, and `SCOPES_BY_CONSENT` (JR3).
- **`http.ts`**
  - Constants: `JIRA_AUTH_HOST`, `JIRA_API_HOST`, `JIRA_AUTHORIZE`, `JIRA_TOKEN`, `JIRA_RESOURCES`, and `JIRA_LOGIN` (CSP only).
  - Regexes: `UUID`, `ISSUE_ID`, `ISSUE_KEY`, `PROJECT_KEY`.
  - `apiUrl(cloudId, path, query?)`, `jiraFetch(url, init, label, deps)` and the global pause (JR17).
  - `waitOf`: `Retry-After` in seconds or as a date, else 60 s, capped at 1 hour.
  - `failureOf(response, label, nowMs)`: 429 is `rate_limited`, 401 `unauthorized`, 403 `forbidden`, 5xx `unavailable`, anything else `bad_response`.
  - `jsonOf(response, label, maxBytes)`: 4 MB for issue reads, 1 MB for everything else.
- **`oauth.ts`**
  - `authorizeUrl`, `exchangeCode`, `refreshTokens` (JR3).
  - `revokeToken(): Promise<false>`, which makes no request.
  - `grantSites(token, deps)`, which throws `ConnectRefusal("no_site")` when there is no site.
  - `accessibleSites(token, deps)`.
- **`provider.ts`**
  - `JiraProvider extends ConnectingProvider {reader, hooks: JiraWebhookApi}`.
  - `jiraProvider(settings, deps)` and `jiraProviderFromEnv()`.
- **`connect-deps.ts`**: `jiraConnectDeps(settings)`, with:
  - `ready`, where `JiraNotSetUpError` becomes `NotSetUpError`;
  - `afterConnect: (work) => after(work)`;
  - `firstSync: ensureJiraSite`.
- **`session.ts`**: `JiraAccessError`, `JiraSession` and `jiraSession`, a copy.
- **`map.ts`** (pure)
  - `mapTokens(json, nowMs, keepRefresh?)`, `mapSites`, and `jiraDate` (`+hhmm` to ISO UTC).
  - `IssueFacts {id, key, title, url, projectId, projectKey, statusCategory, statusName, resolutionName, completed, canceled, completedAt, updatedAt, depth: "status" | "full", descriptionLinks, attachments, remoteLinks, comments, moreUnread, counts}`.
  - `CANCELED_RESOLUTIONS`, `mapIssue(json, remote, siteUrl)`, `mapPeople` and `emailOf`.
- **`api.ts`**
  - `IssueRead`.
  - `ISSUE_STATUS_FIELDS` and `ISSUE_FULL_FIELDS`.
  - `ATTACHMENTS_READ`, `REMOTE_LINKS_READ` and `COMMENTS_READ`, each 50.
  - `JiraReader`:
    - `issue(token, site, ref, depth)`: a 404 is `gone not_found` and a 403 is `gone forbidden`;
    - `changed(token, site, ids): Map<id, updated> | "refused"`;
    - `people(token, site, ask)`;
    - `sites(token)`.
- **`urls.ts`** (pure): `IssueRef {key, host | null}`, `issueRefOf(raw)` (JR6) and `linksToIssue(href, key, siteUrl)`.
- **`deliverables.ts`** (pure)
  - `adfLinksIn(doc)` and `deliverablesOf(...)`, with JR8's order and caps.
  - It re-exports Asana's `fingerprintOf` and `MAX_DELIVERABLES`, and Linear's `DELIVERABLES_BYTES` and `storedBytes`.
- **`acceptance.ts`**
  - Re-exports `planRead`, `acceptable`, `LinkState`, `LinkFacts`, `ReadFacts` and `ReadPlan`.
  - `planJiraRead`: Linear's plan in Jira's reasons, with a gone read holding the link `issue_unreachable` whatever it was held for (JR10).
  - Jira's own `HeldReason` and its narrowing, `Identities {memberEmail, payeeEmail, payeeJiraIds, memberJiraIds}`, `selfAcceptance` and `SELF_WORDS`.
  - `stateWords` and `HELD_LINES`.
  - `ACCEPTED_ACTION = "jira_work_accepted"` and `WITHDRAWN_ACTION = "jira_acceptance_withdrawn"`.
  - `acceptanceKpis`, which calls Linear's with Jira's actions.
- **`links.ts`**
  - `IssueLink`, `LINK_COLUMNS`, `toIssueLink` and `factsOf` (`archived` is always false).
  - `isJiraNotSetUp` and `JiraNotSetUpError`.
  - `liveLinks({milestoneIds?, connectionId?, cloudId?, issueIds?, states?, limit?})` and `linksOfMilestones({statuses, method?: "jira", states?, limit})`.
  - `jiraReady()`: the RPC, the link table and `siteTableReady()`.
  - `insertLink`, where a 23505 on `_milestone_key` or `_issue_key` becomes `milestone_linked` or `issue_linked`.
  - `ReadWrite`, whose deliverables part is null after a status read. Then `writeRead`, `writeState` (a state moved with no read, JR7), `writeReadError`, `holdAcceptance`, `acceptLink`, `AcceptRefusedError` and `unlinkLink`.
  - It re-exports Linear's `milestonesForAcceptance` and `writeCriteria`.
- **`sites.ts`** (new). The only module that reads or writes `jira_sites`. Every function asserts `currentOrgId() === orgId`, except `sitesForWebhooks` and `touchDelivery`.
  - `siteFor`, `saveSite`, `setWebhooks`, `retire`, `markChecked`, `markMissing`, `markMissedChange`, `clearSite`.
  - `sitesForWebhooks(ids)`, which uses `platformDb` and the overlap rule, at most 20 rows.
  - `touchDelivery` and `siteTableReady`.
- **`reads.ts`**
  - `ReadContext {session, reader, site, now?}`, `factsFromRead`, `readFailureWords` and `REASON_WORDS`.
  - `readLink(link, milestone, ctx, depth)`: a cloudId mismatch is `gone` with no request. A read outcome says `gone` when Jira no longer showed the issue.
  - `readLinks`.
  - Ledger entries `jira_issue_ready` and `jira_acceptance_withdrawn`.
- **`workspace.ts`**
  - `jiraContext`, `markReconnect` and `needsReconnect`.
  - `refreshJiraMilestones` and `recheckJiraBeforeSending`.
  - `syncJiraConnection(connectionId, provider, {now?, force?})`.
  - `rereadIssueInScope` and `rereadForDelivery`.
  - `jiraLinkCheck()`, for JR20.
  - Constants: `CYCLE_READS` 10, `CYCLE_BUDGET_MS` 30,000, `SEND_BUDGET_MS` 10,000, `SEND_DEADLINE_MS` 20,000, `SWEEP_LINKS` 100, `SWEEP_READS` 20, `SWEEP_LINK_BUDGET_MS` 60,000, `ACCEPTED_FLOOR_MS` 1 hour, `OTHER_FLOOR_MS` 24 hours, `DELIVERY_READS` 5, `DELIVERY_SEEN_MS` 5,000, `MISSED_AFTER_MS` 120,000.
- **`webhooks.ts`** (new; the twin of `pipedrive/webhooks.ts`)
  - `JIRA_EVENTS` and `desiredJql(projectIds)`.
  - `JiraWebhookApi {register, renew, list, remove}`.
  - `ensureJiraSite`, `ensureJiraWebhook`, `stopJiraWebhooks` and `cleanOrphans`.
  - `JiraSiteGoneError`.
- **`webhook.ts`** (delivery)
  - `MAX_BODY_BYTES` 4,000,000 and `EXP_LEEWAY_S` 300.
  - `verifyJiraToken(secret, authorization, nowMs)`, `deliveryOf(body)` and `handleJiraWebhook(request, {secret, defer, reread, now?})`.
- **`identities.ts`**: `identitiesOf` and `approvesOwnJiraPayout`.
- **`views.ts`**
  - `JiraMilestoneView`: Linear's shape without person names, plus `resolutionName` and `siteHost`.
  - `jiraMilestoneView` and `jiraNeedsPerson`.
  - `JiraPanelView`, with `noticeLine`; and `jiraPanelView`.
- **`panel.ts`**: `jiraPanelFor(nowMs)`.
- **`contractors.ts`**: `jiraOnContractors(milestoneIds)`.

### Other new files

- `src/lib/commands/jira.ts`, a copy of `commands/linear.ts`:
  - `linkJiraIssue`, `unlinkJiraIssue`, `setJiraAcceptanceCriteria`, `acceptJiraWork` (it records `payeeJiraMapped`) and `checkJiraIssue`;
  - `MISSING_WORDS`;
  - the helpers `linkedInAsana` and `linkedInLinear`.
- `src/app/actions/jira.ts`:
  - `disconnectJiraAction` (JR4);
  - `syncJiraNowAction` (a forced sweep);
  - the link, unlink, criteria, accept and check actions.
- Routes under `src/app/api/integrations/jira/`. Each answers 404 when Jira is off.
  - `connect/route.ts` (POST `startConnect`);
  - `callback/route.ts` (GET `finishConnect`, `maxDuration` 60);
  - `choose/route.ts` (POST `chooseConnect`, `maxDuration` 60);
  - `webhook/route.ts` (POST, `maxDuration` 60, `handleJiraWebhook(request, {secret: settings.clientSecret, defer: (work) => after(work), reread: (event) => rereadForDelivery(event, provider)})`).
- `src/app/integrations/jira/page.tsx`: the launch page, as Linear's, with the not-set-up EmptyState.
- `src/app/integrations/jira/connect/page.tsx`: Linear's page, plus:
  - a choose branch (`pendingChoice`, a form posting to `/api/integrations/jira/choose`, `NativeRadioGroup name="organisation"`, the button "Connect this site");
  - the `expired` and not-set-up EmptyStates;
  - `ERRORS` forbidden, not_set_up, expired and pick.
- `src/components/JiraPanel.tsx` and `src/components/JiraIssueCard.tsx`.
- `src/app/docs-shots/jira/[state]/page.tsx` (settings, link, ready, accepted, held) and `src/app/docs-shots/jira-fixture.ts`: the site `northstar.atlassian.net`, the issue ENG-142 "Webhook retries with backoff", resolution "Done".
- `content/docs/guides/jira.mdx`.
- This spec, at `docs/superpowers/specs/2026-11-09-jira-acceptance-design.md`.

### Changed

**Connector core**
- `src/lib/connectors/provider.ts`:
  - `PROVIDERS`, `UNMARKED_PROVIDERS` and `PROVIDER_LABELS` ("Jira") gain jira;
  - `PROVIDER_KINDS.jira = "work"`;
  - `PROVIDER_WORDS.jira`: possessive "Jira's", organisation "site", contacts "users", accounts "no accounts", idleDays 90, bills "linked issues", approval "An issue done in Jira is never by itself a reason to pay: a person accepts the work against its criteria.", workItem "issue", revokedIn "the Atlassian account";
  - `ProviderWords` gains an optional `revokedIn`;
  - the `AccountingProviderId` Exclude list gains `"jira"`.
- `src/lib/connectors/consent.ts`: `CONSENT_VERSIONS`, `CONSENT_HISTORY`, `JIRA_STATEMENT` and a branch in `consentStatement`.
- `src/lib/connectors/connect-refusal.ts`: the outcome becomes `"scopes" | "no_site"`.
- `src/lib/connectors/status.ts`: the work-kind reconnect words (JR3).
- `src/lib/connectors/booking.ts`: `jira: false` in both maps.
- `src/lib/commands/accounting.ts`: `accountingProviderOf` gains jira.
- `src/lib/usage/model.ts`: `ACTION_LABELS.jira = "Jira"`.
- `src/lib/security/csp.ts`: `FORM_TARGETS` and its comment.
- `src/lib/subprocessors.ts`: Atlassian (Jira), only if connected. It is used for the reads of linked issues, the email addresses asked about, and one webhook per site.
- `src/lib/connectors/sweep.ts`: its comment.
- `src/lib/dal/index.ts`:
  - `TENANT_TABLES` gains `jira_issue_links`;
  - `TENANT_RPCS` gains the three functions;
  - `PLATFORM_TABLES` gains `jira_sites`, with a header paragraph naming `jira/sites.ts` as its one module.

**Commands and Linear**
- `src/lib/commands/index.ts`: exports.
- `src/lib/commands/policy.ts`: comment only ("a Linear or Jira issue").
- `src/lib/commands/linear.ts`: `linkedInJira`, which tolerates `JiraNotSetUpError`, and the refusal `jira`.
- `src/lib/commands/asana.ts`: `linkedInLinear` and `linkedInJira`, and the refusals `linear` and `jira`, after the `github` check.
- `src/lib/commands/milestones.ts`: `approvesOwnJiraPayout`, after Linear's.
- `src/app/actions/milestones.ts`: `jiraLinkOf`, and the verify and revoke refusals.
- `src/lib/linear/acceptance.ts`: `acceptanceKpis` gains an optional fourth parameter, the actions to count, defaulting to Linear's. This is its only change.

**Cycle and sweep**
- `src/lib/milestone-verification.ts`:
  - `Promise.all([refreshAsanaMilestones(), refreshLinearMilestones(), refreshJiraMilestones()])`, with a `jira` sub-result;
  - `Promise.all([recheckBeforeSending(milestoneIds), recheckLinearBeforeSending(milestoneIds), recheckJiraBeforeSending(milestoneIds)])`, with `jira.complete`.
- `src/lib/agent/orchestrator.ts`: only a Jira log line after Linear's, and `if (!recheck.jira.complete)` with "Jira: not every accepted issue could be read again just before sending; those acceptances stand as given". Its imports do not change.
- `src/app/api/platform/accounting-sync/route.ts`: `jiraProviderFromEnv()`, a `jira` branch in `providerFor`, and dispatch to `syncJiraConnection`.

**Screens**
- `src/lib/work-tool-cards.ts`. The input gains `jira`, and the output gains `jira` and `jiraCriteria`.
  - A tool's card is offered when it is linked, or when the milestone is pending, no other tool is linked, and this tool is connected or no other one is.
  - `jiraCriteria = jira && !asanaAsks && !linearCriteria`.
  - The fields that existed keep their values for every two-tool input. `toEqual` expectations therefore gain `jira: false, jiraCriteria: false`.
- `src/app/o/[slug]/contractors/page.tsx`:
  - `jiraOnContractors` joins the `Promise.all`;
  - Jira deliverable links join `evidenceHrefs`;
  - `workToolCards({…, jira})` and `JiraIssueCard`;
  - the `MilestoneVerification` condition becomes `((!asanaLink && !linearLink && !jiraLink) || milestone.verified) && linearLink?.state !== "accepted" && jiraLink?.state !== "accepted"`;
  - the hints and Needs you count `jiraNeedsPerson`.
- `src/app/o/[slug]/settings/page.tsx`: `jiraPanelFor`, the `?jira=` notice (cast as Linear's is) and `section id="jira"`.
- `src/components/vx/map.ts`: `verificationLabel` gains "Accepted from Jira".

**Evidence, accountant, API**
- `src/lib/evidence-chain.ts`: a `jira` branch, `JIRA_WITHDRAWN_WORDS` and `deliveredFromJira` ("Jira reported the issue done."). The link is offered when `issue_url` matches the browse pattern.
- `src/lib/close-pack/build.ts`: a Jira branch in `milestoneCheck`.
- `src/lib/accountant/read.ts`: the `waitingLinks` union gains `jira_issue_links`, gated on `jiraSettingsFromEnv`. `src/lib/accountant/triage.ts`: its comment.
- `src/lib/evidence-links/allow-list.ts` and `check.ts`: JR20. A `jira_issue` target, the `jiraSite` option, `requestAllowed`, the `LINK_WORDS` jira words, and `NOT_CHECKED_WORDS.host` and `.path` naming the connected Jira site.
- `src/lib/api/schemas.ts:224` and `src/lib/api/milestones.ts:13` gain `"jira"`. `sdk/src/types.ts` is regenerated with `npm run sdk:types`. `sdk/package.json` goes to 0.4.3, and `npm run sdk:pack` writes `public/sdk/vestiarion-sdk-0.4.3.tgz`.

**Policy pages and docs**
- `src/app/privacy/page.tsx`, `src/app/terms/page.tsx` and `src/app/security/page.tsx`: Jira wherever Linear is named, plus a Jira paragraph. The security page says deliveries are JWT-checked and names the platform webhook table.
- `src/lib/docs/nav.ts` and `src/lib/docs/content.ts`: the guide.
- Docs content and repo docs are listed under "Docs in the same PR".

## Permissions

- The five commands reuse `milestone.link_issue`, `unlink_issue`, `set_issue_criteria`, `accept_issue` and `check_issue`. They need `records.write` (owner and admin) and are on the console only; `SURFACE_COMMANDS` does not change.
- Connect, choose, Check linked issues now and Disconnect need `integrations.manage` (owner and admin).
- Approver, viewer and accountant are refused `forbidden` before any database or Jira request.
- The webhook route has no authentication but the JWT. The sweeper route keeps its `AGENT_API_TOKEN` bearer.

## Ledger actions

All are signed through the existing ledger, in domain `contractor` unless noted. Reads write best effort (`appendLedgerEntryBestEffort`); commands write with `appendLedgerEntry`.

| Action | Actor | Detail |
|---|---|---|
| `accounting_connected` (domain system, core) | human | provider `jira`, `externalOrgId` = cloudId, `externalOrgName` = site name, scopes, consent `{version: "jira-2026-11-09", at}`, `reconnected` |
| `jira_issue_linked` | human | `{by, milestoneId, linkId, issueId, identifier, projectKey, cloudId, issueUrl, completed, fingerprint}`. `fingerprint` is null until the issue is done |
| `jira_issue_unlinked` | human | `{by, milestoneId, linkId, issueId, identifier, withdrewAcceptance}` |
| `milestone_criteria_set` (shared) | human | `{by, milestoneId, criteria, criteriaSha256, previousSha256}` |
| `jira_issue_ready` | system | `{milestoneId, linkId, issueId, identifier, completedAt, statusName, resolutionName, fingerprint, deliverables}`, where `deliverables` is a count |
| `jira_work_accepted` | human | `{by, milestoneId, linkId, issueId, identifier, issueUrl, completedAt, statusName, resolutionName, fingerprint, deliverables: [{kind, label, href}], criteriaSha256, payeeJiraMapped}` |
| `jira_acceptance_withdrawn` | system | `{milestoneId, linkId, issueId, identifier, reason, afterPayment, acceptedFingerprint, fingerprint, completed, completedAt, statusCategory}` |
| `accounting_disconnected` (domain system, core) | human | `revokedAtProvider: false` |

- No detail carries an Atlassian accountId, name or email.
- Webhook upkeep is system housekeeping and is not in the ledger, as with Asana; its state is on the card. Reads from Check now are not in the ledger, as with Linear.
- `content/docs/changelog.mdx`, new top entry "## 2026-11-09: Contractor work accepted from Jira":
  - `verificationMethod` may be `jira`, with its `verificationDetail` (as in "Data", item 5), plus `heldReason` and `heldAt` once an acceptance is taken back;
  - the five new entries and their fields;
  - `milestone_criteria_set` is written for Jira-linked milestones too;
  - `accounting_connected` carries provider jira and its consent version;
  - SDK 0.4.3 accepts the value;
  - nothing else in `/api/v1` changes.

## Words

**`JIRA_STATEMENT`**
1. "Vestiarion reads Jira as the Atlassian user who connects, on the one Jira site you connect, and sees the issues that person can see there. It reads the site's name and address when you connect, and checks once a day that the connection still reaches the site."
2. "For each issue linked to a milestone it reads its key, title, project, status and resolution, and when it was done; once the issue is done, also its attachments' names, its web links, and the links in its description and its newest 50 comments. A deliverable that links to another issue on the site is checked at Jira to see that it opens. It keeps the links and names, not the words of the description or the comments, and keeps no Atlassian account ID, name or email."
3. "When a person accepts the work, it asks Jira which Atlassian account has the payee's email, and which is that person's own, only to refuse an acceptance by the payee. It sends Jira those email addresses for that, and keeps neither them nor the answer."
4. "It makes one webhook on the site for the projects of the linked issues, so a change there is read again within a minute, renews it before Jira lets it lapse, and deletes it when no linked issue is left open or Jira is disconnected. What a notice says is never used as it is: Vestiarion reads the issue again from Jira. It writes nothing else to Jira."
5. "An issue done in Jira is never by itself a reason to pay: a person here accepts the work against the milestone's criteria, and the agent then decides the payment under every guardrail. Nothing from Jira sets an amount or a payee."
6. "Vestiarion never uses Jira data to train or improve any AI model, and never passes it to anyone else without your workspace's say."
7. "Disconnecting stops the reading at once, and deletes the webhook and the tokens. Atlassian gives apps no way to end their own access, so remove Vestiarion from Connected apps in your Atlassian account settings to end it there too. Acceptances already recorded stay in Vestiarion's signed ledger."

**Connect page**
- Title: "What Vestiarion does with Jira's data".
- Lead: "Pay contractors for work delivered in Jira. You link a milestone to its Jira issue; when the issue is done, a person accepts the work against the milestone's criteria, and only then does the agent decide on pay, under every guardrail."
- "Atlassian asks you to allow access as yourself to one Jira site: Vestiarion sees the issues you can see there, and reads only the ones linked to milestones."
- The button "Continue to Jira". On the choose step, "Choose the Jira site to connect" and "Connect this site".

**Notices** (`JIRA_NOTICES`)
- connected: "Jira is connected. Link a milestone to its Jira issue on Contractors."
- cancelled: "Connecting Jira was cancelled. Nothing changed."
- forbidden: "Only an owner or admin connects Jira, from their own browser."
- other_organisation: "This workspace is connected to another Jira site. Disconnect it first, then connect the one you want."
- not_set_up: "Jira is not set up on this deployment yet."
- failed: "Jira did not finish connecting. Try again in a moment."
- no_site: "Your Atlassian account has no Jira site Vestiarion can read. Connect with the account you use Jira with, or ask the site's admin whether apps are allowed."

**Missing context** (`MISSING_WORDS`)
- off and not_set_up: "Jira is not set up on this deployment yet."
- not_connected: "Jira is not connected to this workspace. An owner or admin connects it in Settings."
- reconnect: "Jira needs to be reconnected. An owner or admin reconnects it in Settings."

**Refusals**
- bad_issue: "That is not a Jira issue. Paste the issue's link from Jira, or its key, such as ENG-123."
- other_site: "That issue is on another Jira site than the one connected (<host>). Link an issue of the connected site."
- issue_not_found: "Jira does not show <KEY> to the connected account. Check the key, or ask whoever connected Jira to open the project."
- github: "This milestone is verified by its GitHub pull request. Add a new milestone to accept work from Jira."
- asana: "This milestone is linked to an Asana task. Unlink the task first to accept the work from Jira."
- linear: "This milestone is linked to a Linear issue. Unlink the issue first to accept the work from Jira."
- milestone_linked: "This milestone is linked to a Jira issue already. Unlink it first."
- In Linear's command, jira: "This milestone is linked to a Jira issue. Unlink the issue first to accept the work from Linear."
- In Asana's command, linear: "This milestone is linked to a Linear issue. Unlink the issue first to accept the work from Asana."
- In Asana's command, jira: "This milestone is linked to a Jira issue. Unlink the issue first to accept the work from Asana."
- stale: "The deliverables changed in Jira since you opened this. Look at them again before accepting."
- payee_jira: "Your Atlassian account is this milestone's payee, so someone else accepts the work."
- Verify manually: "This milestone's work is accepted from its Jira issue. Accept it there against its criteria, or unlink the issue first."
- Revoke manually: "This milestone's work was accepted from its Jira issue. Unlink the issue to take the acceptance back."

**States and held lines**
- "Waiting for the issue" / "Not done in Jira yet. It is read again when it changes there. Deliverables are read once it is done."
- "Ready for acceptance" / "Done in Jira. Check the deliverables against the criteria, then accept the work: the agent decides on pay only after that."
- "Accepted", "Held for review", and "Changed after payment" / "The issue changed in Jira after the payment was sent. Review it with the contractor: Vestiarion does not take a payment back."
- canceled: "Jira resolved the issue as <resolution>, which is not done. Nothing is accepted from it: reopen it, or link another issue."
- issue_unreachable: "Jira no longer shows this issue to the connection: it was deleted or archived, the person who connected Jira lost access to its project, or another Jira site is connected now. Restore it, link another issue, or reconnect Jira."
- reopened, deliverable_changed, no_criteria and unlinked: Linear's lines, with "Jira".

**Issue card**
- Facts: "Done in Jira on <day> (<status>, resolved as <resolution>)." "Read from Jira <minute> UTC." "On <host>." "Jira has more than Vestiarion reads: the first 50 attachments, 50 web links and the newest 50 comments were checked."
- Controls: "Link the issue", "Add the criteria", "Deliverables in Jira" / "Deliverables accepted", the box "I checked each criterion against these deliverables, as shown here.", "Accept the work", "Check Jira now", "Unlink the issue".
- The root has `data-jira-state`; the SquareKanban icon; no `/brands/`.

**Panel**
- Status: the core's title ("Connected to <site name>") and "Site: <host>".
- `noticeLine` takes the first of these that applies:
  1. "Jira did not take Vestiarion's webhook: <error, cut to 200 characters>. Linked issues are read every 15 minutes."
  2. "Jira's notices are not reaching Vestiarion: the 15-minute check found a change Jira did not send. Linked issues are still read every 15 minutes."
  3. "Jira last told Vestiarion of a change <minute> UTC."
  4. "Jira has not told Vestiarion of a change yet. Linked issues are read every 15 minutes."

  It is null when there is no open link.
- Buttons: "Check linked issues now", "Disconnect Jira", "Connect Jira" / "Reconnect Jira".
- For other roles: "An owner or admin connects Jira." / "An owner or admin manages Jira."
- Not connected: "Pay contractors for work delivered in Jira. An issue marked done alone never pays: a person accepts the work against the milestone's criteria."

**Toasts and errors**
- Disconnect: "Jira is disconnected, and its webhook deleted. Acceptances already recorded stay in Vestiarion. To end Vestiarion's access at Atlassian too, remove it from Connected apps in your Atlassian account settings." When the webhook could not be deleted, the middle sentence becomes "Jira ends its webhook within 30 days."
- Site gone: "Jira no longer shows Vestiarion the <name> site: the site was removed, or the person who connected Jira lost access to it. Reconnect Jira."
- Read failure: "Jira did not answer just now. It is read again within 15 minutes."

## Read budget, against Atlassian's 65,000 points an hour (shared by all tenants)

Estimates use Atlassian's model: 1 point per request, plus 1 per core object, plus 2 per user object (for example, comment authors).

| Read | Requests | Points (estimate) |
|---|---|---|
| Status read | 1 | 2 to 3 |
| Full read (20 comments, 3 attachments, 2 web links) | 2 (3 when the comment page is truncated) | about 75 |
| Change check, 50 ids, `fields=updated` | 1 | about 51 |
| Daily upkeep | 2 to 4 | about 5 |

- **A quiet connection with 20 open links**, 3 of them accepted: the 4 change checks an hour cost about 84; the accepted floor, 3 full reads an hour, about 225; the daily floors of the other links are status reads, about 3. That is roughly 310 points an hour. 100 such connections use about 31,000, under half the pool.
- **A busy connection** is capped at 20 reads a sweep. Its open issues are status reads, and only done ones are read in full.
- Deliveries cost no points; their reads follow the same depths.
- The global pause (JR17) stops one sweep from draining the pool.
- L15 measures a real full read. If it costs far more, `COMMENTS_READ` or the accepted floor is lowered before sharing is turned on.

## Docs in the same PR (AGENTS.md; docs with every feature)

- The guide `content/docs/guides/jira.mdx`, mirroring Linear's sections, plus:
  - "If your Atlassian account has several Jira sites";
  - "Atlassian's own screens" (the not-yet-reviewed notice, and admins who block user apps);
  - "What Vestiarion keeps" (no account ids);
  - "Disconnecting" (Connected apps);
  - the five screenshots.
- `src/lib/docs/nav.ts` and `src/lib/docs/content.ts`.
- `content/docs/guides/integrations.mdx`, `pay-a-contractor.mdx`, `evidence.mdx` (Jira in the checked-links words), `accountants.mdx`, `content/docs/index.mdx` and `content/docs/get-started/sdk.mdx` (the 0.4.3 URL and its sentence).
- `content/docs/changelog.mdx` (an `/api/v1` change).
- `ARCHITECTURE.md`:
  - a new "## Contractor work accepted from Jira" section after Linear's, on the differences: the sites table, the upkeep, the JWT, the timestamp rule, depths and floors, no person data, and the cross-tool refusal now on Asana's link;
  - every list of work tools updated.
- `CHANGELOG.md` `[Unreleased]` Added; README (the integrations table and its mentions); `.env.example` (`JIRA_CLIENT_ID=`, `JIRA_CLIENT_SECRET=`, "Production only"); `docs/self-hosting.md` (a Jira section after Linear's).
- The privacy, terms and security pages, and subprocessors.
- `tests/docs-guides.test.ts` gets a phrase-to-source row for each quoted UI string. The repo is public, so no local path appears anywhere.

## Tests

### New suites

- **`tests/jira-acceptance.test.ts`** (pure)
  - `issueRefOf`, with every accepted form and every refusal.
  - `linksToIssue`.
  - `adfLinksIn`: link marks, all three card kinds, bare links, and the depth and node caps.
  - `deliverablesOf`: order, the self link dropped, 60 links keeping 50 with `more` 10, the byte cap, and `file:` and `remotelink:` ids.
  - The fingerprint does not change when a filename or a web-link title is renamed, and does change with a new attachment, a new URL or a new comment link.
  - `mapIssue`:
    - done with a null resolution, "Done" or "Fixed" counts as completed;
    - "Won't Do" (curly apostrophe too), "Duplicate" and "Cancelled" count as canceled;
    - new and indeterminate mean waiting.
  - The `completedAt` order, and `+0700` normalised to UTC.
  - `planRead` over each Jira reason; no read yields `archived`.
  - `selfAcceptance`; `stateWords` and `HELD_LINES`; `acceptanceKpis` counts only `jira_*` entries.
- **`tests/jira-api.test.ts`** (faked fetch)
  - Settings: both variables are needed and there is no third; the partial-config warning names the variable only.
  - `JIRA_SCOPES` equals `SCOPES_BY_CONSENT[CONSENT_VERSIONS.jira]`.
  - The authorize URL carries exactly its seven parameters and no secret.
  - The exchange body is JSON with five fields.
  - Refresh:
    - it rotates;
    - 403 `{"error":"invalid_grant"}` means reconnect, and so do 400 and 401 with `invalid_grant`;
    - 401 `invalid_client` and 400 `unauthorized_client` mean unavailable plus one deployment log line, with no secret in it;
    - 400 `invalid_request` means unavailable;
    - 503 with `Retry-After` 30 means unavailable for 30,000 ms.
  - Revoke makes zero requests.
  - `grantSites` filters and de-duplicates; zero sites throw `no_site`.
  - `jiraFetch`: hosts, `redirect: "error"`, and the global pause (zero requests while it lasts).
  - The exact issue URLs for both depths, with no trailing slash; the truncated-comments request.
  - A 404 is `gone not_found` and a 403 `gone forbidden`; an answer for another id throws; an injected key, id or cloudId is refused before any fetch.
  - `changed()`: the JQL, chunks of 50, missing ids, and 400 meaning `"refused"`.
  - `people()`: an equal email is kept, a hidden one is kept, a different one is dropped; nothing is asked without an email.
  - Session: a 401 refreshes once and retries.
- **`tests/jira-webhook.test.ts`**
  - `verifyJiraToken`:
    - HS256, HS384 and HS512 are accepted;
    - `none`, RS256 and no alg are refused;
    - a wrong secret, or a changed header or payload, is refused;
    - `exp` 301 s past is refused, 299 s past is accepted, and no `exp` is accepted;
    - a future `nbf` is refused;
    - malformed tokens are refused;
    - the source uses `timingSafeEqual`;
    - claim names are logged once and no token text is logged.
  - `deliveryOf`: the five events; other events, shapes, or more than 20 ids are ignored; both forms of `self`.
  - `handleJiraWebhook`:
    - a 401 comes before the body is read, proven with a stream that throws when read;
    - a 413 over 4,000,000 bytes;
    - a delivery 20 minutes old is still read;
    - the answer is exactly 200, and the reread runs only after `defer` flushes.
  - The source never reads `issue.fields`, `changelog` or `user`.
  - The route source contains `defer: (work) => after(work)` and `secret: settings.clientSecret`.
- **`tests/jira-sites.test.ts`** (fake fetch and fake platform database)
  - The registration body: events, the JQL `project in (10000, 10001)` sorted and de-duplicated, and the url.
  - No open link means no webhook, and an existing one is deleted.
  - A new project means register, then retire the old id (still routable for 2 hours, not after).
  - Expiring within 7 days tries `/webhook/refresh`; a 404 or 405 there tries `PUT /webhook`; both failing means rotation.
  - Our id missing from the list means register.
  - A registration error is written as `webhook_error` words, and the sweep goes on.
  - `cleanOrphans` keeps an id another workspace holds.
  - The daily keep-alive runs with zero links, and not again within 24 hours.
  - A first site miss only marks; a second miss 10 minutes later means reconnect; a renamed site updates `site_url`.
  - The scope guard refuses another workspace.
  - `sitesForWebhooks` matches current and retired ids.
- **`tests/jira-flow.test.ts`** (a fake PostgREST that applies 0149's checks)
  - The five commands are `records.write` and absent from telegram, slack, api and github. Approver, viewer and accountant cause zero requests.
  - Linking by URL and by lower-case key; the row's `cloud_id` and numeric `issue_id`; `jira_issue_linked` with a null fingerprint for a waiting issue.
  - Every refusal in JR6. Linear's link refuses a Jira-linked milestone; Asana's link refuses Linear- and Jira-linked ones.
  - A waiting issue makes one request a read; done means a status read, then a full one.
  - Done means ready, the milestone **not** verified, and one `jira_issue_ready`. No criteria means held; adding criteria makes it ready, leaves `last_read_at` as it was (a delivery sent just before is still read), and moves no link whose hold changed since it was seen.
  - Accepting verifies with method jira, writes the detail and `runCycleSoon`. A second accept and a stale accept are refused.
  - "Won't Do" is held canceled and never ready.
  - Withdrawn after acceptance: reopened, done again with a new `statuscategorychangedate`, a new remote link, and a 404.
  - Taken back for its deliverables, then deleted (404), hidden (403) or on a site no longer connected: held `issue_unreachable`, and Accept refused with the milestone left pending.
  - A moved issue refreshes its key and URL.
  - Another site connected: old links are held with zero requests, and an issue id that also exists on the new site is never read.
  - `held_after_payment`; deferred, then withdrawn at 11 minutes; unlink while deciding is refused; unlink, then link again.
  - Fan-out:
    - two workspaces holding overlapping ids both read;
    - a `self` naming another host is skipped;
    - an unknown id causes 0 reads;
    - a read started at or after the delivery's timestamp plus 5 s causes 0 reads;
    - a comment followed by Done 30 s later causes 2 reads.
  - Sweep:
    - one change check, then full reads only of changed or floored links;
    - a 400 falls back to oldest-first, within 20;
    - an issue deleted after its acceptance was taken back is held `issue_unreachable` by that run and left out of the next check, which answers again;
    - 120 paid links do not starve open ones;
    - `missed_change_at` is set only for a change older than 2 minutes with no delivery since.
  - The global pause finishes the run `rate_limited` with zero Jira requests.
  - A refresh `invalid_grant` means `needs_reconnect`, with the 90-day words.
  - Self-acceptance by email, by user search and by `/myself`; `approvesOwnJiraPayout`.
  - No request body or row anywhere carries `accountId`, `completed_by` or `assignee`.
  - The only milestone writes are `writeCriteria`'s.
- **`tests/jira-connect.test.ts`**
  - The registry, and `syncErrorWords("reconnect", "Jira")` exact; Linear's and Asana's words unchanged.
  - The statement's phrases.
  - `startConnect` answers a 303 to auth.atlassian.com with the `vx_jira_oauth` cookie.
  - `finishConnect`:
    - one site connects, with encrypted tokens, the ledger summary, and a `firstSync` that saves the site row;
    - two sites give a pending grant and `?choose=`, and POST choose connects;
    - zero sites give `?jira=no_site` and keep nothing.
  - Every Jira route answers 404 when Jira is off.
- **`tests/jira-migration.test.ts`** (PGlite)
  - Re-runnable after 0101, 0105, 0115, 0116, 0122, 0123, 0145, 0147, 0148 and 0149.
  - 11 providers, with `'sage'` rejected; 7 methods; one named method check.
  - A later `'sage'` widening is never narrowed by re-running 0149, 0148 or 0147.
  - The header text and the `notify`.
  - The functions and tables exist.
  - Unique live keys per milestone and per `(cloud_id, issue_id)`; the same issue id on another cloud is allowed.
  - Every named check, and no person columns.
  - RLS on links, with delete denied.
  - `jira_sites` has no grants for `anon`, `authenticated` or `vestiarion_tenant`, and holds its cardinality and URL checks; deleting the connection or the org cascades to it.
  - Accept and hold over Linear's cases with method jira. Hold leaves a milestone verified by Linear or by hand untouched.
- **`tests/jira-paying-path.test.ts`** (static scans)
  - No Jira import from the agent, circle, payments or payout code.
  - The three-member `Promise.all` strings, and `recheck.jira.complete`.
  - No `payment_intents` write and no `.from("milestones")` write under `src/lib/jira/`.
  - 0149 has exactly two milestone updates.
  - `approvesOwnJiraPayout` is in `commands/milestones.ts`.
- **`tests/jira-views.test.ts`**
  - Views for ready, canceled, accepted and unlinked, with no `@` in an unaccepted view.
  - `jiraPanelView`'s four `noticeLine` cases.
  - `jiraPanelFor` is null when Jira is off, filters the ledger actions, and turns PGRST202 into not_set_up.
- **`tests/jira-panel.test.tsx`**
  - The card's id and aria label, `lucide-square-kanban`, no `/brands/`, and the guide link; the `JIRA_NOTICES` keys exactly.
  - The `JiraIssueCard` forms.
  - The three-tool `workToolCards` table:
    - a Jira-linked milestone shows only Jira;
    - Linear and Jira both connected and neither linked show both, with the criteria asked once (by Linear);
    - Asana connected asks on its own card.
  - The connect page's choose, expired and not-set-up branches.
- **`tests/jira-shots.test.tsx`**: not found unless `DOCS_SCREENSHOTS` is set; the five states render.
- **`tests/jira-evidence-links.test.ts`**
  - A browse link on the connected host builds exactly the API request; other hosts and paths are not checked.
  - `requestAllowed` takes only that path shape.
  - The words for 404, 403, 429 and 5xx, and for "not connected".

### Changed suites

| File | Change |
|---|---|
| `tests/linear-migration.test.ts` | the sentinel `'jira'` becomes `'sage'` at lines 140, 161, 178 and 186 |
| `tests/linear-paying-path.test.ts` | the two `Promise.all` pins become the three-member strings |
| `tests/linear-panel.test.tsx` | the `workToolCards` expectations gain `jira: false, jiraCriteria: false` |
| `tests/linear-flow.test.ts`, `tests/asana-flow.test.ts` | the fake tables gain `jira_issue_links` (and `linear_issue_links` for Asana); the new cross-tool refusals |
| `tests/brand-marks.test.tsx` | `MARKED` excludes jira |
| `tests/connector-consent.test.tsx`, `tests/integration-connect-pages.test.tsx` | jira joins the tools whose statement names no model provider, the VERSION regex and the `describe.each`; a "Jira connect page" block |
| `tests/csp.test.ts` | the consent map gains `jira: [JIRA_AUTHORIZE, JIRA_LOGIN]` |
| `tests/disconnect-confirmation.test.tsx` | `JiraPanel` and `disconnectJiraAction` |
| `tests/cycle-events-actions.test.ts` | the Jira revoke refusal |
| `tests/support/pglite.ts`, `tests/rls.test.ts`, `tests/dal.test.ts`, `tests/account-deletion.test.ts`, `tests/delete-org-migration.test.ts` (its `PLATFORM_TABLES` list and seed), `tests/tenant-rpcs-migration.test.ts`, `tests/lifecycle-migration.test.ts` | the new table, platform table and functions |
| `tests/evidence-chain.test.ts`, `tests/accountant-all-waiting.test.ts` | the Jira branches |
| `tests/evidence-link-allow-list.test.ts`, `tests/evidence-link-check.test.ts` | the not-checked words name the Jira site |
| `tests/docs-guides.test.ts`, `tests/docs-content.test.ts`, `tests/docs-links.test.tsx` | the guide and its phrases |
| `tests/sdk-types.test.ts`, `tests/sdk-package.test.ts` | follow 0.4.3 |
| `tests/googledrive-migration.test.ts`, `tests/asana-paying-path.test.ts` | **no change**. The first asserts with `toContain` and re-runs only up to 0148; the second's pinned lines are untouched |

Before the PR: `npm run lint`, the type check, the full vitest run (PGlite suites included), `npm run build`, a docs-shots render of the five states, and a check of both cards in real frames with local headless Edge.

## Proven today, and proven only live

**Before the app exists:**
- **P1.** After the owner runs 0149, a read-only (select-only) probe of production checks:
  - both provider checks list 11 providers and the method check lists 7;
  - the two tables exist with RLS on and the grants above;
  - the three functions exist.
- **P2.** On vestiarion.xyz with `JIRA_*` unset:
  - `/integrations/jira/connect` says "Jira is not set up on this deployment yet.";
  - `POST /api/integrations/jira/webhook` answers 404;
  - Settings and Contractors show no Jira card, and the Asana and Linear cards are unchanged.
- **P3.** The guide renders with its five docs-shot screenshots.
- **P4.** The full test run and the build pass.

**After the owner's app exists.** For each assumption, the check, and how the code stays correct if the answer differs:

| # | Assumption | Live check | If it turns out different |
|---|---|---|---|
| L1 | JSON token endpoint; `expires_in`; refresh rotates | Connect; wait past expiry; Check Jira now | `expires_in` is read at run time; an answer without a refresh token keeps the old one |
| L2 | A dead grant answers 403 `invalid_grant` | Remove the app under Connected apps; Check Jira now | Another code is logged by name and treated as unavailable; a one-line follow-up adds it |
| L3 | `accessible-resources` shape; resource-restricted means one site | Connect an account with two sites | Several go through choose; none gives `no_site` |
| L4 | form-action reaches Atlassian's sign-in for a signed-out person | Connect from a private window, then read `/api/csp-report` | form-action is report-only, so nothing breaks; the observed host is added to `FORM_TARGETS` |
| L5 | `POST /webhook` takes `project in (<ids>)` and our events | Link an issue; the card shows no webhook error | The error is on the card and the sweeper reads every 15 minutes; `desiredJql` switches to quoted keys (one function, one test) |
| L6 | The delivery JWT's alg, claims, lifetime, and whether retries reuse an expired token | The claim-name log line, the exp-delta lines on 401s, and the retry headers | Every HMAC alg is accepted; a non-HMAC alg is logged and refused, and the sweeper covers until a follow-up pins it; the exp leeway is changed only after this |
| L7 | The form of `issue.self` | A count of skipped rows in the logs | Both forms are parsed; a `self` that does not parse is read anyway |
| L8 | Owner-only delivery for an app that is not shared | A second Atlassian account, before and after sharing is on | The card's notice line shows it; the sweeper covers |
| L9 | The renew path | A test row set to expire soon; the logs | refresh, then `PUT /webhook`, then rotation, reconciled through the list |
| L10 | `statuscategorychangedate` is present; Won't Do sits in Done; a reopen and redo moves the date | Resolve one issue as Won't Do; reopen and redo another | Falls back to `resolutiondate`, then null; the resolution is shown on the card |
| L11 | A deleted or archived issue answers 404 | Delete an accepted issue; archive one where the plan allows it | A 404 means `issue_unreachable`; an archived issue that answers 200 stays done (a recorded risk) |
| L12 | A moved issue keeps its id | Move an issue to another project | Read by id; key, URL and project refreshed |
| L13 | Classic scopes deliver issue and comment events | L5 and L8, with comment changes | Add `read:issue-details:jira` and a new consent version **before** sharing |
| L14 | User search by email, with hidden emails | Accept as a member whose Jira email is the payee's | A hidden email counts as a match; the email rule still applies |
| L15 | Points per full read | The rate-limit headers of one full read | Lower `COMMENTS_READ` or the accepted floor before sharing |
| L16 | Disconnect deletes the webhook | Disconnect, reconnect, and expect an orphan count of 0 | Jira ends it within 30 days; `cleanOrphans` removes it on reconnect |
| L17 | The size of the embedded comment page | An issue with 60 comments | The newest 50 are fetched when the page is truncated |
| L18 | Whether adding a web link moves `updated` | Add a web link to an accepted issue | The hourly floor catches it either way; the floor stays if it does not |

## Rollout

1. One PR, `feat/jira-acceptance`, with the code, 0149, the docs, the SDK 0.4.3 types and tarball, and the tests. The feature is off in production while `JIRA_*` is unset. The PR is merged after any open PR that touches the three checks.
2. The owner runs 0149. We run P1 and P2.
3. The owner creates the Atlassian app and sets `JIRA_*` for Production.
4. With the owner's own account and sharing off, run L1 to L7 and L9 to L18.
5. Turn sharing on, then run the second-account test (L8) and decide L13.
6. A follow-up PR pins whatever L4, L5, L6 or L13 showed.
7. After it is proven live: Jira and Linear go into the landing FAQ in words, and the release notes for beta.16 are written.
8. The owner publishes `@vestiarion/sdk` 0.4.3 from the committed tarball.

## Not in this change

- No issue picker: a person pastes a link or a key.
- No write to Jira except our own webhook. No comment, transition or field.
- No `archived` hold reason. An archived issue is whatever Jira answers (L11).
- No Atlassian logo, and no landing change.
- No reporting job for personal data, since no accountIds are stored.
- No webhook delivery table.
- No Jira on the API, Telegram, Slack or MCP surfaces. Linking and accepting happen in the console.

## Owner steps

1. Merge the PR when CI is green, after any open PR that redefines the provider or method checks.
2. Run migration 0149 with the usual migrate script, after previewing it with `-DryRun`. Tell us when it has run, so we run P1.
3. Create the Atlassian app at developer.atlassian.com, under Developer console, then Create, then OAuth 2.0 integration:
   - Name it "Vestiarion".
   - **Opt into resource-restricted tokens at creation.** Whether this can be changed later is not documented.
   - Permissions: add the Jira API, and configure the classic scopes `read:jira-work`, `read:jira-user` and `manage:jira-webhook`. `offline_access` is asked for by the app at sign-in.
   - Authorization: OAuth 2.0 (3LO), callback `https://www.vestiarion.xyz/api/integrations/jira/callback`.
   - Settings: copy the client ID and secret, and never paste them anywhere but Vercel.
   - Optional: add a second admin to the app, if the multi-user ownership the changelog describes is offered.
4. In Vercel, set `JIRA_CLIENT_ID` and `JIRA_CLIENT_SECRET` for **Production only**, then redeploy. If the secret is ever rotated in the console, update it in Vercel at once: until then, refreshes and deliveries fail, and connections are never marked to reconnect.
5. Create a free Jira Cloud test site with a project such as ENG and a few issues. Also have a second Atlassian account ready, invited to that site.
6. With your own account, and with us on the call, run the live checks: connect, link, Done, accept, reopen, Won't Do, delete, move, disconnect, and the signed-out connect from a private window.
7. Under Distribution, fill in the vendor name, the privacy policy (`https://www.vestiarion.xyz/privacy`) and the terms, declare that the app stores no personal data, and turn on **Enable sharing**.
8. Run the test with the second account (L8). Together, decide L13 before any customer connects.
9. Publish SDK 0.4.3 from the committed tarball.

## Implementation plan

One PR, built in these chunks. Each chunk names its files and tests and passes its own tests on top of the chunks it depends on. Chunks with no dependency between them can be built at the same time.

1. **Schema.** No dependencies.
   - Files: `supabase/migrations/0149_jira_acceptance.sql`; the `src/lib/dal/index.ts` registries and header.
   - Tests: `jira-migration`; the `linear-migration` sentinels; `support/pglite`, `rls`, `dal`, `account-deletion`, `delete-org-migration`, `tenant-rpcs-migration`, `lifecycle-migration`.
2. **Registry and connector core.** No dependencies.
   - Files: `src/lib/jira/settings.ts`; the constants block of `src/lib/jira/http.ts`; `connectors/provider.ts`, `consent.ts`, `connect-refusal.ts`, `status.ts`, `booking.ts` and `sweep.ts` (comment); `commands/accounting.ts`; `usage/model.ts`; `security/csp.ts`; `subprocessors.ts`.
   - Tests: the registry and words part of `jira-connect`; `connector-consent`; `csp`; `brand-marks`; the scopes-to-consent pin.
3. **Jira client.** Depends on 2.
   - Files: the rest of `http.ts`; `oauth.ts`, `map.ts`, `urls.ts`, `deliverables.ts`, `api.ts`, `session.ts` and `provider.ts`; `webhook.ts` (token check, `deliveryOf`, handler with injected dependencies); the REST part of `webhooks.ts` (`JiraWebhookApi`).
   - Tests: `jira-api`; `jira-webhook`; the pure parts of `jira-acceptance`.
4. **State, storage and reads.** Depends on 1 (for shapes), 2 and 3.
   - Files: `acceptance.ts` (plus Linear's optional `acceptanceKpis` parameter); `links.ts`, `sites.ts`, `reads.ts`, `identities.ts` and `workspace.ts`; the upkeep in `webhooks.ts`.
   - Tests: `jira-sites`; the reads, sweep, fan-out and invalidation parts of `jira-flow`; the rest of `jira-acceptance`; `linear-acceptance` (unchanged by default).
5. **Commands, actions and cross-tool refusals.** Depends on 4.
   - Files: `commands/jira.ts`, `index.ts`, `policy.ts` (comment), `linear.ts`, `asana.ts` and `milestones.ts`; `app/actions/jira.ts` and `milestones.ts`.
   - Tests: the commands part of `jira-flow`; `linear-flow`; `asana-flow`; `cycle-events-actions`.
6. **Connect, routes, sweeper and cycle wiring.** Depends on 4; buildable alongside 5.
   - Files: `jira/connect-deps.ts`; the four routes; `platform/accounting-sync/route.ts`; `milestone-verification.ts`; `agent/orchestrator.ts`.
   - Tests: the flows part of `jira-connect`; `jira-paying-path`; `linear-paying-path`.
7. **Screens.** Depends on 4 and 5.
   - Files: `views.ts`, `panel.ts` and `contractors.ts`; `JiraPanel.tsx` and `JiraIssueCard.tsx`; `work-tool-cards.ts`; the Contractors and Settings pages; the integrations pages, with choose; `vx/map.ts`; the docs-shots and their fixture.
   - Tests: `jira-views`, `jira-panel`, `jira-shots`, `linear-panel`, `integration-connect-pages`, `disconnect-confirmation`.
8. **Evidence, accountant, close pack, API and SDK.** Depends on 1, 2 and the not-set-up helpers in `links.ts` (4).
   - Files: `evidence-chain.ts`; `close-pack/build.ts`; `accountant/read.ts` and `triage.ts`; `api/schemas.ts` and `api/milestones.ts`; the regenerated `sdk/src/types.ts`; `sdk/package.json` and the tarball.
   - Tests: `evidence-chain`, `accountant-all-waiting`, `sdk-types`, `sdk-package`.
9. **Evidence-link checks (JR20).** Depends on 3 and 4.
   - Files: `evidence-links/allow-list.ts` and `check.ts`; `jiraLinkCheck` in `workspace.ts`.
   - Tests: `jira-evidence-links`, `evidence-link-allow-list`, `evidence-link-check`. The not-checked words in `evidence.mdx` change in chunk 10.
10. **Docs and policy pages.** Depends on the words from 2, 7 and 9. They land in the same PR.
    - Files: the guide, nav and content registry; `integrations`, `pay-a-contractor`, `evidence`, `accountants`, `index` and `sdk.mdx`; `changelog.mdx`; `ARCHITECTURE.md`, `CHANGELOG.md`, the README, `.env.example` and `self-hosting.md`; the privacy, terms and security pages; this spec.
    - Tests: `docs-guides`, `docs-content`, `docs-links`, and the policy page tests.