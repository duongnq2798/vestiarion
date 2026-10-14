# Changelog

What changed in Vestiarion from one release to the next, for the people who run a business on it. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); [docs/RELEASING.md](docs/RELEASING.md) says how both are
used here.

Integrators: changes to the API (`/api/v1`) and webhooks are listed, entry by entry, in the
[API changelog](https://www.vestiarion.xyz/docs/changelog) ([source](content/docs/changelog.mdx)). The TypeScript SDK,
[`@vestiarion/sdk`](https://www.npmjs.com/package/@vestiarion/sdk), and the CLI,
[`@vestiarion/cli`](https://www.npmjs.com/package/@vestiarion/cli), each have their own version line.

## [Unreleased]

### Added

- **Asking why, in the moment.** When you go against the agent, Vestiarion asks why right there, in one optional line
  that never stops you: disagreeing in shadow mode, rejecting a bill, returning one to the agent, or paying a bill the
  agent flagged or held on one of its rules. Each reason is kept with where it was given and the version of Vestiarion
  that asked. Owners and admins see the latest ones on Insights, under "Why people went against the agent", and
  Vestiarion's team reads them to improve the agent; the privacy page says what is kept and for how long. Before
  migration `0120` runs, nothing is kept and every decision works as before.
  [Guide](https://www.vestiarion.xyz/docs/guides/first-payment).

- **Commissions on money received.** An owner or admin sets a plan for a sales partner or referrer on file: the rate,
  net or gross of what was recorded as a fee on the invoice, every deal or chosen deals, and a hold window. When a
  customer's payment on Arc is applied to an invoice of a covered deal, the commission on exactly that money is
  recorded with its formula, so a part payment earns its part and the same payment never counts twice. After the hold
  window, Bills & receivables › Receivables › Commissions shows what each partner is due, and Create payable makes one
  payable for it, which the agent decides and pays under every guardrail. A payment reversed afterwards takes its
  commission off the partner's next payable; nothing is pulled back from a wallet. A member named as the partner can
  never approve their own payout, set their own plan or create their own payable. Migration `0118`.
  [Guide](https://www.vestiarion.xyz/docs/guides/commissions).

### Changed

- **One answer to "is this real money?", everywhere.** Every page that says what a payment does now says it the way
  the header does, from the same facts: live on Arc mainnet, live on Arc testnet, simulated, shadow mode, or
  unavailable (switched off or held). Agree and pay no longer says "on Arc testnet now" while payments are off or held,
  and offers Agree alone then; Go live no longer says "paying" for a workspace whose payments are off, held or in shadow
  mode; a sandbox connected to Circle is no longer called simulated on Approvals, contractor payments or the report; a
  held Arc mainnet workspace's balance is no longer called a sandbox's; and a payee paid from a sandbox that simulates is
  told the payment is simulated, on their page and in their email. Live on Arc mainnet is in the brand colour on every
  surface. [Guide](https://www.vestiarion.xyz/docs/guides/workspace).
- **Disagreeing in shadow mode no longer needs a reason.** Why do you disagree? is still asked in the same step, and a
  reason given is kept with the verdict; leaving it empty no longer stops you.

- **The header names the page you are on.** On a page inside a section, the line at the top that says where you are
  now ends with that page, where it stopped at the section: Commissions reads "Your workspace › Bills & receivables ›
  Commissions". A deal, a project or a payment's evidence ends with the deal's title, the project's name or the bill's
  or milestone's name, and the section's name takes you back to the section. A long name is cut short, and pointing at
  it shows it whole. On a phone, the bar at the top names the page, with its section under it.

### Fixed

- **The New deal form's fields line up.** In the narrow New deal panel, the payment terms label took two lines and pushed its box below Total, Currency and Start date. It now reads **Terms (days)** and fits on one line.

## [0.1.0-beta.4] - 2026-10-14

### Added

- **Accept contractor work from Asana.** An owner or admin connects Asana in Settings. On Contractors, a milestone is
  linked to the Asana task its work is delivered in, by pasting the task's link or choosing workspace, project and
  task, and holds the acceptance criteria from the agreement, written in Vestiarion. When the task is completed in
  Asana, the milestone is **ready for acceptance**: a person checks the deliverables (the task's attachments and the
  links in its description and comments) against the criteria and accepts the work, and only then is it verified and
  decided by the agent under every guardrail. A completed task alone never pays, a completed task without criteria is
  held, and an acceptance or Pay now by the payee is refused, matched by email and, where Asana can tell, by Asana
  account. If the task is reopened, or its deliverables change, after acceptance and Vestiarion reads that before the
  payment is sent, the acceptance is taken back and the milestone is held for review; the agent reads the accepted
  task once more right before sending, then checks that the milestone is still verified. Asana's webhooks only have the task read again, as
  do the agent's cycle and a check every 15 minutes. The Asana card counts acceptances, disputes and the time from
  acceptance to the agent's decision. Migration `0115`. SDK 0.3.3 accepts `asana` as a milestone's verification method.
- **A command-line interface, `vestiarion` (`@vestiarion/cli` 0.1.0).** Developers and operators work with a workspace
  from a terminal: `vestiarion login` checks a workspace API key with one read and saves it for the user alone, and
  `whoami` names the workspace, its network and where the key came from. It reads bills, invoices, counterparties,
  milestones, the treasury and the agent's decisions with their reasoning, as text or as the API's JSON. It adds bills,
  invoices, counterparties, milestones and payee links only after showing what it will send and asking, or with
  `--yes`; it never approves or pays. Offline, it checks an audit export with the same answer as the standalone
  verifier, and a webhook delivery's signature. It is built on the TypeScript SDK and sends no telemetry.
  [Guide](https://www.vestiarion.xyz/docs/get-started/cli).
- **Deals brought in from Pipedrive.** An owner or admin connects a Pipedrive company from Settings, and its won deals
  come in under Deals on Bills & receivables, with their organizations and persons. Plan collections fills in the New
  deal form from a won deal: the customer from its organization, the title, the value (US dollars as USDC and euros as
  EURC, one for one), the won day as the start, and `pipedrive-` with the deal's id as its reference; its page then
  shows its cash readiness and project as any deal's. Pipedrive tells Vestiarion when a deal changes, and Vestiarion
  reads it again from Pipedrive itself; a planned deal changed there says Changed in Pipedrive, and nothing changes in
  Vestiarion until a person does. Once an owner or admin turns on Write receipts to Pipedrive, each planned deal gets
  what was collected, what is still owed, the last receipt and the reconciliation status, in Vestiarion's own deal
  fields, read back before they count and never written over a change someone made there. Pipedrive does not say which
  of its companies are developer sandboxes, so payments on Arc testnet or in shadow mode are never written to it;
  reading and planning work in every workspace. Vestiarion sees the deals the Pipedrive user who connected can see. One
  Pipedrive company connects to one workspace, and disconnecting uninstalls Vestiarion from it; planned deals stay. The
  landing page lists Pipedrive among the tools Vestiarion works with.

### Changed

- **Asana and Pipedrive show their marks.** On the landing page, "Built on, and works with" shows Pipedrive's wordmark
  and Asana's logo where their names were. Their Settings cards, connect pages and launch pages show Pipedrive's app
  icon beside its name and Asana's logo, as Xero, QuickBooks and HubSpot show theirs.

### Fixed

- **Pipedrive connects on a deployment where it is set up.** The Pipedrive card said "Pipedrive is not set up on this
  deployment yet." even after its database update had run, so nobody could connect it. Its readiness check now takes
  the workspace as every other check does (database update 0117).

## [0.1.0-beta.3] - 2026-10-13

### Added

- **Walkthrough videos in the Xero and HubSpot guides.** Each guide now opens with a film of under two minutes,
  recorded in the live product on Arc testnet with demo data: bills from the Xero Demo Company held, caught when paid in
  Xero and paid on Arc; a deal won in a HubSpot developer test account planned, collected and written back to HubSpot.
  Each has a caption and its transcript, and the player loads nothing until you press play. The docs Overview links to
  both.
- **Work in your own currency.** Every amount keeps the figure and currency written on the bill, where it came from,
  the rate it was converted at (with who published it and when) and what moves on Arc. An owner or admin sets a
  **Reporting currency** in Settings (USD, EUR, SGD, JPY, KRW, PHP or MYR), and the report's new **Currencies and
  rates** shows the bills, what was paid on Arc and what the business paid, each in its own currency and then in the
  reporting currency with the rates used; a currency whose rate was not recorded shows as unknown, never guessed. A
  bill paid after the rate moved shows its **FX variance** on its card and in the report: what the payment carried
  beyond, or short of, what the bill was worth that day. The rates and the variances are recorded every hour; a page
  shows the newest rate recorded with its age and never waits on the rate feed. The report counts the amounts with full
  provenance and the rates typed by hand. Payments still settle in USDC (or EURC on Arc testnet), at the amount each
  bill was converted to.
- **Exchange rates in cash scenarios, saved as versions.** Treasury's **What if clients pay late?** takes a rate for
  each currency your open bills are written in, with the latest reference rate recorded beside it (its time and age),
  and shows the cash in your reporting currency. An owner or admin saves a scenario as a version; saving again makes
  the next version, and no version is ever changed.
- **A first task for each role.** Every member sees a short checklist built for their role, ticked because each step
  happened in the workspace, never by a box someone ticks. An owner or admin: the workspace created, a first supplier,
  a first bill added or imported, the agent's decision, then the agent's limits, set or kept as they are with **Keep
  these limits**, before what paying on Arc needs. An approver, on Treasury and on Approvals: open Approvals, read why a
  bill is held, then decide it or send it back. An accountant, on the accountant console: open it, open one workspace's
  queue, book one payment or apply one receipt, and download the month's hand-off. A viewer has none. Accepting an
  invitation lands you on your role's first step: Approvals for an approver, the accountant console for an accountant.
  **Don't show again** hides a checklist for good, and no step offers anything your role cannot do. Until the
  workspace's database update for this release is applied, the checklists show without **Don't show again** and **Keep
  these limits**.
- **Evidence links people can actually open.** Before the evidence page says a pull request is verified, or offers a
  link someone gave, Vestiarion checks that it can be opened. One that can't (deleted, in a private repository your
  workspace's GitHub connection does not reach, access refused, a signed link expired) is named with the reason and
  never offered, and is never counted as verified. A pull request in your own private repository, read through your
  workspace's GitHub connection, stays verified.
  Vestiarion checks links on GitHub and on its own file storage only, through GitHub's API and the link's own signature,
  and never opens any other site from its server: such a link is shown as given, marked **Not checked by Vestiarion**.
  Milestone cards on Contractors say the same. Answers are kept a few minutes at most.

### Changed

- A bill's card writes its amount in its currency's own digits (no decimals for yen or won) and names its rate as the
  reference rate it is; a EURC bill's USDC value names Circle's quote. A bill in US dollars, on its card and in its
  evidence, names 1 USD = 1 USDC as USDC's 1:1 redemption peg, not a market rate.
- A link someone gave on the evidence page is now marked **Not checked by Vestiarion** where it said **Not opened by
  Vestiarion**, and a link that can't be opened reads **Can't be opened** with why.

## [0.1.0-beta.2] - 2026-10-13

### Added

- **Collections that follow the customer.** Before it reminds a customer, the agent weighs what Vestiarion knows about
  it: a dispute, a payment the customer says it made, a promise, part payments, the reminders already sent and the
  HubSpot deal it was sold through. Each receivable gets one next step with the facts behind it: wait, ask the account
  owner, remind in a friendly, firm or final tone, or escalate to finance. A **Collections** panel on the Receivables
  tab counts what waits on you, the reminders sent this week and promises kept and broken; a receivable's card previews
  the reminder exactly as the customer would read it. Each customer can have its own rules (ask first for a VIP, the
  strongest tone, the days between reminders), saved as versions. A broken promise goes to finance for review instead
  of an automatic reminder, and so does a customer's "I paid" still unconfirmed a week later, so a claim alone never
  stops reminders for good. Nothing a customer or HubSpot writes sends an email by itself. Tasks begin the first time
  the agent runs with this in your workspace: what was already overdue or broken before then shows on its card and
  emails nobody, and each person gets at most one task email each time the agent runs. Every email goes once, even
  when it is retried or the customer's rules changed in between, and turning reminders or emails off takes effect up to
  the moment of sending.

- **Projects, each with its own budget.** Make a project for a job, a client or a launch, with a budget in USDC and a
  buffer kept back from it, and put its bills, milestones and deals in it, as you add them or from its page. The agent
  sets each bill's money aside in its project before paying or scheduling it, and a bill the budget cannot cover waits
  for a person in Approvals with the project's figures. Two decisions at the same moment never set aside the same money.
  Each project shows its budget, what is set aside, paid and still available, the share of its open bills covered, the
  payments held for its budget, what its deals collected, its days in the 14-day payment plan and the treasury it
  shares; Treasury lists every project's money set aside. A budget is an earmark in Vestiarion, not money locked on
  chain: payments still need their cash, and the spending limit on Arc still counts only the workspace's figures.

- **The same work is not paid twice.** A milestone takes a purchase order. A bill for the same purchase order and payee
  as a milestone, or one linking the same delivered work, waits for a person when it comes second, and so does a
  milestone that repeats a bill; a person pays it when both are owed.

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

- **A customer saying it paid now holds the agent's reminders** until you find the payment or mark it not received, and a
  promise whose day passed holds them until finance reviews it, instead of reminders going again the next day.

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
- **Allowing HubSpot writes says what to tick.** The connect page and the HubSpot card say to tick both optional write
  permissions on HubSpot's install screen, and that in an account which approved Vestiarion before, a super admin first
  turns them on in HubSpot > Settings > Integrations > Connected Apps > Vestiarion > Data Permissions.

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

[Unreleased]: https://github.com/duongnq2798/vestiarion/compare/v0.1.0-beta.4...HEAD
[0.1.0-beta.4]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.4
[0.1.0-beta.3]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.1
