# GitHub App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace connects a GitHub App installation from Settings, and a milestone paid for a pull request in a connected repository gets a comment on that pull request; installation tokens also let the GitHub check read private repositories.

**Architecture:**
- `src/lib/github/` holds four modules:
  - the app's settings and its GitHub calls: JWT, installation tokens, user installations, comments;
  - a signed install state;
  - the connect flow;
  - the installations store.
- Two routes take a person to GitHub and back, as Slack's do.
- The cycle's `notices` stage posts the comments.
- `refreshGitHubMilestones` asks for an installation token per repository before falling back to the deployment's.

**Tech Stack:** Next.js 16 route handlers, `node:crypto` (RS256 JWT, HKDF/HMAC state), Supabase (`platformDb`, `db`), PGlite migration tests, vitest with `fakeSupabase` and an injected `fetch`.

**Spec:** `docs/superpowers/specs/2026-10-04-github-app-design.md`

## Global Constraints

- **Off by default.** The feature is off unless all five `GITHUB_APP_*` variables are set, and when off nothing changes (G9).
- **Secrets.** Never log or store the private key, an installation token or the user token (G7).
- **Where it comments.** Only on repositories in an installation the workspace connected (G4).
- **Migration** `0071_github.sql`: re-runnable; `github_installations` is service role only.
- **Copy** says "Arc testnet" plainly. Commit messages stay neutral.
- **Checks.** `npm run verify` is green; `npx tsc --noEmit` is checked by its exit code.

## Review Focus

- **An `installation_id` the person cannot reach.** A forged callback must save nothing: `not_yours`.
- **A milestone whose pull request is in a repository the workspace did not connect.** No comment, even when another
  workspace connected that repository.
- **The same payment in two runs.** One comment, through the claim.
- **A failed post.** The claim is released, and nothing is recorded as commented.
- **A sandbox payment, or one confirmed before the connection.** No comment.

---

### Task 1: Settings and the GitHub calls

**Files:**
- Create `src/lib/github/settings.ts`: `githubAppSettingsFromEnv(env)`, `githubCallbackUri(origin)`.
- Create `src/lib/github/app.ts`, each call taking `fetchImpl`:
  - `appJwt(settings, nowMs)`;
  - `installationToken(settings, installationId)`;
  - `repositoryInstallationId(settings, owner, repo)`;
  - `exchangeUserCode(settings, code, redirectUri)`;
  - `userInstallations(userToken)`;
  - `createPullRequestComment(token, ref, body)`.
- Test: `tests/github-app.test.ts`.

Steps:
- [ ] Write the failing tests:
  - settings: each of the five variables missing; a non-numeric id; a PEM with literal `\n`;
  - the JWT's header and claims, and its signature verified with the public key;
  - each call's URL, method, headers and parsed answer;
  - 404 means no installation;
  - a non-2xx answer throws, with the status and without the token.
- [ ] Watch them fail, implement, watch them pass, and commit.

### Task 2: Migration 0071 and the installations store

**Files:**
- Create `supabase/migrations/0071_github.sql`.
- Create `src/lib/github/installs.ts`:
  - `saveInstallation({ orgId, connectedBy, installation })`, upsert plus `github_connected`;
  - `githubInstallations(orgId)`;
  - `removeInstallation({ orgId, actorId, installationId })`, which returns a boolean and records `github_disconnected`.
- Tests: `tests/github-migration.test.ts` (PGlite) and `tests/github-installs.test.ts`.

Steps:
- [ ] Failing tests:
  - the table's columns and checks;
  - unique on (`org_id`, `installation_id`);
  - closed to `anon`, `authenticated` and the tenant;
  - cascades with the org;
  - re-runnable;
  - `payment_intents` gains both columns.
  - The store: an upsert keeps one row; the ledger entries carry `by`, `installationId` and `account`.
- [ ] Implement, pass, commit.

### Task 3: Connect flow and routes

**Files:**
- Create `src/lib/github/state.ts`, with the HKDF purpose `github-install-state` and a 10-minute expiry.
- Create `src/lib/github/connect.ts`, with `startConnect` and `finishConnect`.
- Create the routes `src/app/api/github/install/route.ts` and `src/app/api/github/callback/route.ts`.
- Test: `tests/github-connect.test.ts`.

Steps:
- [ ] Failing tests for every outcome in spec §4 under "Install" and "Callback".
- [ ] Implement, pass, commit.

### Task 4: Settings card and Disconnect

**Files:**
- Create `src/lib/github/panel.ts`, the view.
- Create `src/components/GitHubPanel.tsx`.
- Create `src/app/actions/github.ts`, with `disconnectGitHubAction`.
- Modify the Settings page to load the view, and show the card only when the app is configured. The `?github=` outcome
  becomes a notice.
- Tests: `tests/github-panel.test.tsx` and `tests/github-actions.test.ts`.

Steps:
- [ ] Failing tests:
  - the card lists the connected accounts;
  - Connect is a link to the install route, shown only to someone who can manage integrations;
  - Disconnect needs `integrations.manage`;
  - each outcome's words.
- [ ] Implement, pass, commit.

### Task 5: Comments on paid pull requests

**Files:**
- Create `src/lib/github/payment-comments.ts`: `sendPullRequestComments({ fetchImpl, now })` and `pullRequestCommentBody(...)`.
- Modify the orchestrator's `notices` stage to call it after `sendPaymentNotices`.
- Test: `tests/github-payment-comments.test.ts`.

Steps:
- [ ] Failing tests for every case in spec §4 under "Comments".
- [ ] Implement, pass, commit.

### Task 6: Private repositories through installation tokens

**Files:**
- Modify `src/lib/milestone-verification.ts`: a per-run token resolver, which uses the connected installation's token
  and otherwise the deployment's.
- Modify `src/lib/github-verification.ts` only if a token argument is needed.
- Test: extend `tests/milestone-verification*.test.ts`.

Steps:
- [ ] Failing tests:
  - a pull request in a connected installation is read with the installation token;
  - an unconnected one with the deployment's;
  - without the app configured, unchanged.
- [ ] Implement, pass, commit.

### Task 7: Docs

**Files:**
- Create `content/docs/guides/github.mdx`, and register it in nav and content.
- Modify:
  - `guides/api-milestones` and `guides/pay-a-contractor`;
  - the changelog;
  - the privacy page;
  - README and ARCHITECTURE;
  - `tests/docs-guides.test.ts` and `tests/docs-content.test.ts`.

Steps:
- [ ] Write the docs.
- [ ] Grep for "repository must be public".
- [ ] Run the docs tests.
- [ ] Commit.

### Task 8: Verify and ship

- [ ] Run `npm run verify` on the branch merged with main.
- [ ] Open the PR with the partner's checklist (spec §6).
- [ ] The merge waits for the app's variables and migration 0071.
