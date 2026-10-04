# Bounties from a pull request comment

Date: 2026-10-04. Status: designed under the standing autonomy grant; rulings carry their cost if wrong.

## 1. Why

GitHub App (G1–G7) pays a merged pull request and says so on it, but the bounty itself is still set in Vestiarion: a
maintainer opens Contractors, adds the contributor as a counterparty, adds a milestone with the pull request as
evidence, and sends a payee link. Open-source maintainers are the wedge we chose for outside users, and they live in
GitHub. Here a maintainer attaches a bounty with a comment on the pull request, and the contributor says where to be
paid with a comment of their own. Every bounty comment also shows Vestiarion to the contributor and to anyone reading.

## 2. Approaches considered

- **Comment commands, read from GitHub's `issue_comment` webhook (chosen).** GitHub signs each delivery and names who
  wrote the comment, so both the maintainer and the contributor are identified by GitHub itself.
- **A label such as `bounty: 25`.** Needs a label per amount and a second channel for the contributor's address.
- **The payee link, posted on the pull request.** A link in a public comment is a bearer secret anyone can open
  first; the contributor's own comment is not.

## 3. Rulings

- **B1. Two commands, in a new comment on a pull request.**
  - `/bounty <amount>` or `/bounty <amount> USDC`, from someone who can write to the repository.
  - `/payto <Arc address>`, from the pull request's author.
  - A command is a line of its own, at the start of the line, in any case; the first command line in a comment is the
    one read. Comments on issues, edited comments and every other event are ignored.
  - Cost if wrong: the syntax is a little stricter than a maintainer may type, and the replies say the right one.
- **B2. The webhook.** `POST /api/github/webhook` checks `X-Hub-Signature-256`, an HMAC-SHA256 of the raw body with
  `GITHUB_APP_WEBHOOK_SECRET`, in constant time.
  - Without the secret or the app's settings, the route answers 404 and reads nothing.
  - A missing or wrong signature: 401.
  - Any event other than a created comment on a pull request: 204.
  - A command: 202 at once, and the work runs after the response (`after()`), inside GitHub's ten seconds.
- **B3. Which workspace.** The installation named in the delivery, as connected in `github_installations`.
  - None: nothing happens and nothing is said. The app is installed, but no workspace asked to act there.
  - More than one: the reply says a bounty cannot be attached from a comment there, and to add it in Vestiarion.
- **B4. Who may attach a bounty.** GitHub's own answer: `GET /repos/{owner}/{repo}/collaborators/{login}/permission`
  with the installation's token must say `admin` or `write`. Anyone else gets a reply saying who can.
- **B5. Who acts in Vestiarion.** The member who connected the installation (`connected_by`), read now through
  `memberActor`, on a new surface `github` that may run `milestone.add` and nothing else.
  - Their role must still hold `records.write`. If they left the workspace or lost the role, the reply says to connect
    GitHub again.
  - Provenance: `{ via: "github", installationId, login }`, where `login` is the commenter's.
  - Cost if wrong: repository maintainers act under the connecting member's name. The bounds below are what keep that
    safe.
- **B6. One bounty per pull request, per workspace.** A new platform table `github_bounties` records it, unique on the
  workspace, repository and pull request. The triggering comment's id is unique too, so a redelivered event does
  nothing twice.
  - A second `/bounty` on the same pull request gets a reply naming the bounty on file. Changing it is done in
    Vestiarion.
  - The row is claimed before the counterparty and the milestone are made, with both left empty until they exist.
    Two comments at once therefore never make two milestones, which would pay the pull request twice. A claim whose
    milestone could not be made is removed.
- **B7. The payee.** The pull request's author. A bot author is refused.
  - The same GitHub account is the same counterparty across a workspace's bounties, found through `github_bounties`.
  - A new one is added as a contractor named `<login> (GitHub)`, on Arc testnet, with no address yet. Its payment
    limit is the bounty's amount, and it is screened as every counterparty is.
  - Cost if wrong: a later, larger bounty to the same person is held for a person's approval, which is the limit
    doing its job.
- **B8. The milestone.** `PR #<number>: <title>`, trimmed to fit 160 characters, for the amount in USDC, with the pull
  request as evidence. The cycle's GitHub check verifies it once the pull request is merged, as for any milestone with
  a pull request.
  - A closed pull request that was not merged is refused.
  - A merged one is verified at the next cycle.
- **B9. The address.** `/payto 0x…` from the pull request's author changes their counterparty's address the way a
  payee link does.
  - The change is stamped, so the agent holds payments to it until a member confirms it in Vestiarion. Members are
    emailed, as for a payee link.
  - From anyone else, the reply says only the author can set it.
  - On a pull request with no bounty, the reply says there is none.
  - The address already on file gets a reply saying so.
- **B10. Replies.** The app replies on the pull request for each outcome.
  - A reply names the workspace and the amount, and mentions the author with `@` so GitHub notifies them.
  - It never carries an email, a link token or a secret.
  - A workspace's name is escaped as in G4.
  - A reply that GitHub refuses is logged and never retried: the bounty stands either way.
- **B11. The ledger.**
  - `github_bounty_attached`: actor human, by the connecting member, via GitHub, with the commenter's login, the pull
    request, the amount and the comment's link.
  - The existing entries, marked as from GitHub: `create_counterparty`, `create_milestone`,
    `counterparty_address_changed`.
- **B12. Nothing else changes.** The agent decides each release under every guardrail:
  - screening;
  - the counterparty's payment limit;
  - the confirmed address;
  - the daily spending limit and its contract on Arc.

  After payment, the existing comment says "Paid".
- **B13. A merge starts the cycle (added after the first rollout).** In testnet-2 the bounty on #195 waited after its
  merge, because only a cycle runs the GitHub check, and the next one was the schedule's.
  - The webhook also takes `pull_request` events. On one closed as merged, every workspace that connected the
    installation and has a pending milestone for that pull request gets `runCycleSoon`.
  - The event kind is `pull_request_merged`, and the cycle runs under the member who connected GitHub.
  - The pull request is matched as the GitHub check reads a link, so a link the check cannot verify starts nothing.
  - The app subscribes to **Pull request** events; its Pull requests permission already allows them.
  - Cost if wrong: a merged pull request with no milestone in a connected repository costs one query per workspace.

## 4. Pieces

- `src/lib/github/webhook.ts`:
  - `verifyWebhookSignature`;
  - `readCommentCommand`;
  - `githubWebhookSecretFromEnv`.
- `src/lib/github/app.ts`: `repositoryPermission`.
- `src/lib/github/bounties.ts`:
  - `handlePullRequestComment`;
  - the reply texts;
  - the workspace, permission, actor, counterparty, milestone and address steps.
- `src/app/api/github/webhook/route.ts`.
- `supabase/migrations/0072_github_bounties.sql`: the platform table `github_bounties`.
- The command layer:
  - the `github` surface and its provenance;
  - `createCounterparty` and `changeCounterpartyAddress` accept a GitHub origin.
- Docs:
  - the GitHub guide gains "Bounties from a comment";
  - README;
  - ARCHITECTURE;
  - `.env.example`;
  - the privacy page, for the GitHub comment data read.

## 5. Testing

- **Unit:**
  - the signature check: valid, wrong, missing, wrong length;
  - command parsing: amounts, cases, the first command line wins, address shape;
  - the reply texts, escaped.
- **The handler, with the fake Supabase recorder and a fake GitHub:**
  - attach;
  - refuse a reader;
  - refuse an ambiguous installation;
  - refuse a bot author;
  - refuse a closed pull request;
  - a second bounty;
  - a redelivered comment;
  - reuse of a known contributor;
  - `/payto` by the author, by someone else, without a bounty, and with the same address.
- **The route:** 404 when off, 401 on a bad signature, 204 on other events, 202 on a command, with the work scheduled.
- **The migration, on PGlite:**
  - the uniques;
  - RLS for browser and tenant roles;
  - org deletion cascades;
  - the structure tests' table lists.

## 6. Rollout (partner)

1. Run migration 0072.
2. On the GitHub App's settings page:
   - **Permissions → Repository → Issues: Read-only**, since GitHub sends comment events only with it;
   - **Subscribe to events → Issue comment** and **Pull request** (B13);
   - **Webhook: Active**, URL `https://www.vestiarion.xyz/api/github/webhook`, with a new random secret.
3. Set the same secret as `GITHUB_APP_WEBHOOK_SECRET` in Vercel, then redeploy.
4. Accept the app's new permission on the installation, where GitHub asks for it.
5. Prove it end to end:
   - comment `/bounty 0.1` on an open pull request in the connected repository;
   - comment `/payto <address>` as its author;
   - confirm the address in Vestiarion;
   - merge.

   It is proven when the "Paid" comment appears.

## 7. Rollout record

2026-10-04, in testnet-2, on `duongnq2798/vestiarion#195`:

- **Attach.** `/bounty 0.1` by the repository's owner at 05:59:43 UTC; the app replied at 05:59:54.
  - `create_counterparty` #1330, via GitHub: `duongnq2798 (GitHub)`, a contractor.
  - `screen_counterparty` #1331: clear.
  - `create_milestone` #1332: "PR #195: …", 0.1 USDC.
  - `github_bounty_attached` #1333.
- **Address.** `/payto` from the pull request's author at 06:00:50; the app replied at 06:00:58.
  - `counterparty_address_changed` #1338, via GitHub, waiting for a member.
  - A member confirmed it at 06:03:40 (#1339).
- **Pay.** Merged at 06:06:34. No cycle followed, which is the gap B13 closes: only a cycle runs the GitHub check, and
  the next one was the schedule's. A manual Run cycle then:
  - verified it at 06:10:04 (#1344);
  - released it at 06:10:19 (#1345): transaction
    `0xc50836ef89cd6ba6a32ae600fb0a6a193882649e21eaae561b47639b618cb155`, status 1, block 65410639;
  - commented "Paid" at 06:10:27 (#1347):
    https://github.com/duongnq2798/vestiarion/pull/195#issuecomment-5977198065.
