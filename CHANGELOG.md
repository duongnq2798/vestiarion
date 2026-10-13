# Changelog

What changed in Vestiarion from one release to the next, for the people who run a business on it. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); [docs/RELEASING.md](docs/RELEASING.md) says how both are
used here.

Integrators: changes to the API (`/api/v1`) and webhooks are listed, entry by entry, in the
[API changelog](https://www.vestiarion.xyz/docs/changelog) ([source](content/docs/changelog.mdx)). The TypeScript SDK,
[`@vestiarion/sdk`](https://www.npmjs.com/package/@vestiarion/sdk), has its own version line.

## [Unreleased]

### Added

- **An accountant role, and a console across your clients.** Invite an outside accountant or bookkeeper on Members with
  the new accountant role: they read everything, book payments made on Arc in Xero, apply money received and answer
  what customers say on their statement links, and decide no payment and change no treasury, limit, integration or
  member. The invitation form says what each role may do. The accountant console (`/accountant`) lists every workspace
  the person is a member of, how long its items have been open (under a day to over 30 days), and one queue across them:
  payments waiting for a decision or past their decide-by day, payments to book, overdue receivables, customers who say
  they paid or dispute an invoice, connector problems and limits reached, each opening the right page in its own
  workspace. Each workspace has a month's hand-off to download, as CSV or JSON: its decisions, payments, bookings and
  open items. The console counts items and never adds money across workspaces or currencies. Removing an accountant
  takes the workspace off their console and their downloads at once. A Xero connection made before this release keeps
  bookings with owners and admins until it is reconnected.

- **Usage this month, in Settings.** Every member sees what the workspace used since the 1st: model calls with their
  tokens and cost where the price is known, Circle transfers, x402 purchases, emails and connector syncs, each split by
  what it was for, costs in their own currency. Below it, each limit (a sandbox's cycles a day, the agent's spending
  limit, the payee history checks, invitations a day, a connector to reconnect) says where the workspace stands, what
  stops when it is reached, and who acts. A limit that stopped something is said at the top, and in the accountant
  console. It is a record, not a bill.

- **A deal's costs and its cash readiness.** On a deal's page, enter what it will cost (what, for whom, how much, the
  day it leaves, and whether a document backs it yet) and link each cost to the bill or milestone it became, which then
  counts in its place, once. Cash readiness sets the schedule's money in against the costs day by day: collected and
  paid out to date, the first day the deal would be short and by how much, and an estimated margin, which says "Not
  enough data" until a cost is entered. Collected is the deal's Paid: a line the customer paid part of counts what
  arrived as collected and only what is still owed as expected. Try a different deposit day or percent and see the gap
  move; nothing is saved until you change the deal. Each deal on the Receivables tab carries one badge: short and when,
  no cash gap, or no costs entered.

- **Held bills have a priority, a day to decide by and an owner.** Each card in Approvals and each row on Bills says
  Overdue, Due today, Due this week or Later, the day to decide it by (its due date, or its discount's last day), and
  who can act. When the due date passes undecided, the people who can decide get one email about it, unless they
  turned these emails off; a bill already past its day when escalations first ran in a workspace is never emailed about.

- **A statement link for each customer.** From the Receivables tab, an owner or admin sends a customer a link to its own
  statement, working for 7, 30 or 90 days: what it owes in each currency, each open invoice with what is still owed and
  how late it is, and what it paid recently. With no account or wallet, the customer pays an invoice on Arc through its
  pay link or asks for one, says it paid (with the day, a reference and the amount), promises a day, or disputes an
  invoice, and writes back and forth with you under it. A promise holds the agent's reminders through its day and a
  dispute until you resolve it. Everything customers say waits under **From customers** on the Receivables tab with the
  next step; "Customer says paid" stays the customer's word until the money arrives and is applied. Owners and admins
  with email on are told when a customer writes, with a short preview and a link, at most once an hour for each request.
  The page and the pay page work on a phone: the amount and its currency stay in view, and every button is large enough
  to tap.

- **Receipts back in HubSpot.** Sales sees whether a customer paid without asking finance: once an owner or admin turns
  on Write receipts to HubSpot, each deal planned from HubSpot gets what was collected, what is still owed, the last
  receipt (day, amount and its transaction on Arc), a collection and a reconciliation status, and a link to the deal in
  Vestiarion, in a Vestiarion group of deal fields. Only payments confirmed on Arc and applied to an invoice count, and a
  part payment shows as partial. Each write is read back from HubSpot before it counts as written; the deal's page says
  what was written and when. A field someone changed in HubSpot is never written over: the deal's page shows the
  conflict, and an owner or admin chooses. HubSpot being down never touches a payment: the write waits and is tried
  again on its own. Payments on Arc testnet or in shadow mode are written only to a HubSpot developer test account or
  sandbox. A connection made before keeps reading, and offers Allow writing to HubSpot. A deal's page and the Deals list
  show the same figures as Paid and Outstanding: a part payment counts as what arrived, and a fee a person marked
  settles an invoice without counting as paid.

- **Xero, QuickBooks Online and HubSpot on the landing page and in Settings.** "Built on, and works with" lists them
  beside Arc, Circle, Slack, Telegram and npm, each with its mark, what it does and its guide; their Settings cards and
  connect pages show their marks beside their names.

### Changed

- **Payment notices say what is known, and who verified it.** Activity toasts, Slack, Telegram, the stuck-payment email,
  the Approve and pay message and the decision trail say a payment was submitted until Circle confirms it, and that its
  outcome is unknown when Circle never answered; a confirmed payment names its source ("Circle confirmed it on Arc
  testnet"), and a sandbox payment says it was simulated. The payee email names Circle's confirmation, and a customer's
  pay page says what actually arrived and who reported it. A person's approval is noted as paid only once Circle
  confirms the payment.

- **Bills & receivables in three tabs.** The page keeps its four figures (Needs you, Due in 7 days, Overdue, and what
  customers owe), shows Waiting for review only when something waits, and puts the work under Bills, Payment plan and
  Receivables. Bills is one list with quick filters, search, an order and 25 rows a page; each row says what stands in
  a bill's way and the next action, and its name opens the card it always had in a panel. One New menu opens each form:
  Bill to pay, Invoice to a customer, From a document, Import a list, Recurring and Deal. Every link into the page,
  old ones included, still lands where it meant.

### Fixed

- **Bills from Xero and QuickBooks start unticked**, with Select all: one click on Add no longer adds the whole list.
- **A HubSpot deal planned already** shows the deal it became, with Open the deal, instead of saying it cannot be
  planned; right after Plan collections the page goes on to the new deal.
- **A bill's amount hint matches its currency.** In shadow mode, a bill in US dollars, euros or pounds showed
  `2.500.000` as its example amount; it now shows `1250.00`, and only a currency written without decimals, such as
  the yen, shows a grouped whole amount.

## [0.1.0-beta.1] - 2026-10-12

The first tagged release: everything merged from September 24 to October 12, 2026 (pull requests #1 to #325). A
public beta, on Arc testnet and Arc mainnet. Release notes:
[docs/releases/v0.1.0-beta.1.md](docs/releases/v0.1.0-beta.1.md).

### Added

- **The agent cycle.** One decision loop reads payables, contractors, receivables, compliance and the treasury, and
  proposes pay, schedule, hold, request info or flag as fraud for each bill, with its reasoning. It chooses the day to
  pay around due dates and early-payment discounts. Anthropic, OpenAI or DeepSeek proposes; with no model key, a
  written rule-based policy decides.
- **Guardrails in code.** Duplicate, risk, payment-limit, three-way-match, new-payee and liquidity rules run after the
  model and before any money moves; a first payment to a new address needs two people; payments above a figure the
  owner sets need two approvals; the agent has a daily and a 7-day spending limit, enforced on Arc by a contract only
  the owner's wallet can change or stop.
- **The signed ledger.** Every decision, refusal and human action is an Ed25519-signed, hash-chained entry, verified in
  one click, exported for offline verification and pushed to signed webhooks; signing keys can be rotated.
- **Shadow mode.** The agent decides a business's real bills while the business keeps paying them its own way; a person
  agrees or disagrees with each decision, agreed payments settle on Arc testnet at the real amount, and the agreement
  rate is counted.
- **Two networks.** Each workspace lives on Arc testnet or Arc mainnet. On Arc mainnet a workspace pays from its owner's
  own wallet or a passkey wallet, through its spending-limit contract, with two approvals above 100 USDC from the
  start.
- **Paying bills.** Bills typed in, imported from a bill list, read from a PDF, forwarded by email or sent through the
  API; recurring payments; EURC invoices and swaps; payouts to other chains through CCTP and Gateway; an approvals inbox
  and a pause switch; a 14-day payment plan; and where each payment is, from the decision to the books.
- **Contractors.** Milestones verified by a merged GitHub pull request or a person, GitHub bounties, milestone escrow,
  several milestones paid in one transaction, and payee links where a payee confirms their own address or creates a
  passkey wallet.
- **Getting paid.** Pay links, money received matched to what was owed, reminders, payments applied to several
  invoices or part of one with fees and reversals kept apart, and signed deals turned into collection schedules.
- **Treasury.** Safe to spend today, a USYC reserve on Arc testnet with cash brought back for payments, cash scenarios
  for clients paying late, and USDC added from another chain.
- **Reports.** A workspace report of what the agent did, compared bill by bill with what the business really paid
  (from a CSV or a bank statement) and shared by a revocable link; an evidence chain for each payment; and new limits
  tried on past decisions before they are applied.
- **Connected tools.** Bills from Xero and QuickBooks Online, payments booked back into Xero after a person approves
  them, customers and won deals from HubSpot, Slack, Telegram, email, a GitHub App, the REST API, the TypeScript SDK and
  an MCP server for AI agents.
- **Open numbers.** A public page of workspaces, payments and decisions per network, read from production on every
  load.

### Improved

- The workspace frame: a grouped, foldable sidebar, a status header and a command palette (Ctrl K or ⌘K).
- Lists ordered by what needs someone first, on Bills & receivables, Contractors and Counterparties, with the reason
  each row waits.
- Payments recorded within seconds of Circle settling them, and scheduled jobs run from Supabase Cron at the minute
  they are due.
- A first bill before the wallet when a workspace is created, with shadow mode offered from the start.
- Documentation led by a business's first decision and how payments are controlled, with screenshots of the app as it
  is.
- Text contrast that meets WCAG AA, keyboard focus visible on every control, and calm motion under reduced motion.

### Fixed

- A transfer is called failed only after Circle's answer is read, and every Circle request has a deadline.
- A second agent cycle cannot start while one is running.
- A payment to a counterparty never screened, or to a payee with no address, is held before anything is sent.
- A milestone release the wallet cannot cover is held.
- A payment approved in shadow mode goes to the address the card showed, and test USDC is never granted twice.
- HubSpot deal changes are recorded once, and its sync reads past HubSpot's search limit.

### Security & safety

- Row-level security under a dedicated tenant role, behind a per-workspace data access layer.
- A stop switch every deployment obeys, checked addresses, and screening that fails closed.
- Tighter payment integrity: one claim per decision, approver counts enforced, and the ledger chain checked as each
  entry is written.
- Four roles, owner, admin, approver and viewer, decide who may approve, pay or change settings.
- A member's API keys end with their membership, and pay-link tokens are kept out of analytics.

### Database & migrations

- 100 migrations, `0001_init.sql` to `0106_accounting_postings.sql` (numbers 0091 to 0093 and 0096 to 0098 are
  unused). They are idempotent and applied in filename order with `npm run db:migrate`; a release never runs them.

### Known limitations

- A beta: features and screens change often. The spending-limit and escrow contracts have not been audited.
- Arc mainnet supports USDC on Arc only. EURC, the USYC reserve, escrow, cross-chain payouts, x402 and shadow mode are
  Arc testnet only; Slack approves only on Arc testnet, and Telegram never approves.
- The USYC reserve needs Circle to allowlist a workspace's wallets.
- QuickBooks Online connects to sandbox companies until Intuit's app assessment is complete, and is read-only.
- Xero bookings wait for a person's approval; Arc testnet and shadow-mode payments are booked only into a Xero demo
  company.
- HubSpot is read-only, polled every 15 minutes, and its app is not yet verified by HubSpot.

[Unreleased]: https://github.com/duongnq2798/vestiarion/compare/v0.1.0-beta.1...HEAD
[0.1.0-beta.1]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.1
