# GitHub App: comment the payment on the pull request

Date: 2026-10-04. Status: designed on `feat/github-app`. Decided under the standing autonomy grant. It builds on
write API part 2 (`2026-10-03-write-api-part-2-design.md`, PR #182), which pays a milestone whose evidence is a merged
pull request.

## 1. Why

A system can now pay a contributor when their pull request merges. The contributor, the maintainers and anyone
reading the pull request still cannot see that it was paid. A comment on the pull request, posted when the payment is
confirmed, shows it where the work was done. It names the amount and links the Arc testnet transaction.

There are two gaps:

- **Posting.** The deployment's GitHub token reads pull requests; it cannot comment on another account's repository.
- **Private repositories.** The token cannot read a private repository's pull requests, so the GitHub check cannot
  verify them; the guide says so.

A GitHub App, installed by the repository's owner, solves both for the repositories they choose.

## 2. Approaches considered

- **A. One platform GitHub App that each workspace connects (chosen).**
  - The repository's owner installs it on the repositories they choose, from Settings.
  - Vestiarion checks, with GitHub, that the person connecting can reach that installation.
  - The installation's tokens read the repository's pull requests and comment on them.
- **B. A personal access token per workspace.** Simpler, but it acts as one person, every repository they can reach
  is in scope, and it is a long-lived secret to store.
- **C. Comment with the deployment's token.** It could comment only on repositories the platform's own account can
  write to, so it would serve no one else.

## 3. Rulings

- **G1. One platform GitHub App, registered by the partner.**
  - It is configured by five variables: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`,
    `GITHUB_APP_CLIENT_SECRET` and `GITHUB_APP_PRIVATE_KEY` (PEM). The feature is off unless all five are set.
  - Its permissions are **Pull requests: read and write** and **Metadata: read**. It has no webhook.
  - It can be installed on any account.
  - **Request user authorization (OAuth) during installation** is on, with the callback
    `<origin>/api/github/callback`.
- **G2. Connecting checks the installation with GitHub.**
  1. On Settings, an owner or admin (`integrations.manage`) chooses **Connect GitHub**.
  2. `GET /api/github/install?org=<slug>` sends them to `https://github.com/apps/<slug>/installations/new`. It carries a
     signed state, which names the workspace, the person and a nonce, and expires in 10 minutes. The same nonce is kept
     in an HttpOnly cookie. This is the Slack install's construction, with its own key.
  3. GitHub sends them back to `GET /api/github/callback` with `code`, `installation_id` and the state.
  4. The callback requires all of these:
     - the state is Vestiarion's and unexpired;
     - it carries this browser's nonce;
     - it names the person signed in now;
     - that person's role, read again, still allows `integrations.manage`.
  5. The `code` is exchanged for a user access token. The `installation_id` counts only if `GET /user/installations`,
     called with that token, lists it. GitHub's advice is never to trust `installation_id` alone. The user token is used
     for this check only, and never stored.
  6. The workspace keeps the installation's id, its account's login and type, and whether it covers all repositories or
     selected ones. The ledger records `github_connected`.
  7. Every way back lands on Settings with `?github=` and one of: `connected`, `cancelled`, `forbidden`, `not_yours`
     or `failed`.
- **G3. Many to many, removable in Vestiarion.**
  - A workspace may connect several installations.
  - One installation may be connected to several workspaces, each by a person who can reach it.
  - **Disconnect** removes the link in Vestiarion, recorded as `github_disconnected`. The panel says how to uninstall
    the app on GitHub, which is what takes its access away.
- **G4. A comment once the payment is confirmed.** The cycle's `notices` stage looks at the workspace in scope.
  - **Which payments.** Each payment intent for a milestone that is:
    - confirmed with a `0x` transaction;
    - confirmed within the last 3 days, and after the workspace first connected GitHub;
    - not yet commented.
  - **Which pull requests.** The milestone's evidence must be a GitHub pull request. Its repository's installation,
    found with the app's JWT, must be one the workspace connected. Otherwise nothing is posted: Vestiarion never
    comments on a repository the workspace has not connected.
  - **Posting.** The payment is claimed (`pr_comment_at`), then the comment is posted.
    - On success, `pr_comment_url` is stored and the ledger records `pull_request_commented`.
    - On failure, the claim is released, so the next cycle tries again within the window.
  - **How many.** At most 10 per run.
  - **What the comment says.** The amount, the network, the paying workspace's name and the transaction's link on the
    Arc testnet explorer. It never names the payee. The payee's address is visible on chain through the link anyway.
- **G5. Private repositories verify.** The GitHub check reads a pull request with an installation token when its
  repository is in an installation the workspace connected. Otherwise it uses the deployment's token, as before. A
  private repository's merged pull request can therefore verify its milestone.
- **G6. Data (migration 0071).**
  - **`github_installations`** is a platform table: RLS on, no policies, service role only. Its columns:
    - `org_id`, cascading with the org;
    - `installation_id` (bigint);
    - `account_login`, `account_type`, `repository_selection`;
    - `connected_by`, `connected_at`.

    It is unique on `(org_id, installation_id)`.
  - **`payment_intents`** gains `pr_comment_at` and `pr_comment_url`.
- **G7. Secrets stay put.**
  - The app's private key, the installation tokens and the user token are never logged or stored. Installation tokens
    are cached in memory for one run.
  - The PEM may arrive with literal `\n`, as hosting dashboards often keep it; it is read either way.
- **G8. Ledger and docs.**
  - The new entries are `github_connected`, `github_disconnected` and `pull_request_commented`. Webhooks deliver them
    as `ledger.appended`, so the changelog lists them.
  - A guide, `guides/github`, covers connecting, private repositories and the comment. `api-milestones` and
    `pay-a-contractor` point to it, and their "public repositories only" sentence now says the app lifts it.
  - The privacy page, README and ARCHITECTURE are updated too.
- **G9. Off means unchanged.** Without the five variables:
  - the Settings card is not shown;
  - the two routes answer 404;
  - no comment is attempted;
  - the GitHub check uses the deployment's token alone.

## 4. Testing

- **Settings:** a missing or malformed variable turns the feature off; the PEM is read with real or literal newlines.
- **App JWT:** RS256, `iss` set to the app id, issued 60 s in the past, expiring 9 minutes ahead, and verifiable with
  the public key.
- **Install:**
  - the redirect carries a state and sets the cookie;
  - a signed-out person is sent to Settings;
  - a role without `integrations.manage` gets `forbidden`.
- **Callback:**
  - a bad, expired or other-browser state answers 400;
  - another signed-in person gets `forbidden`;
  - no code means `cancelled`;
  - an installation not in the user's list means `not_yours`, and nothing is saved;
  - a listed one is saved with `github_connected`;
  - the user token is in nothing saved or logged.
- **Comments:**
  - a confirmed milestone payment for a pull request in a connected installation gets one comment, with
    `pull_request_commented`;
  - a second run posts nothing;
  - a repository whose installation is not connected gets nothing;
  - a failed post releases the claim;
  - nothing happens without the app, older than the window, or before the connection;
  - the body never names the payee.
- **Check:** a pull request in a connected installation is read with an installation token; any other with the
  deployment's.
- **Migration:** the table is closed to `anon`, `authenticated` and the tenant, and the columns exist.
- **Docs:** the guides quote the app's text; nav and changelog.

## 5. Rollout

1. The partner registers the GitHub App (§6), sets the five variables on Vercel and applies migration 0071. Then we
   merge.
2. In testnet-2: Settings, **Connect GitHub**, and install the app on `duongnq2798/vestiarion`.
3. With the API, add a 0.10 USDC milestone for API Test Contractor whose evidence is a merged pull request of that
   repository.
4. The agent verifies the milestone and pays it. The next cycle comments on the pull request: expect
   `pull_request_commented` and the comment on GitHub.
5. Record the entries, the transaction and the comment here.

## 6. Registering the app (partner)

On GitHub: **Settings**, **Developer settings**, **GitHub Apps**, **New GitHub App**.

- **Name:** "Vestiarion Payments". **Homepage URL:** `https://www.vestiarion.xyz`.
- **Callback URL:** `https://www.vestiarion.xyz/api/github/callback`. Tick **Request user authorization (OAuth) during
  installation**.
- **Redirect on update:** tick it. An account where the app is already installed then comes back to Vestiarion after
  its installation is configured, so a second workspace, or one that disconnected, can connect it too.
- **Webhook:** untick **Active**.
- **Repository permissions:**
  - Pull requests: **Read and write**;
  - Metadata: **Read-only**, which GitHub requires.
- **Where can this GitHub App be installed:** **Any account**.
- After creating it, read these into Vercel's variables:
  - the **App ID**;
  - the **Client ID**;
  - a new **client secret**;
  - a new **private key** (the `.pem` file's contents);
  - the app's slug, from its public URL `https://github.com/apps/<slug>`.
