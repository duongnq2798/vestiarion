# Running Vestiarion yourself

How to run Vestiarion from this repository: local setup, the founding workspace, the scripts, the scheduled jobs,
and what is live and what is simulated. The [README](../README.md) says what the product is; the
[user guides](https://www.vestiarion.xyz/docs) say how to use the hosted app; [ARCHITECTURE.md](../ARCHITECTURE.md)
says how the code is put together.

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
first line of its ledger. One person can create up to 3 workspaces this way on each network, Arc
testnet and Arc mainnet counted apart; a setup that fails partway
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
workspace live from **Settings** — see [Going live](#going-live).

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
me when payments need a decision" — in the Notifications section of Settings, on by default; this
needs `RESEND_API_KEY` too.

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
| `npm run traction-digest -- <org-slug> --since YYYY-MM-DD` | That workspace's shadow mode decisions since the day: each verdict, what it paid with its Arc testnet transaction ("Paid later by a person" on a decision not to pay), and the agreement rate, in ASCII with no blank line for a traction post. `--hide-payees` names each supplier by a letter |
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
the USYC deposit listed under **Proof on Arc testnet** in the [README](../README.md#proof-on-arc-testnet).

The round-trip cost in that table used to read `0.02`, because the fee was a hardcoded `$0.01`
nobody had checked. Measuring it lowered the bar for sweeping by a factor of three — the agent
had been declining trades that were, in fact, worth making.

## What we measured

Everything on the landing page and on [Open numbers](https://www.vestiarion.xyz/open) is queried
from the database at request time, from transfers this agent executed. None of it is quoted from a
documentation page, and simulated rows are excluded from every median the app reports. The first
readings, from 4 transfers on Arc testnet, set the simulator's constants:

| Figure | First reading | Source |
| --- | --- | --- |
| Transfer fee | **$0.003186** median | Arc receipt: `gasUsed × effectiveGasPrice` |
| Settlement time | **2.5 s** median | Circle's create → first-confirm timestamps |

Reading the fee is exact rather than approximate because of something specific to this chain:
**Arc's native gas token is USDC, at 18 decimals.** So `gasUsed × effectiveGasPrice / 1e18` is
the cost in dollars directly — no price oracle, no conversion, no question of when the quote was
taken. `src/lib/circle/arcFees.ts` does that against the workspace's network's RPC, and the
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

## Going live

The simulator and the real integration share one interface (`ChainProvider` in
`src/lib/circle/types.ts`), so switching is additive. A workspace's **owner** does it from the
**Go live** section of **Settings** (`/o/<slug>/settings`, under **Workspace**), in three steps, each unlocked
by the one before:

1. **Connect Circle.** Paste an **API key** and the **entity secret** from the
   [Circle Console](https://console.circle.com). The key must be for the workspace's network: a
   testnet key (`TEST_API_KEY`) for an Arc testnet workspace, so a mainnet key is refused before
   anything is stored. The server checks the key with Circle, then encrypts both onto the
   workspace's row in `orgs`; they are never shown again, logged, or sent back to the browser.
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
testnet wallet** instead of step 1 (labelled "Hosted by Vestiarion · Arc testnet"). Steps 2 and 3 are unchanged, except that the wallets are created in the platform's own
Circle testnet account, in a wallet set named for the workspace; the owner funds them from the
faucet as above. The choice is offered only where the deployment sets `HOSTED_CIRCLE_API_KEY` and
`HOSTED_CIRCLE_ENTITY_SECRET` (ideally a Circle testnet account separate from the founding
workspace's), and at most `HOSTED_WORKSPACE_LIMIT` workspaces (100 by default) may take it. Once a
workspace's wallets exist, its choice is fixed: to use your own Circle account, start a new
workspace.

**Arc mainnet, behind a switch.** A deployment opens Arc mainnet with `MAINNET_ENABLED=1`, and only
to the email addresses in `MAINNET_ALLOWLIST`, or to everyone with `MAINNET_ALLOWLIST=*` once a
pilot is done; an empty allowlist opens it to no one. Such a person can create a workspace on Arc mainnet
from the workspaces page. It starts with one empty operating account and an agent spending limit of
50 USDC a day and 150 USDC in 7 days, and it never simulates.

It also starts with two approvals above 100 USDC, which an owner can raise but not turn off there.

Its three steps take a live Circle key (`LIVE_API_KEY`) and create one EOA wallet on `ARC`. That
wallet pays its own gas in USDC, so 0.10 USDC is kept aside. Going live needs the word `mainnet`
typed. Every page and message of the workspace names Arc mainnet, from the network profile's label,
and a panel for a feature Arc mainnet lacks is not drawn. Until a workspace is live, and whenever
the deployment switches Arc mainnet off, nothing moves: the stop switch's gates refuse with the reason.

**Paying from the owner's own wallet.** Where the deployment sets `MAINNET_AGENT_CIRCLE_API_KEY` (a
production key, `LIVE_API_KEY:…`) and `MAINNET_AGENT_CIRCLE_ENTITY_SECRET`, step 1 of an Arc mainnet
workspace offers **Your own wallet** first. The owner's browser wallet (MetaMask, Rabby…) signs a proof,
deploys the workspace's spending limit contract, approves it on USDC, and sends 0.50 USDC of gas to an
agent wallet Vestiarion creates for the workspace in that Circle account. The agent wallet holds only
gas: every payment, the agent's and the ones people approve, goes through the contract from it, within
the figures the owner's wallet set. Vestiarion never holds the customer's USDC, and the customer needs
no Circle account. Use a Circle production account kept for agent wallets alone, with its Wallets
product unlocked. `ARC_MAINNET_RPC_URL`, optional, points the server's chain reads at a keyed RPC. See
`docs/superpowers/specs/2026-10-07-wallet-treasury-design.md` and the Go live guide's path C.

**A passkey wallet as the treasury.** Where the deployment also sets
`NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_KEY` (a Circle mainnet Client Key bound to the site's
domain; `NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_URL` is optional), an owner with no browser wallet
creates one with a passkey: a Circle smart account on Arc mainnet owned by their passkey. Go live leads
with it when the browser has no wallet. One confirmation deploys the contract through the deterministic
deployment proxy, approves it and sends the agent its gas, after the browser checks every call against
what it built itself; a recovery phrase made in the browser is then registered, or skipped knowingly.
Vestiarion holds no key to the wallet. A client key is public by design, so it is not marked sensitive.
See `docs/superpowers/specs/2026-10-07-passkey-treasury-design.md`.

Stablecoins are chosen by contract, never by symbol, on both networks. Chats cannot approve a
mainnet payment. See `docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md`.

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

- **Live** — wallet creation, USDC transfers, balances, transaction confirmation, through
  Circle Developer-Controlled Wallets on Arc testnet, and on Arc mainnet where the deployment opens
  it. On Arc mainnet a workspace can instead pay from its owner's own wallet or passkey wallet,
  through its spending limit contract (see [Going live](#going-live)).
- **Live once turned on** — the USYC reserve. The operating wallet deposits USDC through USYC's
  Teller contract on Arc testnet, the reserve wallet holds the USYC and redeems it, and the reserve
  is valued at USYC's latest price every cycle. USYC is permissioned, so Circle allowlists both
  wallets first, and an owner turns it on in **Settings → USYC reserve**. Until then the reserve is
  simulated, and labelled so.
- **Live when configured** — sanctions screening calls an OpenSanctions/yente match endpoint when
  `OPENSANCTIONS_API_URL` is set. Without it, a sandbox screens against the small bundled
  watchlist, labelled as simulated, and a live workspace gets no verdict at all: its
  counterparties stay unscreened, and the agent pays them nothing. Provider errors create an
  incomplete check and retain the previous verdict; they never silently clear a counterparty.

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
cycle. Supabase Cron calls the protected endpoint every six hours, at 17 minutes past (see below),
and one call runs a cycle for every workspace in `live` mode, not only yours — each in its own
isolated scope, so one workspace's failure is recorded against that workspace and does not stop
the others. The included `.github/workflows/agent-cycle.yml` stays for a manual run: configure
repository secrets `VESTIARION_URL` (the deployment origin) and `AGENT_API_TOKEN` (the same server
secret used by the app). The ledger timestamp, not the nominal cron minute, is the source of truth
for when a cycle ran.
Sandbox workspaces are never in this list; their cycles run from the console, one **Run cycle**
click at a time, up to the daily cap above.

Four jobs must run on time, which GitHub's schedules do not do: they started a 5-minute schedule
only a few times a day, and the six-hourly tick 2 to 4 times a day at uneven hours. A daily
recurring payment's invoice is made by the first cycle of its due day, so a skipped tick left it
waiting. Supabase Cron runs them from the database instead:

- `POST /api/agent/tick`, at 17 minutes past every sixth hour: a cycle for every live workspace.
- `POST /api/agent/fx-watch`, every 5 minutes: a EURC payable held because Circle quoted no rate or
  no swap, or one above its swap cap or limit, is decided again once a fresh quote clears it, with no
  one pressing anything. A run with nothing to re-check starts no cycle.
- `POST /api/agent/transfer-watch`, every 5 minutes: a live payment not confirmed 15 minutes after it
  was sent is told to the workspace's people, once per attempt, in the console, Slack, Telegram,
  webhooks and by email. It sends nothing.
- `POST /api/platform/webhooks`, every 10 minutes: webhook retries and anything still queued.

To set them up, run `supabase/cron/watches.sql` once in the Supabase SQL editor, with your
deployment's origin in place of `https://www.vestiarion.xyz`. Its header lists what comes first:
enable `pg_cron` and `pg_net`, and add `AGENT_API_TOKEN` to Vault as `agent_api_token`. Each job's
workflow (`agent-cycle.yml`, `fx-watch.yml`, `transfer-watch.yml`, `webhooks.yml`) stays for a manual run.

Circle also tells the deployment when a transfer settles, at `POST /api/circle/notifications`. On a
subscribed account, while the agent runs, a payment confirmed after the agent stopped waiting for it
is recorded within seconds rather than at the next cycle; money arriving in an operating wallet is
read at once, and starts a cycle only when it paid a receivable. On the production deployment
(`VERCEL_ENV=production`), a workspace that connects its own Circle account subscribes it as it
connects. Once that deployment is live, run `npm run circle:subscribe` once for the platform's hosted
Circle account (from `HOSTED_CIRCLE_API_KEY` and `HOSTED_CIRCLE_ENTITY_SECRET`), for the Arc
mainnet agent account (from `MAINNET_AGENT_CIRCLE_API_KEY` and `MAINNET_AGENT_CIRCLE_ENTITY_SECRET`)
and for accounts connected before: Circle makes a subscription only after the endpoint answers its test notification.
It finds or makes one subscription per account and prints each result, never a key.

For automatic contractor evidence, put a full `https://github.com/<owner>/<repo>/pull/<number>` URL
in `verification_source` and configure a read-only `GITHUB_TOKEN`. A merged response verifies the
milestone; an unmerged response does not. Missing credentials and API failures are displayed as
unavailable or failed while retaining the prior verdict. An owner can instead add a manual
verification note, which is written to the signed ledger with `actor: human`.

With the five `GITHUB_APP_*` variables set (see `.env.example`), a workspace can also connect
GitHub from Settings by installing the platform's GitHub App on the repositories it chooses.
A milestone paid for a pull request there then gets a comment on that pull request once the
payment is confirmed: the amount, the network, the paying workspace and the transaction, never the
payee. The installation's own token reads its private pull requests, so they verify too. With the
app's webhook on and `GITHUB_APP_WEBHOOK_SECRET` set, a maintainer attaches a bounty from the pull
request itself with `/bounty 25`, and its author says where to be paid with `/payto 0x…`; the agent
pays once the pull request is merged and a member has confirmed the address. See
[Show payments on GitHub](https://www.vestiarion.xyz/docs/guides/github).

### Measurement provenance

Every newly executed payment intent records its target, transaction reference, chain, provider
mode, execution timestamp, fee, fee source, and measured settlement time when Circle supplies
confirmation timestamps. `chain_reported` means Circle returned the fee; `provider_estimate`
means the configured Arc cost was used because it did not; `simulated_profile` is never presented
as live performance. A pending reconciliation has no settlement duration until confirmation.

Each completed post-Phase-7 cycle appends one `cycle_runs` row and one immutable
`cycle_snapshots` row with wall-clock timing, account balances, liquid and reserve positions, open
AP/AR, obligation horizons, outcome counts, model-versus-heuristic counts, guardrail overrides,
and provider modes. Cycles and transfers from before this instrumentation were intentionally not
backfilled, so counts start there; [Open numbers](https://www.vestiarion.xyz/open) shows the current ones.

`/insights` reads only those persisted rows through `src/lib/insights.ts`. It does not
ship a sample series: a chart with no rows behind it renders an explicit empty receipt. Screening history is drawn from `compliance_checks`; because
older checks do not carry a sweep id, the UI transparently groups consecutive checks
within two minutes as an observed batch rather than claiming a stronger association.

The public `/` landing page shows the open numbers, read through the same aggregate functions as
`/open` (`src/lib/platform/open-numbers.ts`): Arc mainnet and Arc testnet each on its own, customers'
workspaces apart from the team's, all time. Its hero calls the USYC reserve live once any live
workspace runs a real one, a count over `orgs.usyc_live_at`. A network whose numbers cannot be read
says so rather than showing a zero, and every live claim links to what shows it: an explorer
transaction, `/open`, or the research note.


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

## Stopping every payment

Payments can be stopped for every workspace at once: `npm run payments -- off "<reason>"` stops
them within 10 seconds on every running deployment, and `npm run payments -- on` starts them again.
`PAYMENTS_DISABLED=1` on the deployment does the same after a redeploy. Nothing then moves money,
the agent runs no cycle, and every workspace page says so, while reads keep working. A payment whose
send Circle did not answer is looked for on Circle before anything is sent again, so it is never
paid twice or closed over. An Arc address typed into the console or sent to the API must match its
EIP-55 checksum when it mixes capital and small letters
(`docs/superpowers/specs/2026-10-05-payment-safety-design.md`).
