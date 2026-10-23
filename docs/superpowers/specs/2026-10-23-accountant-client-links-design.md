# An accountant's client invite link (2026-10-23)

## Why

An outside accountant is the channel to many small businesses at once. Today an accountant can only be invited into a
workspace the client already made. A client invite link turns it around: the accountant sends one link, and the client
opens their own workspace in shadow mode, with the accountant already in it as accountant.

## Rules

**AC1. Who creates links.** Any signed-in person who is an accountant in at least one workspace creates links from the
accountant console (`/accountant`), under "Invite a client".
- **The link.** It is one-time and expires in 7 days. An optional client email binds it to that address only.
- **Limits.** At most 10 open links per accountant, and at most 20 created a day.
- **Showing it.** The link is shown once, with a copy button, and only its SHA-256 is kept. The token prefix is
  `vxj_`.
- **The list.** The console lists the accountant's links, each open, used (with the workspace's name), expired or
  revoked, with **Revoke** for an open one.
- **Signing.** `client_link_created` and `client_link_revoked` are signed nowhere, since no workspace exists yet. They
  live in the link table, with the actor and the times.

**AC2. The client's page**, `/join/[token]`, which requires sign-in, as invitations do.
- **What it shows.** "<accountant email> invites you to keep your books in Vestiarion. They will be your workspace's
  accountant:", then the accountant's role summary (`ROLE_SUMMARIES.accountant`), a workspace name field, and an explicit
  consent line.
- **Bound links.** A link bound to another email says so and offers nothing.
- **Dead links.** An expired, used or revoked link shows one sentence and names nothing.

**AC3. Creating the workspace.** A server action outside `src/app/actions`, `src/app/join/actions.ts`, added to the
explicit list in `tests/access-gates.test.ts`:
- checks the session;
- creates the workspace through the existing `createWorkspace`, forcing `arc-testnet` and shadow mode on. It does not
  rely on the mainnet allowlist, which is `*` in production;
- then claims the link with a definer function, `claim_client_link(p_token_hash, p_user_id, p_org_id)`. It checks that
  the link is open, unexpired and bound (if bound) to the user's email, that the caller owns `p_org_id`, and that the
  accountant is not the client. It then adds the accountant as a member with the role `accountant` and marks the link
  used, in one transaction;
- signs, in the new workspace, `org_created` with `via: "accountant_link"`, and `member_joined` for the accountant with
  `{ role: "accountant", clientLinkId, grantedBy }`. Nothing is written into the accountant's other workspaces.
- **If the claim fails after the workspace exists**, the client keeps the workspace, and the console says "Your accountant
  was not added. Invite them on Members." The link stays open.

There is no second copy of `create_org`.

**AC4. Going live keeps the accountant.** When the client takes the workspace live, the live slice (`src/lib/live-slice.ts`)
creates the Arc mainnet workspace with only the owner. Now the go-live step offers "Bring your accountant <email>
along", on by default, for each accountant member of the testnet workspace. When it is on:
- the accountant becomes a member of the new workspace with the role `accountant`;
- this is signed there as `member_joined { role: "accountant", via: "live_slice", grantedBy }`.

The owner can turn it off for any of them.

**AC5. Attribution.**
- The new workspace's `org_attribution` gets `utm_campaign: "accountant_client"`, with no view redefined.
- `/admin/growth` counts workspaces from accountant links with a tile, read through the existing growth read.

**AC6. The accountant's view.** The new workspace appears in their console at once, with its first-steps checklist. The
accountant's getting-started checklist gains an optional step, "Invite a client", done once one of their links is used.

**AC7. Docs and lists.**
- The accountants guide: "Invite a client".
- The privacy page: what a link holds, including an optional email.
- CHANGELOG and ARCHITECTURE. The API changelog only if a ledger detail an integrator reads changes (`org_created.via`,
  and `member_joined` with `clientLinkId` or `via`).
- Lists to update:
  - `src/lib/dal/index.ts` PLATFORM_TABLES and PLATFORM_RPCS;
  - `src/app/analytics/redact.ts`, for `/join/[token]`;
  - robots noindex;
  - `tests/access-gates.test.ts`;
  - `tests/delete-org-migration.test.ts`, if the table carries an `org_id`.

## Migration 0143

- **The table.** A platform table `public.accountant_client_links`, with RLS on and no tenant access. Its columns:
  - `id`;
  - `created_by`, cascading on delete;
  - `email` (nullable, lowercased, at most 254 characters);
  - `token_hash`, unique, matching `^[0-9a-f]{64}$`;
  - `expires_at`, `used_at`, `revoked_at`;
  - `org_id`, set null on delete;
  - `created_at`.
- **The functions.** Definer functions: `client_link_preview(p_token_hash)` and
  `claim_client_link(p_token_hash, p_user_id, p_org_id)`, with execute for the service role only.
- **Idempotent.** No view or existing function is redefined.

## Tests

- The migration (PGlite): checks, the claim's every refusal, and that the claim adds the role `accountant` only.
- Creating links: who may, the limits, and that only the hash is kept.
- The join page's states.
- The action: arc-testnet and shadow mode are forced, and the claim failing after creation is handled.
- The live slice bringing the accountant along, on and off.
- The console list and Revoke.
- The access gates and the analytics redaction.
