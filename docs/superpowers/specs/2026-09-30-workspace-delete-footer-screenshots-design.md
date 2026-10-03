# Deleting a workspace, a full footer with Terms and Privacy, and screenshots in the guides

Three requests from the partner on 2026-09-30:
- an owner cannot delete a workspace they created;
- the footer lacks documentation, support, legal and GitHub links;
- the user guides need a picture for each step.

Decided on 2026-09-30 by the implementer under the partner's standing instruction. Each decision states its reason. The partner chose GitHub Issues for Support and Contact.

## 1. Deleting a workspace

- **W1. Owner only (`org.administer`).** It lives in a "Delete workspace" danger zone at the bottom of Settings. Deleting removes every member's access and every record, so it is an owner's call. Admins manage keys and members, not the workspace's existence.
- **W2. Confirmation by typing the workspace's slug.** A `ConfirmDialog` states what is deleted:
  - invoices, counterparties, milestones, treasury records, the ledger, API keys, webhooks, members and invitations;
  - "Its wallets stay in the Circle account that holds them, with any USDC in them; Vestiarion can no longer reach them" (shown when wallets exist). For a hosted workspace, "the Circle account that holds them" is Vestiarion's testnet account, and the dialog says so.

  The delete button enables only when the typed slug matches exactly.
- **W3. Refusals.**
  - The founding workspace can never be deleted (`FOUNDING_ORG_ID`), whatever the role: "The founding workspace cannot be deleted."
  - A live workspace must have its agent paused first: "Pause the agent first, so no cycle runs while the workspace is deleted." That way a scheduled or manual cycle can't race the deletion. The function also refuses while a cycle run is in progress.
- **W4. A tombstone keeps the chain's head.** Before deleting, the function writes a row to a new service-role-only table `deleted_orgs (org_id, slug, name, deleted_by, deleted_at, ledger_entries, ledger_head_hash, ledger_signing_key_id)`. A deleted workspace's ledger is gone, but the platform keeps proof of how long it was and what its head was. The row holds no business data.
- **W5. One atomic function.** `delete_org(p_org_id uuid, p_by uuid)` is a definer function with `search_path = ''`, service role only. It runs these steps in one transaction:
  1. take the org row with `for update`;
  2. apply the refusals (founding, live-and-not-paused, cycle running);
  3. write the tombstone;
  4. delete in the same child-before-parent order as `delete_sandbox_org`, with `vestiarion.purging_org` set;
  5. delete the org row, which cascades to memberships, invitations, api_keys and webhooks.

  Webhook endpoints and deliveries cascade with the organization, as the webhooks spec proved.
- **W6. After deleting,** the action redirects the owner to `/onboarding`, which lists their other workspaces. No ledger entry is written: the ledger is deleted, and the tombstone is the record.

## 2. Footer, Terms, Privacy

- **F1. The full `SiteFooter` has these columns:**
  - **Product:** the landing sections, and Sign in.
  - **Developers:** Documentation (`/docs`), API reference (`/docs/api`), MCP server (`/docs/ai-integration/mcp`), Changelog (`/docs/changelog`), GitHub.
  - **Resources:** Go live guide (`/docs/guides/go-live`), First payment guide (`/docs/guides/first-payment`), Support (GitHub Issues).
  - **Legal:** Terms (`/terms`), Privacy (`/privacy`), Contact (GitHub Issues).

  The bottom row holds © and the MIT License, plus a GitHub icon link. External links open in a new tab with `rel="noopener noreferrer"`. The compact footer gains Docs, Terms, Privacy and GitHub.
- **F2. `/terms` and `/privacy` are static public pages** in the product's layout, each with a "Last updated" date. They describe what the service actually does, taken from the code:
  - email sign-in (Supabase Auth);
  - workspace data stored in Supabase;
  - Circle credentials, webhook secrets and ledger keys encrypted under the platform master key; API keys stored only as hashes;
  - privacy-respecting analytics (GA4 with the redaction in `src/lib/analytics/redact.ts`);
  - transactional email through Resend;
  - hosting on Vercel;
  - Arc testnet only;
  - retention: inactive sandboxes are deleted automatically unless connected; webhook deliveries are kept 30 days;
  - how to delete your account and your workspace.

  Nothing is claimed that the code does not do. The PR asks the partner to review them.
- **F3. Links** use the repo URL `https://github.com/duongnq2798/vestiarion` and Issues `…/issues`. Both live in one constant, so they change in one place.

## 3. Screenshots in the guides

- **S1. The screenshots are the app's real components, rendered with sample data**, not photographs of a signed-in session. That makes them reproducible, keeps secrets and real addresses out, and lets them be regenerated when the UI changes.
  - A route `src/app/docs-shots/[shot]/page.tsx` renders one state per shot: the Go live steps, the confirmation dialog, the counterparty and invoice forms, a decision card with its reasoning, an approval card, and the audit ledger with Verify.
  - The route answers only when `DOCS_SCREENSHOTS=1` is set, and is `notFound()` otherwise, so it never serves in production.
- **S2. `scripts/docs-screenshots.mjs`** builds and serves with the flag, drives headless Edge over CDP at a fixed width, and writes `public/docs/guides/<shot>.png`. It runs by hand after a UI change, and its README note says when.
- **S3. An MDX `Screenshot` component** takes `src`, `alt` and `caption`. It renders a bordered, responsive image with the caption, is registered in `mdx-components.tsx`, and converts to a Markdown image in the `.md` views.
- **S4. Tests:** every `<Screenshot>` in the guides points to an existing PNG and has non-empty alt text, and every PNG in `public/docs/guides/` is referenced.

## 4. Testing

- **Deleting:**
  - PGlite: the refusals, the tombstone contents, a full cascade including webhooks and API keys, grants, and replay;
  - library and action tests: the permission literal, the slug confirmation, the redirect, and the messages;
  - panel tests: the danger zone for owners only, and hidden for the founding workspace.
- **Footer:** the links and their targets, external `rel`, and pages that render with their headings. The link checker covers the internal links.
- **Screenshots:** S4. A headless-Edge pass of a guide page at 360, 520 and 1440 px checks the images scale with no horizontal scroll.

## 5. Rollout

- Apply `0031` before the merge.
- After the merge, the partner deletes a test workspace (`test-test` or `test-test2`) from Settings. I check that the tombstone row exists and the org is gone.

## 6. Deleting an account (added 2026-09-30 at the partner's request)

Until now the privacy page asked people to open a GitHub issue to have their account deleted. The partner asked for a button instead.

- **A1. Where it lives.** "Delete account" sits in the signed-in user's own menu, beside Sign out. It opens a dialog. Deleting an account is the person's own decision, so it needs no workspace role.
- **A2. Workspaces the person solely owns.**
  - **Blocked:** the person is the last owner of a workspace that has other members. The dialog names each one and says to make someone else an owner, or to delete the workspace, first. Teammates must never lose a workspace because its owner left.
  - **Deleted with the account:** workspaces where the person is the only member. Each goes through `delete_org` (same refusals: pause first when live, no payment or cycle in flight), so each leaves its tombstone.
  - **The founding workspace:** if the person is its last owner, the account cannot be deleted.
- **A3. Confirmation.** The person types `delete my account`. Then, in order:
  1. every sole-member workspace is deleted, and the account is not deleted if any of these fails;
  2. the Supabase auth user is deleted with the service role (`auth.admin.deleteUser`);
  3. the person is signed out and sent to `/`.

  Migration 0023's foreign keys take care of the rest: memberships and sent invitations go, and `created_by` becomes null on records in workspaces that survive. Since migration 0069, the person's API keys in those workspaces are revoked too, each with an `api_key_revoked` entry (`2026-10-03-member-api-keys-design.md` R2, R6).
- **A4. No new table.** The auth user row is Supabase's. The tombstones of the deleted workspaces are the platform's only record. The privacy page describes the button, and no longer asks for an issue.
- **Testing:**
  - each A2 case;
  - deleting several sole workspaces, and stopping on the first refusal;
  - the auth deletion through a fake admin client;
  - sign-out and redirect;
  - the dialog is always available to the signed-in user, and lists what will happen.
