# Vestiarion

An autonomous treasury agent for a small business, settled in USDC on Arc.

## Try it

- **The app:** [www.vestiarion.xyz](https://www.vestiarion.xyz). The five-minute path, with no wallet and no keys, is in [Try it in 5 minutes](https://www.vestiarion.xyz/docs/guides/try-it):
  1. sign in;
  2. load sample data;
  3. watch the agent decide within a minute;
  4. approve a payment yourself;
  5. verify the signed ledger.
- **Research:** [When the model and the policy disagree](https://www.vestiarion.xyz/docs/research/model-vs-policy). In its first week the agent made 141 decisions, and 127 were recorded beside the written policy's answer to the same facts. On payables, the model chose the policy's action 32 times in 39. Of the 7 differences:
  - 3 stopped a payment the policy would have made;
  - 3 stopped it by a different action than the policy's;
  - 1 would have paid over a limit, and code refused it.
- **Live numbers:** [www.vestiarion.xyz/open](https://www.vestiarion.xyz/open) shows the payments, payees and decisions, read from the production database, with our own workspaces counted apart from customers'.
- **Updates:** [@vestiarionhq](https://x.com/vestiarionhq) on X, where what ships is posted with its receipts.
- **Real transactions on Arc testnet**, made by the agent in production:
  - a USDC payable paid 53 seconds after it was added, with no one pressing Run:
    [`0x81381c50…4e68`](https://testnet.arcscan.app/tx/0x81381c50f5d0cadb49d1af77f1abb06c1727c8377aa88cbe1cfbf327f09c4e68);
  - a EURC invoice, weighed against a USDC limit at a rate quoted by Circle's Stablecoin Service:
    [`0x2e66257f…8f58`](https://testnet.arcscan.app/tx/0x2e66257f2cf478ecd2d0f7e263e1ad78bf9877b0afb93f3679c0601ef7328f58);
  - a payout to a vendor on Base Sepolia through CCTP. The burn is on Arc,
    [`0xbc1961bb…d49c`](https://testnet.arcscan.app/tx/0xbc1961bbe2896e7e91d452498b595f1a1de8d45f34b7db8b3fd9d873d908d49c),
    and Circle forwarded the mint of exactly 1 USDC on Base Sepolia,
    [`0x6c749323…ef9a`](https://sepolia.basescan.org/tx/0x6c749323f9e36efe21fcd5c33df2e55ba5db82040dbd06ff2a8872045c6fef9a);
  - an invoice read from a PDF by the model, checked by a person, and paid 16 seconds after it was added:
    [`0x197e979f…64b3`](https://testnet.arcscan.app/tx/0x197e979f3b108d759f5e5e5ee0d7bc67e67acb1c520de1b3c7e969ae689c64b3);
  - idle cash put to work: 60.71 USDC deposited into Circle's USYC through its Teller contract, and 53.28 USYC sent to the reserve wallet:
    [`0x1cf65900…f42e`](https://testnet.arcscan.app/tx/0x1cf659007ce734a73908a705e2537a56065d87fd0f52571d7e67d0654b94f42e);
  - a payable due today, with too little cash in the operating wallet: the agent redeemed the missing 0.88 USDC from USYC,
    [`0x4b5186db…c7f2`](https://testnet.arcscan.app/tx/0x4b5186db4820df87532869e0a9797df5a79a7e9e3a5feb1e3edb09500160c7f2),
    then paid the 2 USDC 34 seconds after the invoice was added,
    [`0x365da374…9d8b`](https://testnet.arcscan.app/tx/0x365da374f902fcb995643713962554b41e6114b62bb40695874aa519dd829d8b).

  Each feature's design under `docs/superpowers/specs/` ends with its rollout record: what was run in production, with its ledger entries and transactions.

> *Tameion* is ancient Greek for a treasury — literally the room the money was kept in. In
> Byzantium that room grew into the *vestiarion*, the department that minted the coin, held the
> stores, and paid the army. Vestiarion is the same idea in software: **one agent that runs a
> company's entire money cycle** — pays vendors, releases contractor pay, screens counterparties,
> and puts idle cash to work — instead of five disconnected tools a person stitches together by
> hand on a Tuesday.

## What it does

Vestiarion runs a configured business's treasury through one decision loop, the **agent cycle**.
Each organization's own name (`orgs.name`) is the identity shown in the product; no customer name
is hard-coded into the interface:

1. **Compliance** — the whole counterparty book is re-screened every cycle, not checked
   once at onboarding. A hit tiers the payment limit down instead of a blunt yes/no, and the tier
   is *reversible*: the limit the business configured lives in its own column, so a counterparty
   that comes off the watchlist gets its full limit back and one that stays on it does not decay
   a little further every time it is looked at. The sweep is logged whether or not anything
   changed, because proving screening happened is the part a one-time gate cannot do.
2. **AP automation** — each payable invoice gets a three-way match (PO ↔ goods received ↔
   invoice) plus a risk check, and the agent decides to **pay**, **hold** (over limit), **request
   info** (no PO match), or **flag as fraud** (high-risk counterparty) — with its reasoning
   attached to the line item. A payable to a client, which pays the business, is never paid by the
   agent: it waits for a person.
3. **Contractor payments** — a GitHub PR URL can be checked for an actual merge before a
   milestone is released. Human verification remains available and is recorded as a human ledger
   action. Verified milestones are released the same day instead of waiting for Net-30.
4. **Treasury** — idle operating cash above a 7-day obligation buffer is swept into Circle's USYC,
   a tokenized money market fund, on Arc testnet; the agent redeems back out ahead of due dates
   rather than after. The sweep only happens when it pays for itself: a sweep and the redemption
   that must follow it are two transactions, so the policy computes the yield the swept cash would
   earn over the days it would stay, before what falls due calls it back (at most 30), and compares
   it to the round-trip fee. Idle cash that would earn less
   than it costs to move stays liquid (`src/lib/agent/treasury.ts`). Code bounds the model's moves:
   a sweep never takes the operating wallet below its buffer, and a redemption brings back at most
   what the next 14 days need. Payments come first: before
   it decides any payment, each cycle redeems what the payables due today need beyond the
   operating balance, so no payment waits for cash sitting in the reserve, and an owner or admin
   can bring cash back at any hour with **Bring cash back** (`src/lib/agent/liquidity.ts`). USYC is
   permissioned: Circle allowlists the two wallets, and an owner turns the reserve on in Settings;
   until then the reserve is simulated, and labelled so.
5. **Continuous audit trail** — every decision above is appended to a hash-chained, Ed25519-signed
   ledger (`/audit`). A reviewer can verify the whole chain in one click and read *why* the agent
   acted, not just that a balance moved.
6. **Receivables** — a client pays a receivable through a link on Arc testnet, and the agent matches the
   transfer that arrives to what was owed. When an owner turns reminders on, the agent decides when to
   email the client a reminder, with the link, and how firmly, within bounds code sets: from 3 days
   before the due date, at most every 3 days, at most 4, a final tone only once the invoice is a week
   late (`src/lib/agent/collections.ts`).
7. **Human oversight** — a payable the agent held, flagged, or left awaiting information waits in
   an approvals inbox (`/o/<slug>/approvals`) for a person to decide: **approve and pay** it now,
   through the very payment step the agent itself uses, so a person's payment and the agent's
   cannot disagree about what happened; **reject** it, closing the obligation; or **return** it for
   the agent's next cycle to decide again. No one approves an invoice they created, and no one —
   however they click — can approve paying a counterparty screened high risk; only Compliance
   clears that. A claim on the row makes one person's decision exclusive, however many people
   click; the payment intent's idempotency key, keyed on the invoice, is what keeps an invoice from
   being paid twice, whether by two people or by a person and the agent's own cycle. A payment
   still pending is reconciled by the next cycle, never decided again, so the agent cannot undo a
   person's approval. Anyone who can approve a payment can also pause the
   agent for the whole workspace, with a reason shown on every page until someone resumes it, and
   only an owner or admin may resume it. Pausing stops the agent's own cycles and the money it would
   move mid-cycle, including reserve sweeps and redemptions; it never stops a person's own decision
   in the approvals inbox.
7. **Telegram** — each member can connect their own Telegram chat from **Members**. The chat gets
   the agent's decisions within the cycle that makes them, each with its reasons, its Arc testnet
   transaction and a link to where a person handles it; answers `/today` (safe to spend today),
   `/waiting` and `/ledger`, or the same questions in plain words, with figures written by code,
   never by the model; and reads an invoice sent to it, as a PDF or its text, into a payable an
   owner or admin adds with one tap. The bot never approves or pays: a stopped payment links to
   Approvals (`src/lib/telegram/`, [guide](https://www.vestiarion.xyz/docs/guides/telegram)).
8. **Slack** — an owner or admin connects the workspace to a Slack channel from **Settings**. The
   channel gets the agent's decisions within the cycle that makes them; each member who connects
   their own Slack account asks `/vestiarion today`, `waiting` or `ledger`, and can pause the agent.
   When an owner sets a limit, a payment the agent stopped carries **Approve and pay**, **Reject**
   and **Return to the agent** in its message: a click acts as that member, with their role read
   again, through the same command and every check as Approvals; Approve and pay only for USDC
   on Arc within the limit, to the address the message showed, and a payee's changed address is
   still confirmed in Vestiarion. Each decision's ledger entry says it came from Slack
   (`src/lib/slack/`, [guide](https://www.vestiarion.xyz/docs/guides/slack)).

Every decision is made by asking an LLM for a structured `{action, reasoning, confidence}` verdict
under an explicit guardrail policy (never pay a high-risk counterparty, never exceed a payment
limit, keep a liquidity buffer before sweeping to yield). Anthropic, OpenAI, and DeepSeek are all
supported, and with no key at all the same decision points fall back to a transparent rule-based
heuristic — so the app runs end-to-end with zero credentials, and every ledger entry records which
path produced it.

## Contracts on Arc testnet

Vestiarion deploys two contracts of its own, one copy per workspace that uses it, through Circle's
Smart Contract Platform. Their source is in [`contracts/`](contracts); both were written for
Vestiarion and are not audited. The copies running in production, in testnet-2, our own test
workspace:

| Contract | What it does | Address |
| --- | --- | --- |
| `VestiarionEscrow` | Locks a milestone's USDC for a contractor; only the operating wallet can release it to the contractor, or take it back from a refund date | [`0x74af203fec3f121ff1cd3a763092d1211487702b`](https://testnet.arcscan.app/address/0x74af203fec3f121ff1cd3a763092d1211487702b) |
| `VestiarionSpendingLimit` | The agent's payments leave through `pay`, which refuses anything past the daily or 7-day limit | [`0x9da3c47f73ea9399ac566806a189b0bf47b7d4ba`](https://testnet.arcscan.app/address/0x9da3c47f73ea9399ac566806a189b0bf47b7d4ba) |

The Circle contracts it calls on Arc testnet:

| Contract | Address |
| --- | --- |
| USDC | [`0x3600000000000000000000000000000000000000`](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000) |
| EURC | [`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`](https://testnet.arcscan.app/address/0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a) |
| USYC | [`0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C`](https://testnet.arcscan.app/address/0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C) |
| USYC Teller | [`0x9fdF14c5B14173D74C08Af27AebFf39240dC105A`](https://testnet.arcscan.app/address/0x9fdF14c5B14173D74C08Af27AebFf39240dC105A) |
| USYC Entitlements | [`0xCC205224862C7641930c87679E98999d23C26113`](https://testnet.arcscan.app/address/0xCC205224862C7641930c87679E98999d23C26113) |
| Gateway Wallet | [`0x0077777d7EBA4688BDeF3E311b846F25870A19B9`](https://testnet.arcscan.app/address/0x0077777d7EBA4688BDeF3E311b846F25870A19B9) |
| Gateway Minter | [`0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`](https://testnet.arcscan.app/address/0x0022222ABE238Cc2C7Bb1f21003F0a260052475B) |
| CCTP TokenMessengerV2 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://testnet.arcscan.app/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |

What each one is used for, the workspace's wallets around the two contracts, and the USDC of the
chains payees are paid on: [Contracts on Arc testnet](https://www.vestiarion.xyz/docs/contracts).

## Architecture

The layout below is the short version. [ARCHITECTURE.md](ARCHITECTURE.md) goes further, and
the [developer docs](https://www.vestiarion.xyz/docs) document the API and webhooks.

```
supabase/migrations/      Postgres schema. Money is numeric(20,6), never a
  0001_init.sql            float; the ledger chain is linked inside an
                           append_ledger_entry() function under an advisory
                           lock so concurrent cycles cannot fork it.
src/lib/config.ts         VestiarionConfig, and the only place the environment
src/lib/context.ts         is read. A scope carries a config and its clients,
                           so one process can serve more than one business
src/lib/dal/               The only module allowed to hold the raw service-role
                           client; db() scopes every query to the organization in
                           scope
src/lib/api/              The v1 read contract: one envelope, coded errors,
                           opaque cursors
src/lib/insights.ts       Typed, server-only query boundary for measured
                           transfer, cycle, balance, and screening history
src/components/ui/        The design system: Radix-based primitives styled from
                           the tokens in globals.css — buttons, fields, menus,
                           dialogs, sheets, tabs, toasts, the command palette.
                           /design shows every one in development
src/components/vx/        Vestiarion's domain components — decision cards, the
                           audit ledger, treasury tiles, provenance, D3 charts —
                           built only from src/components/ui
  Brand.tsx                Reusable vector Treasury Seal brand mark
  nav.ts                   The workspace's sections, in groups: one list feeds
                             the sidebar, the mobile drawer and page titles
  AppFrame.tsx             Workspace navigation, drawn by the /o/[slug] layout:
                             a sidebar from `lg` up, a top bar and drawer below
  InsightsCharts.tsx       scales/shapes rendered declaratively through React
src/app/icon.svg          The app icon. `node scripts/build-icons.mjs` renders it
                           to favicon.ico, apple-icon.png and the web manifest's
                           icons; re-run it whenever the icon changes
src/lib/ledger.ts         Hash-chained, Ed25519-signed append-only audit log
src/lib/compliance.ts     Continuous counterparty screening + risk tiering
src/lib/circle/           ChainProvider interface, three implementations:
  simulateProvider.ts       - simulate: needs no credentials, uses Arc's real
  liveProvider.ts             fee/latency profile
  index.ts                  - live: Circle Developer-Controlled Wallets
                            - hybrid (default with credentials): real Arc
                              payments; the USYC leg is real once the
                              workspace's USYC reserve is on, simulated and
                              labelled before
src/lib/agent/
  decide.ts                 Provider-agnostic decision helper: Anthropic ->
                             OpenAI -> DeepSeek -> rule-based heuristic
  treasury.ts               The sweep/redeem policy as a pure function, so the
                             LLM and the heuristic reason from one set of
                             numbers and the whole policy is testable
  orchestrator.ts            The agent cycle: reconcile -> receipts ->
                             compliance -> follow-up -> recurring -> services
                             -> liquidity -> AP -> contractors -> treasury ->
                             forecast -> proposals -> collections -> notices
                             -> telegram -> slack, all logged to the ledger
  liquidity.ts               Redeems from USYC what today's payments need
                             before AP decides them; a person's Bring cash back
  cycle-metrics.ts           Counts outcomes, decision sources, and code-level
                             guardrail overrides at the point they occur
  pay.ts                    payInvoice: the one payment step a cycle's AP
                             stage and a person's approval both call
  approvals.ts               Lets a person approve and pay, reject, or return
                             a payable the agent held, claimed in the database
                             first so two deciders cannot race the same row
  pause.ts                   The per-workspace pause a cycle re-reads before
                             every payment and every reserve move it makes
tests/                    Vitest. Every money path that can be tested without
                           a network: the hash chain and its tamper cases,
                           risk tiering, the treasury economics, provider
                           selection and fallback. `npm run verify`
scripts/                  Tenant scripts require an organization slug
                           (`-- <org-slug>`); seed, bootstrap:circle, and
                           three doctors tell you which parts are live
src/app/                  Evidence-first landing page at `/`; working treasury
                           console at `/console`, plus AP/AR, Contractors,
                           Compliance, Audit Log, and database-backed Insights
src/app/api/v1/           API for bots, MCP servers and anything else
                           consuming Vestiarion, authenticated with a
                           workspace API key
src/lib/platform/api-keys.ts  Key generation and hashing, listing and
                               revocation; only sha256(secret) is ever stored
src/lib/telegram/         The Telegram bot: one-time connect codes, the webhook's
                           update handler, /today /waiting /ledger, invoices
                           read into payables, and the cycle's stage that
                           tells each connected chat what the agent did
src/lib/slack/            The Slack app: request signatures, installing over
                           OAuth, member links, /vestiarion, the decision
                           buttons, and the cycle's last stage, which posts
                           what the agent did to the workspace's channel
src/lib/commands/         One function per action a person takes, gated the
                           same way from the console, Telegram, Slack and the
                           API
src/lib/webhooks/         Signing, SSRF-safe sending, and the retry/disable
                           policy for a workspace's own HTTPS endpoints; a
                           new ledger entry queues a signed delivery to each
                           active one
```

Each workspace creates and revokes its own API keys on
`/o/<slug>/settings` (owner or admin only; see
[Authentication](https://www.vestiarion.xyz/docs/get-started/authentication)). A
key reads; one given write access can also add counterparties and invoices,
which the agent decides like any other, and an address it adds waits for a
person to confirm it. A key never approves or pays. It is shown once, in full,
right after it is created, and authenticates `/api/v1` requests for that
workspace alone — there is no shared or platform-wide credential on that
surface. The same key connects an AI agent to the
[MCP server](https://www.vestiarion.xyz/docs/ai-integration/mcp) at `/api/mcp`, whose tools are the `/api/v1` operations.

The same page lets an owner or admin (`webhooks.manage`) register up to 5
HTTPS endpoints that receive the workspace's ledger, signed, as it happens —
pushed rather than polled. See [Webhooks](https://www.vestiarion.xyz/docs/webhooks).

## Running it

```bash
npm install
cp .env.example .env.local
```

Create a [Supabase](https://supabase.com) project and put its URL and keys in `.env.local`
(Project Settings → API, plus the database password and project ref under Database). Also set
`VESTIARION_MASTER_KEYS` (generate with
`node -e "console.log('v1:' + require('crypto').randomBytes(32).toString('base64'))"`) —
required wherever the app or a script runs, because every organization's ledger signing key and
Circle credentials live encrypted on its own row in `orgs`, decrypted with this key, and the app
no longer reads `LEDGER_SIGNING_KEY`, `LEDGER_PUBLIC_KEY`, `CIRCLE_API_KEY`, or
`CIRCLE_ENTITY_SECRET` from the environment directly.

Also set `SUPABASE_JWT_SECRET` — required wherever the app runs, not only in production. Every
tenant request is signed with it (`src/lib/dal/request-token.ts`) so Postgres can enforce
row-level security as the `vestiarion_tenant` role; it is as powerful as the service role key, so
handle it the same way. Find it under Supabase → Project Settings → JWT Keys → Legacy JWT secret.
On Vercel, set it as a Sensitive variable for both Production and Preview. Then:

```bash
npm run db:migrate
npm run dev
```

Sign in at `/login` with your email. A first sign-in with no workspace lands at `/onboarding`: name
a business and you get your own **sandbox** workspace on the spot — its own Ed25519 ledger signing
key, generated and encrypted with no manual step, an `Operating (simulated)` account holding 10,000
simulated USDC, an empty `Reserve (simulated)` account, and a signed `org_created` entry as the
first line of its ledger. One person can create up to 3 workspaces this way; a setup that fails partway
is rolled back rather than left half-built. The workspace switcher at the top of the navigation
lists the workspaces you belong to and moves between them; its **Create workspace** and **All
workspaces** links (`/onboarding?new`) let you create another.

Every member of a workspace has one role. **Owner** and **admin** add counterparties, invoices, and
milestones, can run a cycle by hand, and can invite and manage members; **approver** cannot create
those records — keeping maker separate from checker from the start — but decides the payables the
agent would not pay on its own, from the approvals inbox, and can pause the agent; **viewer** reads
everything — the console, the ledger, past cycles — and changes nothing. A workspace always keeps at
least one owner: the database itself refuses to remove or demote the last one. Only an owner or
admin can resume an agent someone paused. A sandbox workspace is capped at 20 agent cycles per UTC
day, counted in the database so the cap holds however many server instances are running, which
bounds how much a trial workspace can spend on LLM calls, and a sandbox that sits inactive for 60
days is deleted by a daily cleanup job, unless an owner has connected Circle to it. An owner takes a
workspace live from **Settings** — see [Going live on Arc testnet](#going-live-on-arc-testnet).

An **owner** or **admin** invites someone from the workspace's **Members** page
(`/o/<slug>/members`), by email and role; an owner may grant any role, an admin only **approver** or
**viewer**. With `RESEND_API_KEY` set, the invitation is emailed; otherwise the page hands back a
link to share directly — shown once, since only its sha256 hash is stored. The link previews the
invitation without accepting it; accepting needs signing in with the invited address and expires the
link after 7 days. Inviting the same address again withdraws the older invitation; withdrawn and
revoked invitations are kept, marked withdrawn, and a workspace can send at most 50 invitations a
day. Anyone can leave a workspace they belong to from the same page. Deleting an account keeps the
workspaces it created and the members it invited; deleting a workspace's only owner is refused.

When a scheduled cycle leaves payables waiting for a decision, everyone who can decide them —
**owner**, **admin**, **approver** — and has not turned it off gets a digest email: the workspace
name, up to 10 of the waiting payables (then "and N more"), each with the counterparty, amount,
status and the first sentence of why the agent held it, and a link to the approvals inbox. A cycle
run by hand from the console never sends one, since the person running it is already watching it;
in practice this means only a `live` workspace's unattended cron cycles notify. An invoice already
told about is not told again unless it was escalated since. Each member has their own switch — "Email
me when payments need a decision" — on the Members page, on by default; this needs `RESEND_API_KEY`
too.

Only the **founding organization** — seeded ahead of any sign-in, in `live` mode — skips self-serve
creation: it exists before anyone signs in, so no self-serve step ever generates it a ledger key.
Becoming its operator still means granting yourself ownership by hand:

```bash
npm run org:grant -- founding <your email> owner
```

On a fresh database the founding organization has no ledger signing key yet, so the first
ledger-writing action (adding an invoice, running a day) fails with `LedgerSigningKeyError` until a
key is stored on it. One-time setup:

```bash
node -e 'const c=require("crypto");const{publicKey,privateKey}=c.generateKeyPairSync("ed25519");require("fs").appendFileSync(".env.local","\nLEDGER_SIGNING_KEY=\""+privateKey.export({type:"pkcs8",format:"pem"})+"\"\n");console.log(c.createHash("sha256").update(publicKey.export({type:"spki",format:"der"})).digest("hex").slice(0,16));'
npm run org:adopt-env -- founding --expect-key-id <id printed above>
```

The first line generates an Ed25519 key, appends it to `.env.local` as `LEDGER_SIGNING_KEY` on a
line of its own — even when the file does not end in a newline — without ever printing the
private key, and prints only its id — the first 16 hex characters of
SHA-256 over the public key's SPKI DER (`ledgerKeyId` in `src/lib/ledger-keys.ts`). The second
line encrypts that key onto the founding organization's row (needs `VESTIARION_MASTER_KEYS`,
above); `--expect-key-id` guards against storing the wrong key, and the command names the id it
actually found if yours doesn't match. If `.env.local` needs the PEM on one line instead — a
hosting dashboard's env var field, say — its newlines can be escaped as literal `\n` rather than
quoted and multi-line; both forms are read the same way (`src/lib/platform/adopt.ts`). This
one-time setup is only for a new, empty database: production's founding organization already has
its key stored.

Open your workspace's console — `/o/<slug>/console`, or `/o/founding/console` for the founding
organization — and add counterparties and invoices through the product. Each **Run day**
click advances the demo clock and runs the full decision loop. Out of
the box, payments are simulated against Arc's measured fee and latency profile ($0.0032, 2–5s) and
decisions come from the rule-based heuristic. Those two figures are not quoted from a docs page:
they were read back off Arc testnet from the receipts of real transfers this agent executed — see
[What we measured](#what-we-measured).

`npm run seed -- <org-slug>` is a destructive, opt-in demo command. It clears the named
organization's current business records and loads the fictional Northstar Studio fixture. The
ledger is append-only for tenants and is never cleared: the reset appends its own `demo_reset`
entry naming what it cleared instead. It is not part of normal setup, and there is no seed or
reset control in the product UI. Use it only against a disposable demo organization.

Two independent upgrades from there, in either order:

| Want | Set | Check with |
| --- | --- | --- |
| Real LLM reasoning | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `DEEPSEEK_API_KEY` | `npm run agent:doctor` |
| Real USDC on Arc | An owner connects Circle under **Settings → Go live** | `npm run circle:doctor -- <org-slug>` |

### Scripts

| Command | Does |
| --- | --- |
| `npm run verify` | Typecheck, lint, and the full test suite — what CI runs |
| `npm run test` / `test:watch` | Vitest, once or on change |
| `npm run db:migrate` / `-- --through <N>` | Applies `supabase/migrations/*.sql`, optionally only through migration `<N>` |
| `npm run seed -- <org-slug>` | **Destructive demo only:** replaces that organization's business data with fictional fixtures |
| `npm run bootstrap:circle -- <org-slug>` | Creates Arc-testnet wallets for that organization's accounts and counterparties |
| `npm run cycle -- <org-slug>` | Runs one agent cycle headlessly using the configured clock mode |
| `npm run fixture:guardrail -- <org-slug>` | **Demo only:** adds one no-transfer model-vs-code refusal probe |
| `npm run status -- <org-slug>` | Balances, wallets, open invoices, ledger height |
| `npm run circle:doctor -- <org-slug>` / `agent:doctor` | Reports exactly which parts are live |
| `npm run arc:proof` | Standalone: two wallets, a faucet check, one real transfer |
| `npm run telegram:setup -- <https origin>` | Registers the Telegram bot's webhook and command menu, once the three `TELEGRAM_*` variables are set (see `.env.example`) |
| `npm run docs:screenshots` | Rebuilds the user guides’ step screenshots in `public/docs/guides/` with local headless Edge. Run it after changing a screen a guide shows (Go live, the counterparty or invoice form, a decision or approval card, the audit log), then look at each PNG before committing |

Seeded amounts scale down automatically when Circle credentials are present (`SEED_SCALE`),
because the public faucet grants 20 testnet USDC every two hours and a demo denominated in
thousands would never settle. The business narrative is the same; the decimal point moves.

One consequence is worth knowing before you demo: **with a few USDC idle, the agent declines to
sweep into USYC**, and it is right to. Here is the arithmetic, at testnet scale, with 2 USDC idle
above the buffer and nothing falling due that the buffer cannot pay:

```
idle above buffer     2.000000 USDC
expected hold days   30               (nothing calls the swept cash back within a month)
projected yield       0.005671 USD    (at USYC's 3.45% APY)
round-trip cost       0.00638  USD    (two transfers, at the measured Arc fee)
```

It holds, because sweeping would cost more than it earns. That is not a threshold someone
tuned — it is the arithmetic in `planTreasury`, which is why the same policy flips to sweeping
the moment the numbers justify it: with 118.59 USDC idle on the same terms, the month earns
about $0.336, fifty times the cost. Until October 3, 2026 the policy assumed every swept dollar
came back at the next obligation, so a 0.10 USDC bill due in two days cut that month to under
two days of yield (#1103 in testnet-2: about $0.018). It now counts how long each dollar would
actually stay. Run in simulate mode (`SEED_SCALE=1`, no Circle keys) to see
exactly that: the identical book scaled up 1000x sweeps 13,900 USDC. An agent that sweeps
regardless of whether sweeping pays is the cron job this project exists to not be. On Arc testnet,
with 60.71 USDC idle above its buffer, the same arithmetic swept for real on Oct 3, 2026:
the first transaction under **Real transactions** above.

The round-trip cost in that table used to read `0.02`, because the fee was a hardcoded `$0.01`
nobody had checked. Measuring it lowered the bar for sweeping by a factor of three — the agent
had been declining trades that were, in fact, worth making.

## What we measured

Everything on the landing page is queried from the database at request time, and every figure
below was produced by this agent executing real transfers on Arc testnet. None of it is quoted
from a documentation page, and simulated rows are excluded from every median the app reports.

| Figure | Measured | Source |
| --- | --- | --- |
| Transfer fee | **$0.003186** median, 4 samples | Arc receipt: `gasUsed × effectiveGasPrice` |
| Settlement time | **2.5 s** median, 4 samples | Circle's create → first-confirm timestamps |

Reading the fee is exact rather than approximate because of something specific to this chain:
**Arc's native gas token is USDC, at 18 decimals.** So `gasUsed × effectiveGasPrice / 1e18` is
the cost in dollars directly — no price oracle, no conversion, no question of when the quote was
taken. `src/lib/circle/arcFees.ts` does that against `rpc.testnet.arc.network`, and the
reconciliation pass backfills any transfer that settled before its receipt was readable.

This mattered more than a nicer number on a page. Circle's own `networkFeeInUSD` comes back empty
for Arc testnet — confirmed by re-fetching settled transactions long after confirmation — so the
app had no chain-reported fee at all and fell back to a hardcoded `$0.01`. That estimate was
roughly **3× the real cost**, and `planTreasury` prices a sweep-and-redeem round trip at twice the
fee, so the agent had been holding cash whose yield would comfortably have covered the real cost
of moving it. The simulator was wrong in the same direction: it generated 320–470 ms settlements
under a comment claiming it reproduced "Arc's real latency profile", against a measured 2–5 s.

Both constants are now calibrated from observation and carry the readings that set them
(`src/lib/circle/types.ts`). The lesson is the one the whole project is built around: figures you
assert about your own system drift, and figures you read do not.

## Going live on Arc testnet

The simulator and the real integration share one interface (`ChainProvider` in
`src/lib/circle/types.ts`), so switching is additive. A workspace's **owner** does it from the
**Go live** section at the top of **Settings** (`/o/<slug>/settings`), in three steps, each unlocked
by the one before:

1. **Connect Circle.** Paste an **API key** and the **entity secret** from the
   [Circle Console](https://console.circle.com). The server checks the key with Circle, then
   encrypts both onto the workspace's row in `orgs`; they are never shown again, logged, or sent
   back to the browser.
2. **Create treasury wallets.** One click creates, in your own Circle account, a wallet set and an
   Arc-testnet wallet for each account that has none, drops "(simulated)" from their names, and
   starts each new wallet's balance at zero: nothing simulated carries into live mode.
   Counterparties are paid only at a real address: set each one's address on the Counterparties
   page, or its payments are held.
3. **Go live.** Copy the operating wallet's address, fund it at
   [faucet.circle.com](https://faucet.circle.com) (select **Arc Testnet**; 20 USDC every 2 hours),
   and watch the on-chain balance in the same step. **Go live** asks for confirmation — real testnet
   USDC moves when the agent pays, the agent runs every 6 hours, and the workspace is no longer
   deleted when inactive — and then switches the workspace to `live`.

Every member sees the workspace's status there; only an owner sees the steps. Credentials can be
replaced later from the same section. Once the operating wallet exists, in any mode (sandbox or
live), new credentials are accepted only if they reach every one of the workspace's wallets, in
the Circle account that holds them; **Go live** checks the stored credentials the same way just
before switching. To stop a live workspace paying, pause the agent from the console.

**Hosted testnet wallets.** An owner without a Circle account can choose **Use a Vestiarion
testnet wallet** instead of step 1 (labelled "Hosted by Vestiarion · Arc testnet · no real
money"). Steps 2 and 3 are unchanged, except that the wallets are created in the platform's own
Circle testnet account, in a wallet set named for the workspace; the owner funds them from the
faucet as above. The choice is offered only where the deployment sets `HOSTED_CIRCLE_API_KEY` and
`HOSTED_CIRCLE_ENTITY_SECRET` (ideally a Circle testnet account separate from the founding
workspace's), and at most `HOSTED_WORKSPACE_LIMIT` workspaces (100 by default) may take it. Once a
workspace's wallets exist, its choice is fixed: to use your own Circle account, start a new
workspace.

### The founding workspace and the demo seed

The founding organization predates this flow, and the demo seed creates counterparty wallets too,
so both still go live with scripts:

1. Put the Circle **API key** and **Entity Secret** in `.env.local`, alongside a PKCS8 Ed25519
   `LEDGER_SIGNING_KEY` if the organization does not already have one stored.
2. `npm run org:adopt-env -- <org-slug> --expect-key-id <key id>` — encrypts the ledger signing
   key and Circle credentials onto that organization's row. From here the app reads them from
   `orgs`, never from `.env.local`.
3. `npm run circle:doctor -- <org-slug>` — confirms the key is accepted and the entity secret is
   registered.
4. `npm run seed -- <org-slug> && npm run bootstrap:circle -- <org-slug>` — creates a real
   Arc-testnet wallet for every treasury account *and* every counterparty, and writes the ids and
   addresses back to Supabase.
   Counterparties get wallets so the demo is verifiable: when the agent pays a contractor you can
   watch the USDC land at a real address. A real deployment stores the address the counterparty
   gives you instead.
5. Fund the operating wallet: [faucet.circle.com](https://faucet.circle.com), select **Arc
   Testnet**, 20 USDC every 2 hours. (The Console faucet API, `requestTestnetTokens`, returns 403
   on sandbox keys for Arc — the public faucet is the reliable route.)
6. Run a cycle. The dashboard header now reads *payments: Arc testnet (live)* and paid invoices
   carry a real transaction hash.

`npm run arc:proof` does steps 4–6 standalone — two wallets, a faucet check, and one real transfer
— if you want to verify the path without touching the app.

To exercise the red guardrail band without risking a payment,
`npm run fixture:guardrail -- <org-slug>` creates one explicitly labelled demo invoice for 0.9
USDC against a medium-risk 0.5 USDC screened limit. It feeds a model-style `pay` verdict through
the same `enforceApGuardrails` function used by the live orchestrator. Code changes the result to
held, records `guardrailBlocked: true`, and never calls a transfer provider. The command is
additive and idempotent; it is not part of normal setup.

### What is genuinely live, and what is not

The dashboard reports payments and yield separately because they differ, and the audit log records
which produced each entry:

- **Live** — wallet creation, USDC transfers, balances, transaction confirmation, all through
  Circle Developer-Controlled Wallets on Arc testnet.
- **Live once turned on** — the USYC reserve. The operating wallet deposits USDC through USYC's
  Teller contract on Arc testnet, the reserve wallet holds the USYC and redeems it, and the reserve
  is valued at USYC's latest price every cycle. USYC is permissioned, so Circle allowlists both
  wallets first, and an owner turns it on in **Settings → USYC reserve**. Until then the reserve is
  simulated, and labelled so.
- **Live when configured** — sanctions screening calls an OpenSanctions/yente match endpoint when
  `OPENSANCTIONS_API_URL` is set. Without it, the product explicitly labels the small bundled
  watchlist as simulated. Provider errors create an incomplete check and retain the previous
  verdict; they never silently clear a counterparty.

## Bringing your own business

Everything the agent reasons about lives in five tables (`accounts`, `counterparties`,
`invoices`, `milestones`, plus the ledger). To point Vestiarion at a real business:

- The workspace name shown in the product is the organization's own, `orgs.name` (the founding
  organization starts as "Vestiarion workspace"; `BUSINESS_NAME` no longer changes it). Add
  vendors, contractors, and clients on `/counterparties`. Their configured payment limit is stored
  separately from the authority derived by screening.
- Add payables or receivables on `/invoices`, or import up to 200 rows from CSV after inspecting a
  local preview. Amounts that cannot fit exact six-decimal USDC precision are rejected rather than
  rounded. Every accepted record is written to the signed ledger as a human action.
- Insert milestones with a real `verification_source` (a Git PR merge, a Kimai/Frappe timesheet
  entry, a client sign-off) and flip `verified` when that source confirms the work.
- Take the workspace live from **Settings → Go live** once real accounts exist, and fund the
  operating wallet. `POST /api/agent/tick`, called on a schedule (cron, GitHub Action, whatever you
  have), then runs its cycles instead of a button click.

### Running on a real clock

Production uses wall-clock mode by default; `CYCLE_CLOCK_MODE=simulate` is an explicit demo opt-in
that advances the numbered day counter. Every page shows the real timestamp of the latest completed
cycle. The included `.github/workflows/agent-cycle.yml` calls the protected endpoint every six
hours, and one call now runs a cycle for every workspace in `live` mode, not only yours — each in
its own isolated scope, so one workspace's failure is recorded against that workspace and does not
stop the others. Configure repository secrets `VESTIARION_URL` (the deployment origin) and
`AGENT_API_TOKEN` (the same server secret used by the app). GitHub Actions schedules can be delayed,
so the ledger timestamp—not the nominal cron minute—is the source of truth for when a cycle ran.
Sandbox workspaces are never in this list; their cycles run from the console, one **Run cycle**
click at a time, up to the daily cap above.

For automatic contractor evidence, put a full `https://github.com/<owner>/<repo>/pull/<number>` URL
in `verification_source` and configure a read-only `GITHUB_TOKEN`. A merged response verifies the
milestone; an unmerged response does not. Missing credentials and API failures are displayed as
unavailable or failed while retaining the prior verdict. An owner can instead add a manual
verification note, which is written to the signed ledger with `actor: human`.

### Measurement provenance

Every newly executed payment intent records its target, transaction reference, chain, provider
mode, execution timestamp, fee, fee source, and measured settlement time when Circle supplies
confirmation timestamps. `chain_reported` means Circle returned the fee; `provider_estimate`
means the configured Arc cost was used because it did not; `simulated_profile` is never presented
as live performance. A pending reconciliation has no settlement duration until confirmation.

Each completed post-Phase-7 cycle appends one `cycle_runs` row and one immutable
`cycle_snapshots` row with wall-clock timing, account balances, liquid and reserve positions, open
AP/AR, obligation horizons, outcome counts, model-versus-heuristic counts, guardrail overrides,
and provider modes. Existing cycles and transfers were intentionally not backfilled. Immediately
after instrumentation the configured project therefore reports **0 instrumented cycles, 0
snapshots, and 0 measured payment intents**. A payment-capable validation run was rejected by the
execution safety gate, so there is no measurement period or resulting benchmark to claim yet;
the first permitted agent cycle will populate these tables.

`/insights` reads only those persisted rows through `src/lib/insights.ts`. It does not
ship a sample series: transfer and cycle charts render an explicit empty receipt until
the first instrumented run. Screening history is drawn from `compliance_checks`; because
older checks do not carry a sweep id, the UI transparently groups consecutive checks
within two minutes as an observed batch rather than claiming a stronger association.

The public `/` landing page queries its statistics through `src/lib/landing.ts`. Instrumented
cycles and decisions come from `cycle_runs`; settled transfers and median settlement time come
from confirmed live `payment_intents`; median fee includes only `chain_reported` samples; ledger
height is an exact count of `ledger_entries`. A missing sample renders as unavailable prose rather
than a zero achievement. Every claim links to the console route that provides its evidence.

## Tests

```bash
npm run verify        # typecheck + lint + tests — what CI runs on every push
npm run test:watch    # while working
```

The suite covers the paths where being wrong costs money, and nothing else:

- **The ledger** — canonical JSON ordering, and every way a chain can be broken: content edited
  in place, a payment rewritten and the chain re-linked behind it with a forged key, an entry
  deleted, entries reordered, a chain that does not start at genesis, a forged link hash. Each
  must be caught by the *specific* check meant to catch it, so a passing chain cannot be an
  accident of two errors cancelling.
- **Risk tiering** — the property continuous re-screening depends on: screening the same
  counterparty twenty times leaves its limit exactly where one screening left it, and coming off
  the watchlist restores the full limit rather than leaving a false positive permanent.
- **Obligation accounting** — held and awaiting-information payables remain inside the 7- and
  14-day liquidity buffers until they are paid or explicitly rejected.
- **Execution guardrails** — a model `pay` verdict above a screened-down limit is converted to a
  refusal before the provider boundary, which is the exact case rendered by the demo probe.
- **Treasury economics** — that the policy is scale-free. The same book scaled down 1000x flips
  sweep to hold, and a more expensive chain flips it back, without a tuned constant anywhere.
- **Provider selection** — that a pinned provider with a missing key raises instead of quietly
  billing a different vendor, and that a rate-limited model falls back to the heuristic and is
  *recorded* as the heuristic rather than passed off as the model's judgement.

- **The database's half of the chain** — `append_ledger_entry()` is a Postgres function, so the
  link between one entry and the next is computed by the database, not by the code the other
  tests exercise. `tests/ledger-parity.test.ts` runs every migration, unmodified, on a real
  Postgres inside the test process (PGlite — Postgres compiled to WebAssembly), appends through
  the real function, and hands the rows it stored to the same `verifyChain()` the app uses. If
  the SQL and the verifier ever disagree about what a link is, this is the only test that turns
  red.

Nothing in the suite needs Supabase, Circle, or an LLM key — the Postgres above is in-process and
needs no server. Everything that does need a live service is exercised by
`npm run cycle -- <org-slug>` against a real project, which is the honest place for it, not a
mock that agrees with itself.

## Guardrails

The agent's system prompt (`src/lib/agent/orchestrator.ts`) is the enforced policy, not a
suggestion — the orchestrator re-checks risk level and payment limit *after* the LLM decides and
before executing a transfer, so a jailbroken or hallucinated "pay" decision on a flagged
counterparty is blocked in code, not just discouraged in the prompt (see the
`[guardrail override]` branch).

## License

MIT
