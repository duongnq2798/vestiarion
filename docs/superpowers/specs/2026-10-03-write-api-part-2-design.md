# Write API, part 2: add milestones and payee links from your own system

Date: 2026-10-03. Status: designed on `feat/write-api-2`. Decided under the standing autonomy grant. Builds on
`2026-10-03-write-api-design.md` (part 1, PR #171: counterparties and invoices) and the TypeScript SDK
(`2026-10-03-typescript-sdk-design.md`, PR #176).

## 1. Why

Part 1 lets a system add a vendor and bill it. Paying a contractor still needs the console in two places:

- the work to be paid for, a milestone;
- the payee's own address, asked for with a one-time payee link.

The first is the flow developer teams ask about most: paying a contributor when their pull request merges. Vestiarion
already verifies a GitHub pull request link on a milestone, and pays once it is merged, so a CI job only needs to add the
milestone. The second lets a platform that onboards freelancers send each one the link where they add their address,
without a person copying it out of the console.

## 2. Approaches considered

- **A. `POST` beside the existing resources (chosen).** `POST /api/v1/milestones` beside its `GET`, and a new
  `POST /api/v1/payee-links`, both described by the operation list, so the OpenAPI document, the reference pages, the
  samples, the MCP tools and the SDK all follow, as in part 1.
- **B. One "pay a freelancer" operation** that composes contractor, verified milestone, link and email, as the console's
  Pay a freelancer dialog does. It is one call, but it verifies the work as it adds it, which the API must not do (W2),
  and an integrator who already has the contractor cannot use it.
- **C. `POST /api/v1/counterparties/{id}/payee-link`.** It nests the link under its payee, but it is the only write
  without a JSON body, so it cannot share the body checks or the generated tool arguments.

## 3. Rulings

- **W1. Two more write operations.** Both need a read-and-write key. There are still no updates or deletes.
  - `POST /api/v1/milestones` takes `{ contractorId, title, amount, verificationSource? }`. The response is
    `201 { data }`, shaped as `GET /api/v1/milestones` returns a milestone.
  - `POST /api/v1/payee-links` takes `{ counterpartyId }`. The response is
    `201 { data: { id, counterpartyId, url, expiresAt } }`.
- **W2. A milestone is added exactly as the console adds one.**
  - The body is checked by the rules of the console's Add milestone form:
    - `title`: 3 to 160 characters;
    - `amount`: positive USDC with at most 6 decimal places, as a decimal string or a number;
    - `verificationSource`: an https link of at most 500 characters.

    The form's schema moves to `src/lib/intake-validation.ts` so both use one copy.
  - The milestone starts `pending` and unverified. The API cannot verify it: whether work was delivered is decided by
    GitHub or by a person (part 1, R3: the API never approves).
  - A GitHub pull request link is kept in its canonical form. The agent's GitHub check verifies the milestone once the
    pull request is merged. When the deployment has a GitHub token, a cycle starts within seconds to run that check.
  - Any other link is evidence for the person who verifies the milestone on Contractors.
  - Once the milestone is verified, the agent decides the payment with every guardrail: the contractor's risk, its
    payment limit, a confirmed address, the workspace's spending limit and the contract on Arc.
  - A `contractorId` the workspace does not hold answers `400 invalid_request`. So does a client: a client is not paid
    for milestones. Both are found after the write has started, so they are remembered for an `Idempotency-Key`, as an
    unknown `counterpartyId` is for invoices.
  - It is recorded as `create_milestone` with `via: "api"` and `apiKeyId`.
  - **A milestone carries who added it.**
    - The milestone's `created_by` is the person who added it: the key's issuer for the API.
    - So the self-approval rule applies to it as it does to an invoice: the person who added a held milestone cannot
      pay it with Pay now, unless they are the workspace's only approver.
    - Neither the console's Add milestone nor Pay a freelancer ever set `created_by`, so that rule never applied to a
      milestone: on 2026-10-03, 15 of 15 milestones in production had none.
    - Both now set it. Milestones that already exist keep `null`.
- **W3. A payee link's address is shown once, and only its hash is stored.**
  - A link is made for a vendor or a contractor of the workspace. A client, or a `counterpartyId` the workspace does not
    hold, answers `400 invalid_request`. The link works once and expires after 7 days. Making one revokes the
    counterparty's unused link. These are payee links R2, unchanged.
  - The address the payee enters waits for a member's confirmation before the agent pays to it (payee links R1), so a
    key still cannot point the agent's payments at a new address.
  - It is recorded as `payee_link_created` with `via: "api"` and `apiKeyId`. The entry never holds the link.
  - **No outcome is kept for an `Idempotency-Key`.**
    - Keeping one would store the link's secret in `api_idempotency`, against R2's "only the hash is stored".
    - The operation does not list the header, and ignores it when sent; the SDK sends one on every write.
    - A repeat therefore makes a new link, and the earlier unused one stops working. A client that lost an answer
      gets a working link by asking again.
  - The answer carries `Cache-Control: no-store`.
  - The MCP tool is annotated `destructiveHint: true`, because it revokes the unused link.
- **W4. Both are commands.**
  - `milestone.add` (`addMilestone`) and `payee_link.create` (`issuePayeeLink`) go in `src/lib/commands`. Both need
    `records.write`, as their console actions do.
  - The console's Add milestone form and its Create link control move onto these commands. What they show does not
    change.
  - `SURFACE_COMMANDS.api` gains both. Telegram and Slack do not.
- **W5. A write key acts for its issuer as they are now.**
  - Every write reads the issuer's membership again (`memberActor`).
  - An issuer who is no longer a member, or whose role can no longer add records, gets `403 forbidden`, and nothing is
    written. Only owners and admins hold `records.write`.
  - This covers all four write operations. It closes a gap left by part 1 and migration 0069: 0069 revokes a key when
    its issuer leaves, but an admin moved to approver or viewer kept a key that still added invoices.
  - Reads are unchanged: an approver or a viewer may read the workspace, so the key still reads.
  - The order is key, then scope, then the write limit, then the issuer. A failure reading the membership answers the
    API's own `500`, before anything is written.
  - `POST /api/v1/invoices` takes the workspace's mode from that read, instead of reading it again.
- **W6. Everything else is as in part 1.**
  - Milestones take an `Idempotency-Key` (part 1, R5).
  - Both operations count toward the 30 writes a minute per key (R6).
  - Their errors are `invalid_request`, `unauthorized`, `forbidden`, `rate_limited` and `internal`. Milestones can
    also answer `conflict`.
- **W7. The documented surface follows the operation list.**
  - New operations: `create-milestone` (tag Milestones) and `create-payee-link` (tag Counterparties). Their reference
    pages and samples follow from them, and like every write their pages have no Try it panel.
  - MCP tools: `create_milestone` and `create_payee_link`. A write tool's note mentions `idempotencyKey` only when the
    operation takes one.
  - A new guide, `guides/api-milestones`, "Pay for merged pull requests":
    1. a contractor without an address, added through the API;
    2. a payee link, added through the API;
    3. the payee adds their address, and a member confirms it;
    4. a milestone whose evidence is a pull request, added through the API;
    5. once the pull request is merged, the agent verifies the milestone and pays it.
  - The changelog, Authentication (what a read-and-write key adds), the API overview, the MCP page, the SDK page,
    `README.md` and `ARCHITECTURE.md` are updated.
- **W8. SDK 0.2.0.**
  - New methods: `milestones.create(input, options?)` and `payeeLinks.create(input)`. The types are regenerated from
    the OpenAPI document.
  - The 0.2.0 tarball is committed beside 0.1.0, which stays as it was, and the docs name 0.2.0.
  - After the merge, the partner publishes 0.2.0 to npm, as with 0.1.0.
- **W9. Webhooks are unchanged.** The new entries arrive as `ledger.appended`, with `via: "api"` in their detail.

No migration.

## 4. Testing

- **Guard (W5).**
  - A write is refused with 403 when the issuer is now an approver or a viewer, or is no longer a member, and nothing is
    written.
  - A failure reading the membership answers 500.
  - The same key still reads.
  - An owner or admin issuer writes as before.
- **Commands (W4).**
  - `milestone.add` and `payee_link.create`:
    - refuse an approver;
    - refuse the Telegram and Slack surfaces;
    - accept the API surface;
    - refuse a client, and a counterparty not found.
  - Each ledger entry carries `via: "api"` and `apiKeyId` for the API, and no `via` for the console.
  - The console actions' existing tests pass unchanged.
- **Routes (W1–W3, W6).**
  - Milestones:
    - `201` with the list's shape;
    - `400` naming the field;
    - `400` for an unknown or client contractor;
    - a GitHub link kept canonical, with a cycle started;
    - a replay with the same `Idempotency-Key`.
  - Payee links:
    - `201` with a `url` under `/payee/vxp_`;
    - `Cache-Control: no-store`;
    - nothing written to `api_idempotency`, even when the header is sent;
    - a repeat makes a second link;
    - `400` for a client, and for an unknown counterparty.
- **OpenAPI, docs, MCP, SDK.**
  - The existing one-to-one tests cover operations against routes, tools and SDK methods.
  - The examples parse against their schemas.
  - The SDK contract test runs both new methods against the routes, in process.
  - The 0.2.0 tarball matches a fresh build.

## 5. Rollout

1. Merge. There is no migration.
2. In testnet-2, with a read-and-write key:
   1. `POST /api/v1/counterparties` adds a contractor with no address.
   2. `POST /api/v1/payee-links` for it. Open the `url`, add an address, and confirm it on Counterparties.
   3. `POST /api/v1/milestones` for it: 0.10 USDC, with a merged pull request of this repository as
      `verificationSource`.
   4. The agent verifies the milestone and pays it: `verify_milestone_github`, then a payment with a transaction.
3. The partner publishes `@vestiarion/sdk` 0.2.0 to npm.
4. Record the entries and the transaction here.
