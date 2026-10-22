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
| `npm run screening:check -- "<name>"` | Screens one name with the screening provider the environment names, to check a key before it is set; never prints the key. On the deployment itself, **Check now** on `/admin/screening` does the same (see [Changing the screening key](#changing-the-screening-key)) |
| `npm run arc:proof` | Standalone: two wallets, a faucet check, one real transfer |
| `npm run telegram:setup -- <https origin>` | Registers the Telegram bot's webhook and command menu, once the three `TELEGRAM_*` variables are set (see `.env.example`) |
| `npm run docs:screenshots` | Rebuilds the user guides’ step screenshots in `public/docs/guides/` with local headless Edge. Run it after changing a screen a guide shows (Go live, the counterparty or invoice form, a decision or approval card, the audit log), then look at each PNG before committing |

These scripts work on the database, as its operator. To work with one workspace through its API instead, from any
machine, use the [`vestiarion` command](https://www.vestiarion.xyz/docs/get-started/cli) with a key from that workspace
and your deployment as its base URL: `vestiarion login --base-url https://vestiarion.example.com`.

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
- **Live when configured** — sanctions screening calls the provider the deployment names:
  - `SCREENING_PROVIDER=opensanctions` with `SCREENING_API_KEY`: OpenSanctions' hosted API
    (`SCREENING_API_URL` defaults to `https://api.opensanctions.org`);
  - `SCREENING_PROVIDER=yente` with `SCREENING_API_URL`: a self-hosted
    [yente](https://www.opensanctions.org/docs/yente/) server, with `SCREENING_API_KEY` only if it
    asks for one.

  Both are asked the same match query and judged by the same rules; each verdict records which
  one gave it (`opensanctions:yente` or `yente:self-hosted`). A provider named without what it
  needs, or an address or key set without `SCREENING_PROVIDER`, stops the app at start. The older
  `OPENSANCTIONS_API_URL` and `OPENSANCTIONS_API_KEY` still work when none of the `SCREENING_*`
  names is set: a URL alone screens with OpenSanctions at that address. The two sets never mix, so
  a key only goes to the address set beside it. Before setting a new key,
  check it with `npm run screening:check -- "Zenith Trading LLC"`, which screens one name and
  prints the verdict, the best matches and how long it took, never the key.

  Without a provider, a sandbox screens against the small bundled watchlist, labelled as
  simulated, and a live workspace gets no verdict at all: its counterparties stay unscreened, and
  the agent pays them nothing. Provider errors create an incomplete check and retain the previous
  verdict; they never silently clear a counterparty. When a live workspace's newest lookup failed,
  its header says **Live, last lookup failed** instead of **Live**, and owners and admins see on
  Compliance when a live lookup last worked.

### Changing the screening key

A key that stops working breaks nothing loudly: every live lookup fails with HTTP 401 or 403,
existing counterparties keep their last verdict, and new ones stay unscreened. To change it:

1. Check the new key on your machine first: put it in `.env.local` in place of the old one, then
   run `npm run screening:check -- "Zenith Trading Example LLC"`. It prints the provider, the
   address's origin, whether a key is set and the verdict, exits 0 when the lookup worked, and
   never prints the key.
2. Replace only the value of `OPENSANCTIONS_API_KEY` in the deployment's Production environment
   (on Vercel, mark it Sensitive), keeping `OPENSANCTIONS_API_URL` as it is. Setting any
   `SCREENING_*` variable alone switches to the new set and fails at start, taking every page with
   it; a deployment on the new names replaces `SCREENING_API_KEY` instead.
3. Redeploy: the configuration is read once per server instance, so the old key is sent until a
   new deployment runs. Reload open tabs afterwards.
4. Open `/admin/screening` as a person on `platform_team` and press **Check now**. It screens the
   fictitious company "Zenith Trading Example LLC" with the deployment's own provider and key, and
   shows the provider, the origin, whether a key is set, which variables are in use, OK or the HTTP
   status, the time and the verdict. It adds no counterparty, writes no compliance check and
   nothing to any ledger. So it does not clear what the failure left behind: a live workspace's
   header keeps saying **Live, last lookup failed**, and its Compliance page keeps the old "Last
   successful live screening" time, until that workspace's next live lookup. That is its next
   agent cycle: a change starts one, the schedule runs one every 6 hours, or press **Run cycle
   now** in the agent controls. Until then, a stale header is not a failed rotation; the Check now
   result and the log line in step 5 are the proof. The page also shows the last complete and last
   failed live lookup across workspaces, once migration 0139 has run; those too move only with the
   next lookups. A verdict on a payout address on OFAC's list calls no provider, so none of these
   count it.
5. Read the deployment's logs (`vercel logs`): each check writes one line, `screening check:
   provider=… origin=… ok=… status=… ms=…`, never the key or the full address. Look for no
   `ConfigError` after the deploy.

Never print the key, in a terminal, a log or a message.

## Bringing your own business

Everything the agent reasons about lives in five tables (`accounts`, `counterparties`,
`invoices`, `milestones`, plus the ledger). To point Vestiarion at a real business:

- The workspace name shown in the product is the organization's own, `orgs.name` (the founding
  organization starts as "Vestiarion workspace"; `BUSINESS_NAME` no longer changes it). Add
  vendors, contractors, and clients on `/counterparties`. Their configured payment limit is stored
  separately from the authority derived by screening.
- Add payables or receivables on `/invoices`, or import up to 200 rows from a CSV file or rows
  pasted from a spreadsheet, in its own columns, dates and number format, after checking every
  row's fate on the server. Amounts are kept exact, never rounded: an amount with more decimals than
  its currency takes is refused. Every accepted record is written to the signed ledger as a human
  action.
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

Each sweep also checks payout addresses against OFAC's SDN list. A production deployment (`VERCEL_ENV=production`)
reads the Treasury's files every 12 hours, and anywhere else the snapshot in `src/lib/data/ofac-sdn-evm-wallets.json`
answers. Set `SANCTIONED_WALLETS=live` to read them on your deployment. Refresh the snapshot with
`node scripts/ofac-sdn-wallets.mjs <SDN.CSV> <SDN_COMMENTS.CSV>`.

Seven jobs must run on time, which GitHub's schedules do not do: they started a 5-minute schedule
only a few times a day, and the six-hourly tick 2 to 4 times a day at uneven hours. A daily
recurring payment's invoice is made by the first cycle of its due day, so a skipped tick left it
waiting. Supabase Cron runs them from the database instead:

- `POST /api/agent/tick`, at 17 minutes past every sixth hour: a cycle for every live workspace.
- `POST /api/agent/due-watch`, every 5 minutes: a cycle where work became due only because time passed. That is a
  scheduled cycle the tick missed in a workspace, 15 minutes after the tick's time, or the end of a payee lock's wait on
  a confirmed address that holds a payable or a verified milestone back. A run with nothing due starts no cycle.
  It takes the tick to run at 17 minutes past every sixth hour (`src/lib/agent/tick-schedule.ts`): if you schedule the
  tick at another time, change that file to match, or the watch runs a second scheduled cycle every period.
- `POST /api/agent/fx-watch`, every 5 minutes: a EURC payable held because Circle quoted no rate or
  no swap, or one above its swap cap or limit, is decided again once a fresh quote clears it, with no
  one pressing anything. A run with nothing to re-check starts no cycle.
- `POST /api/agent/transfer-watch`, every 5 minutes: a live payment not confirmed 15 minutes after it
  was sent is told to the workspace's people, once per attempt, in the console, Slack, Telegram,
  webhooks and by email. It sends nothing.
- `POST /api/platform/webhooks`, every 10 minutes: webhook retries and anything still queued.
- `POST /api/platform/accounting-sync`, every 15 minutes: bills from the Xero organisations, QuickBooks companies and
  Zoho Books organizations workspaces connected, deals from the HubSpot accounts, Pipedrive companies and Zoho CRM
  organizations they connected, and the connections nobody finished choosing an organisation for, revoked and deleted.
- `POST /api/platform/fx-rates`, every hour at 41 minutes past: the day's reference rates for each workspace that
  reports or plans in another currency, and the FX variance of each paid bill whose payment-day rate is then recorded.

To set them up, run `supabase/cron/watches.sql` once in the Supabase SQL editor, with your
deployment's origin in place of `https://www.vestiarion.xyz`. Its header lists what comes first:
enable `pg_cron` and `pg_net`, and add `AGENT_API_TOKEN` to Vault as `agent_api_token`. Each job's
workflow (`agent-cycle.yml`, `due-watch.yml`, `fx-watch.yml`, `transfer-watch.yml`, `webhooks.yml`,
`accounting-sync.yml`, `fx-rates.yml`) stays for a manual run.

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

With `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET` set, from a Xero app of type "Web app" whose redirect URI is
`<origin>/api/integrations/xero/callback` (and `http://localhost:3000/api/integrations/xero/callback` to try it
locally), an owner or admin connects a workspace to one Xero organisation from Settings, after agreeing to what
Vestiarion does with its data. Its approved bills come in for review on Bills & receivables, through the same check as a
bill list, and become payables only when a person adds them. Once such a bill is paid on Arc, its payment is drafted as
a booking against the bill, and booked in Xero only after an owner or admin approves it on Bills & receivables; a payment
on Arc testnet or in shadow mode is booked only into a Xero demo company. The app asks Xero for read scopes and one write
scope (`offline_access accounting.invoices.read accounting.contacts.read accounting.settings.read accounting.payments`):
a Xero app made after 2 March 2026 has no broad accounting scopes, and a connection made before `accounting.payments`
was asked for reconnects from its card to allow booking. Xero's free Starter tier holds five connected organisations.
The connection needs migration 0101, and booking needs 0106; before they run, the Xero card says Xero is not set up yet,
and the bookings are not shown. Its tokens are kept encrypted under
`VESTIARION_MASTER_KEYS`, in a table only the service role reads. The sync runs every 15 minutes (above), and
**Sync now** runs one at once. See [Bring bills in from Xero](https://www.vestiarion.xyz/docs/guides/xero).

With `QUICKBOOKS_CLIENT_ID` and `QUICKBOOKS_CLIENT_SECRET` set, from an Intuit app with the scope
`com.intuit.quickbooks.accounting` and the redirect URI `<origin>/api/integrations/quickbooks/callback` (and
`http://localhost:3000/api/integrations/quickbooks/callback` to try it locally), an owner or admin connects a
workspace to one QuickBooks Online company the same way, and its open bills come in for review beside Xero's. A
company connects to one workspace at a time: disconnecting the app ends its access for every grant. Set the app's
Launch URL to `<origin>/integrations/quickbooks`, its Connect/Reconnect URL to `<origin>/integrations/quickbooks/connect`
and its Disconnect URL to `<origin>/integrations/quickbooks/disconnected`, which marks a connection disconnected only
once QuickBooks confirms it no longer accepts it. `QUICKBOOKS_ENVIRONMENT` is `sandbox` (the default) for Development
keys and sandbox companies, or `production` for Production keys, which need Intuit's app assessment first. With
`QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN` set, Intuit's webhook at `<origin>/api/integrations/quickbooks/webhook` (CloudEvents
payload format, subscribed to Bill, BillPayment and Vendor at least) starts a sync of the company's connection within
a minute of a change; without it, changes come in with the 15-minute sync alone. The connection needs migrations 0101
and 0102. See [Bring bills in from QuickBooks Online](https://www.vestiarion.xyz/docs/guides/quickbooks).

With `ZOHO_BOOKS_CLIENT_ID` and `ZOHO_BOOKS_CLIENT_SECRET` set, from a Zoho "Server-based Applications" client made at
`api-console.zoho.com` whose Authorized Redirect URIs are `<origin>/api/integrations/zohobooks/callback` (and
`http://localhost:3000/api/integrations/zohobooks/callback` to try it locally), an owner or admin connects a workspace
to one Zoho Books organization the same way, and its open bills come in for review beside Xero's and QuickBooks'. The
client id is in Zoho's form, `1000.` and capital letters and digits; any other value leaves Zoho Books off. A Zoho
account lives in one data center, so on the client's Settings tab turn on each one you serve (US, EU, India, Australia,
Japan, UK, Canada, Saudi Arabia, UAE) and tick "Use the same OAuth credentials for all data centers"; a person in a data
center not turned on cannot sign in to connect, and China's is not offered. Vestiarion takes the data center from
Zoho's callback, checks it against its own list, and sends the code, the client secret and every token only to that data
center's servers. The app asks for read scopes only (`ZohoBooks.bills.READ ZohoBooks.contacts.READ
ZohoBooks.settings.READ`) and writes nothing to Zoho Books. A person who can reach several organizations picks one on
the connect page, and several workspaces may connect the same organization. Zoho Books has no API to register a
webhook, so its bills come in with the 15-minute sync and **Sync now**, and a bill deleted in Zoho Books is not seen.
Zoho Books has no sandbox: try it with a free or trial organization. The connection needs migration 0122; before it
runs, connecting says Zoho Books is not set up on this deployment yet. See
[Bring bills in from Zoho Books](https://www.vestiarion.xyz/docs/guides/zohobooks).

With `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET` set, from a HubSpot app on the developer platform with OAuth and
marketplace distribution, an owner or admin connects a workspace to one HubSpot account from Settings, after agreeing to
what Vestiarion does with its data. Its won deals come in with their customers under Deals on Bills & receivables, and a
person plans each one's collections from the New deal form filled in from it. One HubSpot account connects to one
workspace at a time. The app asks for read scopes (`oauth crm.objects.companies.read crm.objects.contacts.read
crm.objects.deals.read`), exactly the required scopes of its config. Writing receipts back to the deals planned from
HubSpot is off until an owner or admin allows it from the card: only then does the connect page ask for the config's
optional scopes, `crm.objects.deals.write` and `crm.schemas.deals.write`, and Vestiarion adds a `vestiarion` group of
deal properties once. Payments on Arc testnet or in shadow mode are written only to a HubSpot developer test account or
sandbox. The connection needs migration 0105, and writing needs 0107; before 0105 runs, the HubSpot card says HubSpot is
not set up yet, and before 0107 it offers no writing. Its tokens are kept encrypted under `VESTIARION_MASTER_KEYS`, as
Xero's. See [Bring deals in from HubSpot](https://www.vestiarion.xyz/docs/guides/hubspot).

The app's config is in the repository, under `integrations/hubspot/` (`hsproject.json` and `src/app/app-hsmeta.json`):
its name, its distribution, its scopes and its redirect URLs (`<origin>/api/integrations/hubspot/callback`, and
`http://localhost:3000/api/integrations/hubspot/callback` to try it locally). It holds no secret. To create or change the
app, install the HubSpot CLI and upload the project from that folder:

```sh
npm install -g @hubspot/cli
hs account auth            # sign in to the HubSpot developer account that owns the app
cd integrations/hubspot
hs project upload          # builds and deploys the app from hsproject.json
```

Then, in HubSpot's developer account, open the app's **Auth** tab for its client id and secret, and set them as
`HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET`. A deployment on another origin edits the redirect URLs in
`app-hsmeta.json` and uploads again: HubSpot refuses a redirect URL the config does not list, and an authorize URL whose
scopes differ from the config's required scopes.

With `PIPEDRIVE_CLIENT_ID` and `PIPEDRIVE_CLIENT_SECRET` set, from a private app made in Pipedrive's Developer Hub, an
owner or admin connects a workspace to one Pipedrive company from Settings, after agreeing to what Vestiarion does with
its data. Its won deals come in with their organizations and persons under Deals on Bills & receivables, and a person
plans each one's collections from the New deal form filled in from it. One Pipedrive company connects to one workspace
at a time. In Developer Hub, set the app's Callback URL to `<origin>/api/integrations/pipedrive/callback` (Pipedrive also
sends its uninstall notice there) and its scopes to `deals:full`, `contacts:read`, `deal-fields:full`, `users:read`,
`recents:read` and `webhooks:full` (with `base`, always on): a person accepts all of them or none, and a grant without
the scopes that read deals and organizations is refused. Each token is kept encrypted under `VESTIARION_MASTER_KEYS`
together with the company's own API domain that Pipedrive named with it, and is only ever sent there. On connecting and on
Sync now, Vestiarion registers a webhook for the company's deals at `<origin>/api/integrations/pipedrive/webhook`, with
HTTP Basic auth derived from the master key; a notice only starts a sync, and a deployment on localhost registers none,
so changes there come in with the 15-minute sync alone. Writing receipts back to the deals planned from Pipedrive is off
until an owner or admin turns it on from the card; Vestiarion then adds nine "Vestiarion: …" custom deal fields once.
Pipedrive's API says nothing that tells a developer sandbox from a real company, so payments on Arc testnet or in shadow
mode are never written to Pipedrive. The connection needs migrations 0116 and 0117 (after 0105 and 0107); before they run,
the Pipedrive card says Pipedrive is not set up yet. See [Bring deals in from Pipedrive](https://www.vestiarion.xyz/docs/guides/pipedrive).

Zoho CRM uses the same Zoho client as Zoho Books (above): with `ZOHO_BOOKS_CLIENT_ID` and `ZOHO_BOOKS_CLIENT_SECRET`
set, add `<origin>/api/integrations/zohocrm/callback` (and `http://localhost:3000/api/integrations/zohocrm/callback` to
try it locally) to the client's Authorized Redirect URIs, and an owner or admin connects a workspace to one Zoho CRM
organization from Settings, after agreeing to what Vestiarion does with its data. Its won deals come in with their
accounts and contacts under Deals on Bills & receivables, and a person plans each one's collections from the New deal
form filled in from it. To give Zoho CRM a client of its own, set both `ZOHO_CRM_CLIENT_ID` and `ZOHO_CRM_CLIENT_SECRET`
(the same id form and data center settings as Zoho Books'); they take the place of the Zoho Books pair for Zoho CRM
alone. The data centers work as for Zoho Books: Vestiarion takes the account's data center from Zoho's callback, checks
it against its own list, and sends the code, the client secret, every token and every API call only to that data
center's servers. The app asks for read scopes only (`ZohoCRM.modules.deals.READ ZohoCRM.modules.accounts.READ
ZohoCRM.modules.contacts.READ ZohoCRM.org.READ ZohoCRM.settings.layouts.READ ZohoCRM.settings.pipeline.READ`) and
writes nothing to Zoho CRM, so it has no receipts switch. A deal is won when the Deals pipelines give its stage the
forecast type Closed Won, or, where they cannot be read, when the stage is named Closed Won. Several workspaces may connect the same organization. Zoho CRM's Developer Edition and sandboxes are not read in this
version, and no webhook is registered: deals come in with the 15-minute sync and **Sync now**. The connection needs
migration 0123 (after 0105); before it runs, the card says Zoho CRM is not set up on this deployment yet. See
[Bring deals in from Zoho CRM](https://www.vestiarion.xyz/docs/guides/zohocrm).

With `BLINDPAY_API_KEY` and `BLINDPAY_INSTANCE_ID` set, from a BlindPay instance, an owner sets a workspace up for bank
payouts from Settings, accepting BlindPay's terms on BlindPay's page, and an owner or admin gives a vendor its CLABE on
Counterparties; that vendor's bills are then paid to its bank account in Mexico in pesos over SPEI, from the workspace's
USDC, and a person approves every bank payout. Use a development instance in this version: a workspace is set up with
BlindPay's test business values, and BlindPay approves it and runs each payout in its sandbox. On Arc testnet BlindPay is
paid on `arc_testnet` with its USDB test token, and on Arc mainnet on `arc` with USDC; `BLINDPAY_NETWORK` and
`BLINDPAY_TOKEN` pay it on another network BlindPay names. Add a webhook in BlindPay at
`<origin>/api/integrations/blindpay/webhook` for the `payout.*` events and set its signing secret as
`BLINDPAY_WEBHOOK_SECRET`: a notice is accepted only under that Svix signature, within five minutes, and only starts a
cycle that reads the payout from BlindPay. The connection needs migration 0124; before it runs, the Bank payouts card
says bank payouts are not set up on this deployment yet. See [Pay a vendor's bank account in
Mexico](https://www.vestiarion.xyz/docs/guides/bank-payouts).

With `ASANA_CLIENT_ID` and `ASANA_CLIENT_SECRET` set, from an Asana OAuth app distributed to any workspace, an owner or
admin connects a workspace to their Asana from Settings, after agreeing to what Vestiarion does with its data. A person
links a milestone to the Asana task its work is delivered in, writes the acceptance criteria from the agreement, and
accepts the work once the task is completed; a completed task alone never verifies a milestone. Register the redirect URL
`<origin>/api/integrations/asana/callback` exactly, and the scopes `workspaces:read projects:read tasks:read
attachments:read stories:read users:read webhooks:read webhooks:write webhooks:delete`: the authorize URL asks for exactly
these. Webhooks are made on linked tasks only when the origin is https, at `<origin>/api/integrations/asana/webhook/<id>`;
without them a linked task is read again before each agent cycle once accepted, and every 15 minutes by the accounting
sync. The connection needs migration 0115; before it runs, the Asana card says Asana is not set up yet. Its tokens and
each webhook's secret are kept encrypted under `VESTIARION_MASTER_KEYS`. See [Accept contractor work from
Asana](https://www.vestiarion.xyz/docs/guides/asana).

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
needs no server. It runs on UTC, as Supabase does, whatever the machine's time zone, so a check
against `current_date` passes or fails the same on every machine and at every hour. Everything that does need a live service is exercised by
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
