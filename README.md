# Vestiarion

An autonomous treasury agent for a small business, settled in USDC on Arc.

Built for the [Tameion Agents Hackathon](https://tameion.thecanteenapp.com) (Canteen × Circle).

> *Tameion* is ancient Greek for a treasury — literally the room the money was kept in. In
> Byzantium that room grew into the *vestiarion*, the department that minted the coin, held the
> stores, and paid the army. Vestiarion is the same idea in software: **one agent that runs a
> company's entire money cycle** — pays vendors, releases contractor pay, screens counterparties,
> and puts idle cash to work — instead of five disconnected tools a person stitches together by
> hand on a Tuesday.

## What it does

Vestiarion runs a configured business's treasury through one decision loop, the **agent cycle**.
`BUSINESS_NAME` controls the identity shown in the product; no customer name is hard-coded into
the interface:

1. **Compliance (RFB5)** — the whole counterparty book is re-screened every cycle, not checked
   once at onboarding. A hit tiers the payment limit down instead of a blunt yes/no, and the tier
   is *reversible*: the limit the business configured lives in its own column, so a counterparty
   that comes off the watchlist gets its full limit back and one that stays on it does not decay
   a little further every time it is looked at. The sweep is logged whether or not anything
   changed, because proving screening happened is the part a one-time gate cannot do.
2. **AP automation (RFB2)** — each payable invoice gets a three-way match (PO ↔ goods received ↔
   invoice) plus a risk check, and the agent decides to **pay**, **hold** (over limit), **request
   info** (no PO match), or **flag as fraud** (high-risk counterparty) — with its reasoning
   attached to the line item.
3. **Contractor payments (RFB3)** — a GitHub PR URL can be checked for an actual merge before a
   milestone is released. Human verification remains available and is recorded as a human ledger
   action. Verified milestones are released the same day instead of waiting for Net-30.
4. **Treasury (RFB1)** — idle operating cash above a 7-day obligation buffer is swept into a
   USYC-yielding reserve; the agent redeems back out ahead of due dates rather than after. The
   sweep only happens when it pays for itself: a sweep and the redemption that must follow it are
   two transactions, so the policy computes the yield earned over the days until the next
   obligation and compares it to the round-trip fee. Idle cash that would earn less than it costs
   to move stays liquid (`src/lib/agent/treasury.ts`).
5. **Continuous audit trail** — every decision above is appended to a hash-chained, Ed25519-signed
   ledger (`/audit`). A reviewer can verify the whole chain in one click and read *why* the agent
   acted, not just that a balance moved — the "continuous euthyna" the hackathon brief describes.

Every decision is made by asking an LLM for a structured `{action, reasoning, confidence}` verdict
under an explicit guardrail policy (never pay a high-risk counterparty, never exceed a payment
limit, keep a liquidity buffer before sweeping to yield). Anthropic, OpenAI, and DeepSeek are all
supported, and with no key at all the same decision points fall back to a transparent rule-based
heuristic — so the app runs end-to-end with zero credentials, and every ledger entry records which
path produced it.

## Why this maps to the judging criteria

- **Agentic sophistication (30%)** — the agent chooses *whether* and *when* to pay, not just how;
  every choice comes with a checkable reason, and guardrails can override an LLM's own decision
  (see the `[guardrail override]` path in `src/lib/agent/orchestrator.ts`), which is what makes it
  an agent operating inside bounds rather than an unconstrained script.
- **Circle tool usage (20%)** — built directly against Circle's Developer-Controlled Wallets SDK
  (transfers, balances), EarnKit (USYC), and App Kit, following the same architecture as
  [`circlefin/arc-fintech`](https://github.com/circlefin/arc-fintech). See
  [Going live on Arc testnet](#going-live-on-arc-testnet).
- **Innovation (20%)** — the signed hash-chain ledger is a working version of Prior Art #01 and
  #08 from the hackathon brief (continuous audit trail; a single agent running mint/hold/pay) —
  ideas the brief explicitly says "nobody has built yet."
- **Traction (30%)** — the agent runs against real Circle wallets on Arc testnet, and
  `npm run cycle` is the same code path the dashboard button uses, so it can run unattended on a
  schedule. Pointing it at a real business is a data change, not a code change — see
  [Bringing your own business](#bringing-your-own-business).

## Architecture

```
supabase/migrations/      Postgres schema. Money is numeric(20,6), never a
  0001_init.sql            float; the ledger chain is linked inside an
                           append_ledger_entry() function under an advisory
                           lock so concurrent cycles cannot fork it.
src/lib/supabase.ts       Server-side client (service role; never imported
                           from a client component)
src/lib/insights.ts       Typed, server-only query boundary for measured
                           transfer, cycle, balance, and screening history
src/lib/ledger.ts         Hash-chained, Ed25519-signed append-only audit log
src/lib/compliance.ts     Continuous counterparty screening + risk tiering
src/lib/circle/           ChainProvider interface, three implementations:
  simulateProvider.ts       - simulate: needs no credentials, uses Arc's real
  liveProvider.ts             fee/latency profile
  index.ts                  - live: Circle Developer-Controlled Wallets
                            - hybrid (default with credentials): real Arc
                              payments, simulated USYC leg, both labelled
src/lib/agent/
  decide.ts                 Provider-agnostic decision helper: Anthropic ->
                             OpenAI -> DeepSeek -> rule-based heuristic
  treasury.ts               The sweep/redeem policy as a pure function, so the
                             LLM and the heuristic reason from one set of
                             numbers and the whole policy is testable
  orchestrator.ts            The agent cycle: compliance -> AP -> contractors
                             -> treasury -> forecast, all logged to the ledger
  cycle-metrics.ts           Counts outcomes, decision sources, and code-level
                             guardrail overrides at the point they occur
tests/                    Vitest. Every money path that can be tested without
                           a network: the hash chain and its tamper cases,
                           risk tiering, the treasury economics, provider
                           selection and fallback. `npm run verify`
scripts/                  seed, bootstrap:circle, and three doctors that tell
                           you exactly which parts are live
src/app/                  Evidence-first landing page at `/`; working treasury
                           console at `/console`, plus AP/AR, Contractors,
                           Compliance, Audit Log, and database-backed Insights
```

## Running it

```bash
npm install
cp .env.example .env.local
```

Create a [Supabase](https://supabase.com) project and put its URL and keys in `.env.local`
(Project Settings → API, plus the database password and project ref under Database). Then:

```bash
npm run db:migrate
npm run dev
```

Open `/console`, unlock controls with `AGENT_API_TOKEN`, and add counterparties and invoices through
the product. Each **Run day** click advances the demo clock and runs the full decision loop. Out of
the box, payments are simulated against Arc's real fee and latency profile ($0.01, <500ms) and
decisions come from the rule-based heuristic.

`npm run seed` is a destructive, opt-in demo command. It deletes the current business records and
loads the fictional Northstar Studio fixture. It is not part of normal setup, and there is no seed
or reset control in the product UI. Use it only in a disposable demo database.

Two independent upgrades from there, in either order:

| Want | Set | Check with |
| --- | --- | --- |
| Real LLM reasoning | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `DEEPSEEK_API_KEY` | `npm run agent:doctor` |
| Real USDC on Arc | `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` | `npm run circle:doctor` |

### Scripts

| Command | Does |
| --- | --- |
| `npm run verify` | Typecheck, lint, and the full test suite — what CI runs |
| `npm run test` / `test:watch` | Vitest, once or on change |
| `npm run db:migrate` | Applies `supabase/migrations/*.sql` |
| `npm run seed` | **Destructive demo only:** replaces business data with fictional fixtures |
| `npm run bootstrap:circle` | Creates Arc-testnet wallets for accounts and counterparties |
| `npm run cycle` | Runs one agent cycle headlessly using the configured clock mode |
| `npm run fixture:guardrail` | **Demo only:** adds one no-transfer model-vs-code refusal probe |
| `npm run status` | Balances, wallets, open invoices, ledger height |
| `npm run circle:doctor` / `agent:doctor` | Reports exactly which parts are live |
| `npm run arc:proof` | Standalone: two wallets, a faucet check, one real transfer |

Seeded amounts scale down automatically when Circle credentials are present (`SEED_SCALE`),
because the public faucet grants 20 testnet USDC every two hours and a demo denominated in
thousands would never settle. The business narrative is the same; the decimal point moves.

One consequence is worth knowing before you demo: **in live mode the agent declines to sweep into
USYC**, and it is right to. Moving ~30 testnet USDC at 4.5% APY for the three days until the next
invoice is due earns about $0.011, against $0.02 in sweep-and-redeem fees on Arc. The agent works
that out and holds — not as a threshold someone tuned, but as the arithmetic in `planTreasury`,
which is why the same policy flips to sweeping the moment the numbers justify it. Run in simulate
mode (`SEED_SCALE=1`, no Circle keys) to see exactly that: the identical book scaled up 1000x
sweeps 13,900 USDC. An agent that sweeps regardless of whether sweeping pays is the cron job this
project exists to not be.

## Going live on Arc testnet

The simulator and the real integration share one interface (`ChainProvider` in
`src/lib/circle/types.ts`), so switching is additive:

1. Get a **API key** and **Entity Secret** from the [Circle Console](https://console.circle.com)
   and put them in `.env.local`.
2. `npm run circle:doctor` — confirms the key is accepted and the entity secret is registered.
3. `npm run seed && npm run bootstrap:circle` — creates a real Arc-testnet wallet for every
   treasury account *and* every counterparty, and writes the ids and addresses back to Supabase.
   Counterparties get wallets so the demo is verifiable: when the agent pays a contractor you can
   watch the USDC land at a real address. A real deployment stores the address the counterparty
   gives you instead.
4. Fund the operating wallet: [faucet.circle.com](https://faucet.circle.com), select **Arc
   Testnet**, 20 USDC every 2 hours. (The Console faucet API, `requestTestnetTokens`, returns 403
   on sandbox keys for Arc — the public faucet is the reliable route.)
5. Run a cycle. The dashboard header now reads *payments: Arc testnet (live)* and paid invoices
   carry a real transaction hash.

`npm run arc:proof` does steps 3–5 standalone — two wallets, a faucet check, and one real transfer
— if you want to verify the path without touching the app.

To exercise the red guardrail band without risking a payment, `npm run fixture:guardrail` creates
one explicitly labelled demo invoice for 0.9 USDC against a medium-risk 0.5 USDC screened limit.
It feeds a model-style `pay` verdict through the same `enforceApGuardrails` function used by the
live orchestrator. Code changes the result to held, records `guardrailBlocked: true`, and never
calls a transfer provider. The command is additive and idempotent; it is not part of normal setup.

### What is genuinely live, and what is not

The dashboard reports payments and yield separately because they differ, and the audit log records
which produced each entry:

- **Live** — wallet creation, USDC transfers, balances, transaction confirmation, all through
  Circle Developer-Controlled Wallets on Arc testnet.
- **Simulated** — the USYC leg. EarnKit needs a `KIT_KEY` and a chosen vault id, and Arc testnet
  has no live vault to choose; Circle's own `arc-fintech` sample mocks reward accrual for the same
  reason. The integration point is marked in `src/lib/circle/liveProvider.ts`.
- **Live when configured** — sanctions screening calls an OpenSanctions/yente match endpoint when
  `OPENSANCTIONS_API_URL` is set. Without it, the product explicitly labels the small bundled
  watchlist as simulated. Provider errors create an incomplete check and retain the previous
  verdict; they never silently clear a counterparty.

## Bringing your own business

Everything the agent reasons about lives in five tables (`accounts`, `counterparties`,
`invoices`, `milestones`, plus the ledger). To point Vestiarion at a real business:

- Set `BUSINESS_NAME`, then add vendors, contractors, and clients on `/counterparties`. Their
  configured payment limit is stored separately from the authority derived by screening.
- Add payables or receivables on `/invoices`, or import up to 200 rows from CSV after inspecting a
  local preview. Amounts that cannot fit exact six-decimal USDC precision are rejected rather than
  rounded. Every accepted record is written to the signed ledger as a human action.
- Insert milestones with a real `verification_source` (a Git PR merge, a Kimai/Frappe timesheet
  entry, a client sign-off) and flip `verified` when that source confirms the work.
- Run `npm run bootstrap:circle` once real accounts exist, fund the operating wallet, and call
  `POST /api/agent/tick` on a schedule (cron, GitHub Action, whatever you have) instead of a
  button click.

### Running on a real clock

Production uses wall-clock mode by default; `CYCLE_CLOCK_MODE=simulate` is an explicit demo opt-in
that advances the numbered day counter. Every page shows the real timestamp of the latest completed
cycle. The included `.github/workflows/agent-cycle.yml` calls the protected endpoint every six
hours. Configure repository secrets `VESTIARION_URL` (the deployment origin) and
`AGENT_API_TOKEN` (the same server secret used by the app). GitHub Actions schedules can be delayed,
so the ledger timestamp—not the nominal cron minute—is the source of truth for when a cycle ran.

For automatic contractor evidence, put a full `https://github.com/<owner>/<repo>/pull/<number>` URL
in `verification_source` and configure a read-only `GITHUB_TOKEN`. A merged response verifies the
milestone; an unmerged response does not. Missing credentials and API failures are displayed as
unavailable or failed while retaining the prior verdict. A control-session holder can instead add
a manual verification note, which is written to the signed ledger with `actor: human`.

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

Nothing in the suite needs Supabase, Circle, or an LLM key. Everything that does is exercised by
`npm run cycle` against a real project — which is the honest place for it, not a mock that agrees
with itself.

## Guardrails

The agent's system prompt (`src/lib/agent/orchestrator.ts`) is the enforced policy, not a
suggestion — the orchestrator re-checks risk level and payment limit *after* the LLM decides and
before executing a transfer, so a jailbroken or hallucinated "pay" decision on a flagged
counterparty is blocked in code, not just discouraged in the prompt (see the
`[guardrail override]` branch).

## License

MIT
