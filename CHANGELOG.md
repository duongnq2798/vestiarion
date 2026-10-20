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

- **Payee lock.** An owner turns it on in **Settings**, under **Payee lock**, to make confirming a changed payout
  address a recorded check by a second person.
  - **Confirm address** asks how the address was checked, the contact used, and whether that contact was on file before
    the new address arrived. This is optional with the lock off and required with it on.
  - With the lock on:
    - whoever entered or asked for the address cannot confirm it while someone else can;
    - approving a payment no longer confirms its address;
    - an optional wait of 4 to 72 hours keeps a changed address from being paid, confirmed or not. The agent holds the
      payment, then decides it again when the wait ends.
  - Counterparties now warns about an address that is the same as another payee's, or that looks like it (the same
    first 6 and last 4 characters).
  - Each check is signed with the confirmation. Migration `0135_payee_lock.sql`.

### Changed

- Public payee, supplier, payment, receipt and statement pages share the landing's visual system: readable paper
  records, consistent headings and spacing, and larger touch areas on phones. Sign-in, open numbers and the docs'
  header and footer use the same foundation. Existing forms, payment checks, quoted labels, numbers and redirects
  keep their behaviour; a payee's accepted answer still moves directly to the next step and focuses its heading.

- **Pages and actions answer sooner.** The app's server now runs in Tokyo, beside its database, instead of in
  Washington. Every database call used to cross the Pacific and back, and a page or an action makes many of them one
  after another, so a payee link's step or a workspace page waited seconds for it.

- The landing hero explains the recorded schedule, coded hold and human approval beside their own entry links, with
  the confirmed CCTP fee, actual app navigation labels and text of at least 12px in narrow panes. Hero and the detailed
  journey choose the same bill with a complete decision, hold, approval and payment story; direct is the fallback
  when neither candidate is complete. The remaining bill appears separately in “Another team payment”.

- The landing follows one bill through the agent's checks, rules and payment, with a clearer application view and
  recorded evidence from the Vestiarion team's own workspace. Available ledger entries have signature checks and
  payments link to the relevant Arc or Base explorer; missing evidence stays unknown. Migration
  `0134_landing_team_journeys.sql` adds the read-only team evidence projection.

### Added

- **A payee sends its invoice, and picks where it is paid, through its payee link.** Creating a payee link on
  **Counterparties** now offers two boxes, both off by default: **Also ask for their invoice**, and, for a vendor with
  no address yet on a network that pays more than one chain, **Let them choose where they are paid** (not while a
  milestone or a bill in another currency than USDC is open for it). The payee then chooses the chain its wallet
  receives USDC on before giving its address (Arc mainnet or Base; Arc testnet or a Sepolia chain); the chain is
  written with the address, waits for the same confirmation, and is named beside the address on Counterparties. A
  payee with an address of its own on file can keep it instead. The invoice (its number, the amount in USDC, the due
  date, and optionally a note of plain text and a PDF or text file, read for its text with no model and never stored)
  waits on Bills under **Waiting for review** as "Invoice from *payee*" until a member adds it as a bill they entered,
  or discards it, and the owners and admins get one email. A link takes one invoice; **Revoke** stops a used link
  still waiting for it, and so does a newer link for the payee. The new payee check now counts an address as paid only
  on the same chain. Signed as `payee_invoice_submitted` and `counterparty_address_kept`, and
  `counterparty_address_changed` records the chain. Ask every payee, Pay a freelancer and the API make links as before.
  Migration `0133_payee_link_invoices.sql` adds the link's options, the drafts' new source and the functions behind
  them. [Guide](https://www.vestiarion.xyz/docs/guides/first-payment#ask-a-payee-for-their-address).

- Shared public typography and section spacing for the bill journey direction, with accessible blue and dark sections,
  a flat card elevation and reusable headings. The existing app, email and docs palette and control sizes are preserved.

### Fixed

- **Pay early for a discount shows in a workspace with no reserve.** Bills & receivables could not read its early-payment
  offers there, so the section never showed and each load logged an error. Such a workspace earns nothing by keeping
  the cash, so each bill now suggests the 0.5% floor, and the line saying what it is worth names no reserve. No
  migration.
- **A payee link moves on as soon as the payee sends its address.** On a link that asks for the invoice, sending the
  address left the page on Step 1 with "Thanks. *business* will confirm your address before paying you." until the
  payee reloaded it, so a payee could think they were done and never send the invoice. The page now shows **Send
  *business* your invoice** as soon as the address is accepted, and keeping the address on file moves on the same way.
  After **Send my invoice**, the next step shows as soon as the invoice is accepted, without waiting for the page to
  load again. No migration.
- **A payee's page answers before the business's email goes out.** Sending an address or an invoice through a payee
  link waited for the email to the owners and admins before the page moved on, about five seconds for an invoice. The
  email now goes out just after the payee's answer.
- **Ask for address names the payee's chain.** Its dialog said the payee enters their own Arc address, also for a
  vendor paid on Base. It now names the chain the vendor is paid on.

## [0.1.0-beta.11] - 2026-10-19

### Added

- **Pay a vendor on Base from your own wallet.** A workspace that pays from the owner's own wallet, through its
  spending limit contract, can now pay a vendor on Base too. Version 2 of the contract adds `payAcrossChains`: the
  agent's wallet asks it to take the payment and its CCTP fee from your wallet, count both against the daily and 7-day
  figures, and burn them for Base, so the agent's wallet still never holds your USDC. The contract only burns for Base
  on Arc mainnet, refuses a fee above 10% of the payment or 2 USDC, and keeps nothing after a call. It is not audited.
  Every new setup deploys version 2. A workspace set up before keeps paying through version 1, and **Go live** offers
  its owner the upgrade: deploy the new contract, approve it and revoke the old one from a browser wallet, or all of it
  with one passkey confirmation. The upgrade waits for any payment in flight. Signed as `spending_limit_upgraded` and
  `spending_limit_revoked`. Migration `0132_spending_limit_v2.sql` adds the contract's version to its row.
  [Guide](https://www.vestiarion.xyz/docs/guides/go-live#upgrade-your-contract-to-pay-other-chains).

- **Pay a vendor on Base from Arc mainnet.** A workspace on Arc mainnet can now pay a vendor's USDC address on Base,
  where most contractors who want USDC already hold it. The operating wallet burns the USDC on Arc through Circle's
  CCTP and Circle mints it to the vendor on Base; the fee, about 0.054 USDC when checked, comes on top of the invoice,
  and the payment counts as paid once it is minted on Base. It runs from a workspace on its own Circle account, and from
  your own wallet through version 2 of its contract (above). Choose **Base** under **Chain** on Counterparties. The database allows the new chain through edits to two
  existing migrations, which `db:migrate` re-runs. A vendor paid on another chain can no longer be given a milestone:
  milestones are released on the workspace's own chain, so its USDC would have gone to that address on Arc. A release
  of one made before is held. A live slice now carries a vendor on Base Sepolia as a vendor on Base, without the
  address. The TypeScript SDK 0.3.5 accepts `BASE` for a counterparty's chain.
  [Guide](https://www.vestiarion.xyz/docs/guides/first-payment#pay-a-vendor-on-base-from-arc-mainnet).

- **A reminder when a workspace stops.** A workspace opened by someone outside the team that has no real bill a day
  later gets one email, **Your agent has no bill to work on yet**: the ways to give the agent a bill (**New**, then
  **Bill to pay**; **Import a list**; forwarding bills to the workspace's own address), and **Load sample data** in a
  sandbox that can load it. A workspace in shadow mode whose agent's decisions still wait for a first verdict three
  days on gets one email saying how many wait. Each goes once per workspace, to the owners, admins and approvers who
  keep its emails on, never about a workspace opened more than 30 days ago; the agent tick sends them, since its
  scheduled cycles reach only live workspaces and a new one is a sandbox. Signed as `activation_nudge_sent` (or
  `activation_nudge_failed`, up to three tries in all). No migration.
  [Guide](https://www.vestiarion.xyz/docs/guides/workspace#a-reminder-if-you-stop).

- **Bring in a second person.** While one person runs a workspace, Treasury asks an owner or admin, once the agent has
  decided a real bill, to invite an approver (so a first payment to an address they gave goes to someone else) and
  their accountant, each from one email field, through the usual invitation. **Not now** hides it for 30 days in that
  browser. The weekly summary of a one-person workspace ends with a link to invite them, and `member_invited` says
  where an invitation came from with `via`. No migration.
  [Guide](https://www.vestiarion.xyz/docs/guides/workspace#bring-in-a-second-person).

- **Ask every payee for an address at once.** On **Counterparties**, owners and admins see how many vendors and
  contractors have no address of their own, mirror addresses included, and choose **Ask N for an address**. Each gets
  its own one-time payee link, emailed to its notice email where it has one, and the rest are shown once to copy; a
  workspace sends at most 100 such emails a day, and a sandbox none. Every address that comes in still waits for a
  person to confirm it. Signed as `payee_addresses_requested`. No migration. [Guide](https://www.vestiarion.xyz/docs/guides/first-payment#ask-every-payee-at-once).

### Changed

- **The landing page is lighter, still at rest, and its sample bill checks itself.** Its links to the docs and guides
  now load their page when you open one, not in the background as each scrolls past: those background loads were 570
  KB of the 626 KB a full scroll of the page fetched ahead. The call to action, sign-in and how the agent decides still
  load ahead. The hero's two background tints no longer drift, so nothing on the page moves at rest, and the marker
  under "Who it's for" and the developer tabs now glides to the tab you choose, or moves at once with reduced motion.
  The sample bill beside the headline now plays out once, the way the agent works through a bill: it reads the bill,
  ticks its four checks one by one, only then proposes paying it and waits for your verdict, and the next bill is held
  by a rule in code. It is done in 2.5 seconds and does not repeat. Where the card sits below the text, on a phone or in a narrow
  window, each line prints as you scroll to it, so its checks tick where you are looking, and with reduced motion each
  line fades in where it stands, in the same order. Under it, **See a real decision and its transaction** leads to the
  real payment in the proof.

- **The pages and emails your counterparties get say who sent them.** The supplier payment status, payee link, receipt,
  early-payment offer, customer discount, request for more time, pay link, customer statement and shared report pages
  end with "Sent with Vestiarion, the AI agent for bills and payments." and a link to Vestiarion's site, and the
  emails sent to suppliers, payees and customers link to it in their footer. The link is tagged with the kind of page
  only, never the business, the person or an amount. Email footers now describe Vestiarion as the AI agent for bills
  and payments. No migration.

- **The landing page's developer section shows real code for each way in.** "Runs where you already work." now says
  it is for builders, what a key can do, that every check still applies and nothing it reaches approves or pays, and
  that each write is signed into the ledger. Beside it, the API, the SDK and MCP each show the snippet their guide
  gives, highlighted and no longer typed out, with a copy button and the guide that goes further. **Read developer
  docs** opens the quickstart, and **View on GitHub** the repository.

- **The landing page's integrations show what a connection does, not only that it exists.** "Keep your tools.
  Vestiarion connects to them." now leads with Xero and QuickBooks Online, each saying what comes in and what goes
  back: Xero books each payment against its bill once a person approves the entry, and QuickBooks Online is read-only,
  with sandbox companies for now. Under them, "From your existing tools to a controlled payment." follows a Xero bill
  through review, the rules, payment on Arc and the booking back. The other tools sit in three compact rows, GitHub and
  Invoice Capture for Chrome among them, then Arc and Circle as what every payment runs on. **Explore all integrations**
  leads to a new docs page, [Every integration at a glance](https://www.vestiarion.xyz/docs/guides/integrations): one
  table of what each tool brings in, what it writes back and who allows that, and what none of them does.

- **The landing page's safety section says who decides what, and shows one real refusal.** "The AI suggests. Your rules
  decide." now sets out three principles, each saying what holds it: your team sets the limits, roles and
  approvals; rules in code check every payment before it is sent, with Arc mainnet's spending-limit contract as the
  one onchain bound; and every decision, approval and hold is signed into the ledger. Under them, "What happens when a
  rule fails?" follows a real decision in a demo workspace in shadow mode on Arc testnet: the agent proposed a 50.00
  USDC payment, the daily spending limit refused it, and nothing was sent. **Explore all safety controls** leads to the
  controls guide.

- **The landing page's proof leads with one real payment you can check.** "Don't take our word for it." now opens on
  the first payment a team workspace made on Arc mainnet: the agent decided to pay a 0.10 USDC bill, code held it as a
  first payment to a new address, a second member approved it, and it was paid through the owner's spending-limit
  contract. Each step has its time, beside the transaction's facts and "Verify on Arc Explorer". The open numbers
  follow in three groups, customer activity, the agent's decisions and payments settled, each network on its own, with
  the agent's latest decision and its signature check under the decisions. The section is about a fifth shorter on a
  wide screen, and the landing reads only the numbers and the latest decision for it.

- **The landing page's questions, rewritten for the owner deciding whether to trust it.** They now ask what a business
  asks first: whether it can try Vestiarion without real money, who controls the money and approves payments, what pays
  on its own, what happens when a payment fails, whether it fits the tools it uses, whether it needs crypto, what it
  costs and who sees its bills, each answered in a few sentences with the guide that goes further. The questions read as
  one list with thin dividers and a plus that turns to a minus, one open at a time; the heading stays in view beside them
  on a wide screen, with the docs and a way to reach the founder on GitHub.

### Fixed

- **Nothing on the landing page stays hidden after a jump.** A section you jumped past, with a link to Proof, the End
  key or a fast scroll, stayed invisible until you scrolled back up to it; it now shows at once, and one you reach just
  after the page loads no longer fades out before it fades in. The open numbers no longer nudge the words beside them
  while they count, a figure under 10 fades in instead of counting, and with reduced motion every figure fades in where
  it stands.

- **Docs tables keep names and codes whole.** A table in the docs no longer squeezes a column until a name such as
  QuickBooks or a code such as `invalid_request` breaks in the middle: a cell breaks only between words, its code stays
  on one line, and a table wider than the screen scrolls inside its own frame. Across the 36 docs pages with tables,
  words split over two lines went from 54 to 3 on a laptop and from 126 to 8 on a phone, each of those at a hyphen.

- **Get started sees the USDC in your own wallet at once.** Right after **Go live**, a workspace paying from the
  owner's own wallet could read "Your wallet holds no USDC the agent can move" on the console's checklist while
  **Settings** showed what the agent could move. The console stored that figure only after the agent's first cycle or
  its balance read. While the stored figure is 0, **Fund it with USDC** now reads what the agent can move from the
  chain, as **Settings** does: your wallet's USDC, or the approval if that is less.
  [Guide](https://www.vestiarion.xyz/docs/guides/go-live#path-c-your-own-wallet).

## [0.1.0-beta.10] - 2026-10-18

### Added

- **Start the live slice from shadow mode.** Once a business trusts the agent in shadow mode, an owner ticks the vendors
  to pay in real USDC under the report's **Before a live slice** and opens a workspace on Arc mainnet with them: name,
  payment limit, notice email and purchase orders carried, a vendor's own confirmed Arc address waiting to be confirmed
  again there, a mirror address or one on another chain never carried. It carries no bill and moves no money; the new
  workspace goes live from its Settings, and the report's last step names it and ticks once it is live. Signed as `live_slice_started`. No migration.
  [Guide](https://www.vestiarion.xyz/docs/guides/report#start-the-live-slice).

- **Change which bills the cash goes to first.** When the cash cannot cover every bill due soon, the **Payment plan** tab
  now shows the agent's order under **Which bill first**: each bill paid first or waiting, its reason, who set the order,
  and what the written policy would pay first. An owner, admin or approver moves bills up or down and saves; the agent
  keeps that order while the bills stay the same and for those still due once some are paid, decides at once the bills
  it moves, and never pays more than the cash holds. Whoever entered a bill cannot move it ahead on their own. The order
  is signed as theirs, as `cash_priority_set`. No migration.
  [Guide](https://www.vestiarion.xyz/docs/guides/payment-plan#change-the-order).

- **Show a supplier when it will be paid.** An owner or admin can send a vendor a link to its own bills: where each one
  stands (received, being reviewed, the day it is set to be paid, on its way, or paid),
  what is still to be paid in each currency, and each payment's transaction on Arc. It needs no account, never says why
  a bill is held, and shows nothing else of the workspace; in shadow mode it shows no bills. One link per vendor works
  for 7, 30 or 90 days, made and stopped on the Bills tab under **Supplier payment status**. It needs migration `0131`.
  [Guide](https://www.vestiarion.xyz/docs/guides/supplier-status).

### Fixed

- **The reasons for which bill first name each bill.** The agent's reasons on the **Payment plan** tab, and on a waiting
  bill's card, sometimes named bills by an internal ref ("pairs with B3") and wrote amounts with a dollar sign ("$45").
  They now name the payee and amount in USDC ("Cobalt Cloud 45.00 USDC"). No migration.

- **The agent no longer says a supplier offered more time.** When ordering the bills, it read the count of requests for
  more time it had sent a supplier as the supplier offering it. The count is now given as the requests the agent sent.

- **Whoever entered a bill cannot put it first while the cash covers none.** The order's maker-checker only refused when
  a bill the person entered moved into the part the cash covers today, so with little cash they could put their own bill
  first and it was paid first once cash came in. It now refuses any move of that bill ahead of one it was behind, unless
  they are the workspace's only approver.
  [Guide](https://www.vestiarion.xyz/docs/guides/payment-plan#change-the-order).

- **A bill that waited for cash is paid once the agent chooses it under the same bills.** When more cash let the agent
  keep a bill it had made wait, without any bill changing, that bill stayed held until cash covered every bill; it is now
  decided again at once.

- **Every live workspace gets its scheduled cycle again.** The cycles every six hours ran one workspace after another,
  and with twelve live workspaces they outran the five minutes they are given: the last ones in name order got no
  scheduled cycle at all. Four now run at once, and a cycle that could not finish in time is left to the next run
  instead of being cut off. No migration.

## [0.1.0-beta.9] - 2026-10-18

### Added

- **The agent chooses which bills to pay first when the cash cannot cover them all.** Bills used to be paid in date
  order: the one due first took the cash, and the rest were held. Now, when the bills due within 14 days add up to more
  than the cash, the model orders them by what costs the business most to pay late (a service it runs on, a discount
  about to end, a supplier who will not wait), saying why for each, with the written policy's date order as its
  reference. Code pays them in that order only while the cash lasts, holds the rest for a person, even one the model
  would pay, and reopens a held bill the agent chose to pay. The choice is signed once as `cash_priority_set` and told in
  the console, Telegram and Slack, and kept until a bill or the cash changes. No migration.
  [Guide](https://www.vestiarion.xyz/docs/guides/payment-plan#which-bill-first-when-the-cash-cannot-cover-them-all).

- **The weekly brief in shadow mode.** A business in shadow mode now gets the Monday brief too, about its verdicts
  instead of cash: the decisions the agent made on its bills, the verdicts given and how many agreed, the agreed bills
  paid on Arc testnet, and the agreement since shadow mode began ("you agreed with the agent on 8 of 8"). It says the
  business's own money did not move. **Send me this week's summary** works there too.
  [Guide](https://www.vestiarion.xyz/docs/guides/shadow-mode#5-see-how-often-you-agreed).

- **The agent's weekly brief.** On Mondays, after the first scheduled cycle, each owner, admin and approver who keeps
  payment emails on gets a summary of the week: what the agent paid, what customers paid and how many decisions it
  made in the last 7 days, what waits for them, what leaves in the next 7 days, and whether the cash covers the next 30
  days or when it runs short and by how much. A quiet workspace gets none, nor does one in shadow mode. **Send me this
  week's summary**, under Notifications in Settings, sends it at once to your own address. The ledger records
  `weekly_brief_sent`. No migration. [Guide](https://www.vestiarion.xyz/docs/guides/payment-plan#the-week-by-email).

- **A short video for each main flow.** Twelve more guides open with a narrated walkthrough recorded in the live
  product, two minutes or less each, with its transcript: your first decision, your first payment, shadow mode, how
  payments are controlled, going live, getting paid by a customer, early-payment offers, paying a contractor, bills from
  QuickBooks and Zoho Books, bills that arrive on their own, bank payouts, and evidence with the audit export. The docs
  Overview and the README list them all. In the app, a section's "Docs" link to one of these guides is followed by
  "Watch" and the video's length, and so is the getting-started checklist's "Read the guide"; Collections and
  Approvals gain their "Docs" link. [Watch them](https://www.vestiarion.xyz/docs#watch-it-work). The demo and the product
  tour are voiced again, with USDC said letter by letter, and the README links the new uploads.

- **The agent tells you before the cash runs short.** Each cycle it works out the same 30 days the console's cash
  outlook shows, and when the wallet will run short it says once, in the console, Telegram and Slack, how much is
  needed and by when, what customers owe by then, and what it is already doing: bills held for want of cash, requests
  for more time and customer discounts open. It says it again only when the first short day comes earlier, the amount
  grows by at least 1 USDC and a tenth, or a week passes, and says when the cash covers everything again. A new cycle
  stage, `cash_alert`, after `term_requests`; the ledger records `cash_short_ahead` and `cash_short_cleared`. Not in
  shadow mode. No migration. [Guide](https://www.vestiarion.xyz/docs/guides/payment-plan#when-the-cash-will-run-short).

- **Scheduled payments are checked against the cash ahead.** A scheduled bill used to wait, undecided, until its day,
  even when a bill due earlier had since taken the cash it was counting on; it was then held on its day, too late to
  act. Each cycle the agent now measures every USDC bill scheduled for a later day as the written policy does, and
  decides again now one the cash will not cover then. Held days ahead, it is decided again once cash comes in, and the
  agent can ask the supplier for more time and offer customers a discount before the day comes. A bill a person moved
  from the payment plan keeps its day. The activity toasts, Telegram and Slack say "set for Oct 23: the cash will not
  cover it then". Such a bill is never paid now ahead of what falls due first, and a bill held behind one that is paid
  later reopens once the money for it is there. The customer discount shortfall now counts what is set for bills
  scheduled before the held ones fall due, and the reserve. No migration. [Guide](https://www.vestiarion.xyz/docs/guides/payment-plan).

- **Suppliers can propose fewer days on the agent's request for more time.** On the request's page, beside Agree and
  Decline, a supplier may propose fewer days. The agent answers at its next cycle: it accepts when the new date is one
  the business can keep, with what it holds and what customers owe by then, and declines otherwise rather than promise a
  payment it would miss; the model decides, the written policy is its reference. Accepted, the due date moves by those
  days. The supplier gets the answer by email, and each step shows in the activity toasts, Telegram and Slack. It needs
  migration `0130`. [Guide](https://www.vestiarion.xyz/docs/guides/more-time#if-the-supplier-proposes-fewer-days).

- **Requests for more time, followed up.** When money comes in before a supplier answers, or the bill is no longer
  held for want of cash, the agent withdraws its request for more time and emails the supplier that it no longer needs
  it, so no one agrees to a later date the business does not need. It keeps doing so after the requests are turned off.
  Each request, answer and withdrawal is now told in the activity toasts, Telegram and Slack. A request withdrawn
  before its email went no longer stops its bill being asked about again.
  [Guide](https://www.vestiarion.xyz/docs/guides/more-time#when-the-request-is-no-longer-needed).

- **The agent asks suppliers for more time when cash is short.** An owner or admin turns it on in More time when cash
  is short on Bills & receivables, with the most days the agent may ask for (3 to 30). When the operating wallet cannot
  pay a bill falling due within two weeks, the agent emails the supplier a one-time link asking for the same amount on
  a later day; the model picks the days and code keeps them within your most. A supplier who agrees moves the due date,
  and the agent decides the bill again; one who declines leaves it as it was, for a person. In a sandbox, the requests
  go to the member who turned them on. It needs migration `0128`.
  [Guide](https://www.vestiarion.xyz/docs/guides/more-time).

- **The agent offers customers a discount to pay early while cash is short.** When bills are held because the operating
  wallet cannot pay them, an owner or admin can let the agent offer customers a small discount, up to the most they set
  (0.5% to 5%), to pay an open invoice within 5 days. The model picks which invoices and how much within bounds code
  sets; the customer accepts from a one-time link, pays the lower amount through the invoice's pay link, and the agent
  matches it as any payment. The invoice's amount never changes, and after its pay-by day the discount lapses. It needs
  migration `0129`. [Guide](https://www.vestiarion.xyz/docs/guides/customer-discounts).

### Changed

- **The landing page's proof says which rule decides.** A paid bill now reads "Rules in code passed it" first, then
  whether the written policy agreed, "kept only to compare" when it would have decided otherwise. The latest decision's
  badges read "Rules in code" and "Written policy, to compare", and one sentence says the rules in code decide while the
  written policy never pays or blocks. Earlier decisions list three, with the latest refusal by code among them when
  there is one. The FAQ says how long it takes to start (about five minutes) and what it costs: trying it is free, there
  is no published price yet, and a live payment carries only its network fee, less than a cent on Arc.

### Fixed

- **The agent no longer guesses how a supplier answered earlier requests for more time.** Choosing which bills to pay
  first, the model was told how many requests a supplier was sent, agreed to and declined; in the live test it read a
  request the agent withdrew, and a counter the agent declined, first as the supplier's yes, then as its no. It is now
  told each outcome, and to say only what the counts show.

- **Public receipts and evidence pages check Arc testnet again.** Arc's public testnet RPC is now
  `https://rpc.testnet.arc.io`; the old `rpc.testnet.arc.network` name stopped resolving, so receipts said one check
  could not be made and "Why it was paid" could not open the payment. Every Arc testnet read made without
  `ARC_RPC_URL` set (receipts and evidence, USYC, escrow, EURC and bank payout balances, network fees, spending limits,
  and the browser wallet's network switch) now uses the new address. No migration.

- **The agent no longer reads a request it took back as the supplier's no.** Weighing a request for more time, the
  model was told how many earlier requests a supplier got, agreed to and declined, but not how many the agent itself
  withdrew; in a live test it read one withdrawn request as a second decline. It is now told those too, and a request
  withdrawn before its email went no longer counts as one the supplier got.

- **A supplier whose counter the agent declined can be asked for more time again.** The agent's no to a counter was
  counted as the supplier declining, which kept the agent from asking that supplier about any other bill for 30 days.
  Only a request the supplier itself declines now waits.

- **Leaving Bills & receivables no longer asks about a bill already added.** After New ▾ added a bill or an invoice,
  the form cleared itself, a select going back to its default counted as an edit, and the browser asked "Leave site?".
  The form now stays clean after a save until something is typed into it again.

- **The agent no longer adds up the cash for a request for more time itself.** In a live test, the model skipped asking
  a supplier for more time because it compared what customers owe with the bill alone, though that and the cash on
  hand covered it two days after the due date. Code now works out when the bill is covered and gives the model that,
  for a new request and for a supplier's counter.

## [0.1.0-beta.8] - 2026-10-17

### Added

- **Early-payment offers in a sandbox.** A sandbox's suppliers are sample data, so the agent used to make no offers
  there. Now it sends them, and its answers to counters, to the member who turned the offers on, who answers as the
  supplier. The emails say "[Sandbox]", payments are simulated, and the sample data adds a bill due in three weeks for
  the agent to offer. [Guide](https://www.vestiarion.xyz/docs/guides/early-payment-offers#try-it-in-a-sandbox).

- **The early payment the agent negotiates, told as it happens.** The activity toasts, the Telegram chats and the
  Slack channel now tell each step: the offers the agent made and who decided them, a supplier's acceptance or counter,
  the agent's answer to a counter (with code's reason when code declined it), and an offer it withdrew. A person's own
  offers, and bills the agent chose not to offer, are not told.
  [Guide](https://www.vestiarion.xyz/docs/guides/early-payment-offers#following-along).

- **What the early-payment offers came to, and offers kept covered.** Pay early for a discount says how many offers
  were made (by the agent among them), accepted (after a counter among them) and declined, and what the bills paid early
  saved, as an amount and as a yearly rate on the cash paid early. And the agent withdraws its own open offers, the
  largest first, when the cash left after what falls due this week no longer covers every offer out, so it never
  promises a supplier a payment today it could not make. A person's offer is never withdrawn by the agent.
  [Guide](https://www.vestiarion.xyz/docs/guides/early-payment-offers#what-the-offers-came-to).

- **Suppliers can counter the agent's early-payment offers.** On an offer the agent made, the supplier may propose a
  smaller discount instead of accepting or declining. The agent answers it at once: code lets it accept only while its
  offers are on, the bill is unchanged, the counter beats what the cash would earn in the reserve by the due date, and
  the operating wallet can pay it today; the model decides within that. An accepted counter goes on the bill and is
  paid the same day, after every check; either way the supplier gets the answer by email. Needs migration `0127`.
  [Guide](https://www.vestiarion.xyz/docs/guides/early-payment-offers#when-the-supplier-proposes-a-smaller-discount).
- **The agent makes early-payment offers.** An owner or admin lets the agent make the offers itself, with the most it
  asks. Each cycle, after it decides its bills, it weighs each bill it scheduled for a later day, in USDC, a week or more
  from its due date, never offered before, whose supplier has an email on file and declined no offer in 30 days, where
  the operating wallet can pay it today. The model decides whether to offer and what discount to ask, between the
  suggestion and the ceiling, and the agent emails the supplier the link in a fixed template; an offer whose email does
  not go is withdrawn. At most 3 a cycle, never while the agent is paused. Needs migration `0126`.
  [Guide](https://www.vestiarion.xyz/docs/guides/early-payment-offers#let-the-agent-make-the-offers).
- **Early-payment offers.** Bills & receivables lists the bills the agent will pay later under Pay early for a discount,
  each with the discount worth asking for paying today, twice what the cash would earn in the reserve by the due date.
  An owner or admin offers it to the supplier through a one-time link, kept only as a hash. If the supplier accepts, the
  discount goes on the bill, ending today, and the agent pays the discounted amount at once, after every check any bill
  gets; the supplier can also decline, and the offer can be withdrawn. Needs migration `0125`.
  [Guide](https://www.vestiarion.xyz/docs/guides/early-payment-offers).
- **Bills paid to a vendor's bank account in Mexico.** An owner sets the workspace up for bank payouts from Settings,
  accepting BlindPay's terms on BlindPay's page, and an owner or admin gives a vendor its CLABE on Counterparties. That
  vendor's bills are then paid to its bank account in pesos over SPEI, through BlindPay, from the workspace's USDC on
  Arc: the CLABE is checked before BlindPay sees it, and only its bank and last four digits are kept. The agent decides
  on the bills as on any other, and a person approves every bank payout, after the approval card shows what the vendor
  receives by BlindPay's quote. A payout takes exactly the bill's amount or sends nothing, is asked for under the
  payment's own key, so BlindPay makes it once, and one BlindPay refunded is paid again only by a person. In
  this version a workspace is set up on BlindPay's development instance, with BlindPay's test business values; on Arc
  testnet BlindPay takes its test token, USDB, which an owner or admin mints to the operating wallet from the Bank
  payouts card (Mint 100 test USDB), and a payout is refused before the approve when the wallet holds too little of the
  token BlindPay takes. It needs
  `BLINDPAY_API_KEY`, `BLINDPAY_INSTANCE_ID` and `BLINDPAY_WEBHOOK_SECRET` and migration `0124`.
  [Guide](https://www.vestiarion.xyz/docs/guides/bank-payouts).
- **Won deals from Zoho CRM.** An owner or admin connects a Zoho CRM organization from Settings, and its won deals come
  in with their accounts and contacts under Deals on Bills & receivables; Plan collections fills in the New deal form
  from one, and nothing is planned until a person confirms it. A deal is won when its pipeline counts its stage as Closed
  Won (or, where the pipelines cannot be read, by the stage's name); open deals are listed as not won yet, and lost ones
  never come in. A planned deal changed in Zoho CRM afterwards (its amount, its closing date, a lost or open stage, or
  deleted) says so on its page, for a person to change the deal or keep it as it is. It works in each of Zoho's data
  centers but China's, reading only from the one the account lives in, and several workspaces may connect the same
  organization. Read only: nothing is written to Zoho CRM, and the deals are read every 15 minutes and on Sync now. It
  uses the Zoho client Zoho Books does (`ZOHO_BOOKS_CLIENT_ID` and `ZOHO_BOOKS_CLIENT_SECRET`, or `ZOHO_CRM_CLIENT_ID`
  and `ZOHO_CRM_CLIENT_SECRET` when both are set), with its own redirect URI, and needs migration `0123`; until it runs,
  the card says Zoho CRM is not set up on this deployment yet. [Guide](https://www.vestiarion.xyz/docs/guides/zohocrm).
- **Bills from Zoho Books.** An owner or admin connects a Zoho Books organization from Settings, and its open bills
  (open, overdue, partially paid or approved, due or dated in the last 90 days or later) come in for review on Bills &
  receivables, through the same check as a bill list; each becomes a payable only when a person adds it, and the agent
  decides it as any other. Drafts and bills pending approval never come in. A bill paid or voided in Zoho Books after it
  was added is flagged, and one partly paid comes in at what is left. A bill deleted in Zoho Books is not seen, since
  Zoho Books does not say when one is, and the guide says so. It works in each of Zoho's data centers but China's,
  reading only from the one the account lives in; a person with several organizations picks one, and several workspaces
  may connect the same organization. Read only: nothing is written to Zoho Books, and the bills are read every 15
  minutes and on Sync now. It needs migration `0122`, `ZOHO_BOOKS_CLIENT_ID` and `ZOHO_BOOKS_CLIENT_SECRET`; until
  0122 runs, connecting says Zoho Books is not set up on this deployment yet.
  [Guide](https://www.vestiarion.xyz/docs/guides/zohobooks).


### Changed

- **The security page says when a release's changes were not each reviewed.** It said every change is reviewed by an
  independent AI code reviewer before merge. Not every change in this release was, so it now says changes are reviewed,
  and that a release whose changes were not each reviewed so says it in its notes, as this one does.
- **The landing page's proof leads each network with whoever has paid on it.**
  - Arc mainnet, where no customer has paid yet, now leads with the team's own payments under "Paid by the Vestiarion
    team": how many and how much USDC. "None on Arc mainnet yet" is on the customers' line under them.
  - Arc testnet still leads with customers. On either network, customers' figures lead once any customer has paid
    there, and the two are never added together.
  - Both cards end the same way: the side that does not lead, then the team's latest payment there, on its explorer.
  - The figures are set larger, in the sans, with shorter and quieter descriptions.
  - Customers' shadow-mode verdicts read "Customers agreed", with the agent's decisions, in shadow mode.
  - The badges read Real USDC and Test USDC, on the landing page and on Open numbers.
  - Live capabilities is a list, one to a row, with where it runs. Live payments say they go through Circle.
  - "Verify it yourself" starts with verifying a ledger export, then where the model and the rules disagreed, each link
    with an icon of its own.
- **The docs read and find their way like a product's.**
  - The sidebar is grouped by what you are doing: Get started, Pay bills, Plan and report, Get paid, Trust and controls,
    Connect your tools and Developers, then the reference. Each section opens and closes, the one you are reading opens
    by itself, moving to another section closes the last, and the long ones split into short groups, such as Accounting
    and Sales and CRM.
  - Pages sit on a white reading surface with a breadcrumb, a stronger title and a lead, at about 75 characters a line,
    with an Edit this page on GitHub link.
  - Callouts carry their own colour, icon and label.
  - The docs' home leads with search and the two ways in, beside how a bill moves in four steps, then popular
    workflows, every section's first guides and the developer resources, three to a row on a wide screen, with no table
    of contents and one search field.
  - The bank payout guide draws its flow, from the bill to the vendor's bank, and puts its sandbox notice up as
    Important.
  - Every page keeps its address.
- **Arc and Circle stand out on the landing page as what Vestiarion is built on.** Under the integrations, "Built on
  Arc, with Circle" gives each a larger card. Arc's says payments are made there, each linked to its transaction,
  testnet for trials and mainnet for real USDC, and links the open numbers and the README's mainnet proof. Circle's
  names the wallets that hold the treasury and send each payment, with the Circle products that run on Arc testnet
  alone saying so, and links the README's Circle table and the code. The SDK is a line under the two.
- **Each kind of team on the landing page ends with the agent's decision, not a receipt.** Beside each story under
  "Who it's for", the card shows what the agent checked, each check passed or failed, and its decision and why: paid
  when every check passed, held for a person when a rule in code refused it, or scheduled for an early-payment
  discount's last day. Each card links to How the agent decides, and screen readers now read it.
- **The landing page's hero is quieter, and says what Invoice Capture does.**
  - The left column is three groups: the message, the call to action with shadow mode right under it, and Invoice
    Capture. The headline is a little smaller, so the column stands level with the sample bills.
  - "Capture invoices from Chrome" says the extension sends an invoice to your workspace as a draft. Beside it, a small
    Add to Chrome button carries the extension's own icon in place of a puzzle piece. The button shows on a computer
    only, where Chrome can install it; a phone sees a link to the guide instead.
  - The README's Add to Chrome is drawn like its other three buttons and carries the extension's own icon, in place of
    a button that redrew Chrome's logo.
  - The two sample bills are one list: the open one with its reasoning in focus, the held one a status row under it.
    Their checks no longer wrap into narrow columns, and their invoice numbers are no longer cut off on a phone.
  - The first bill says "Agent proposes: pay it". Its drawn Agree and pay is no longer a second blue button, and it
    tells a screen reader it is a sample's.
- **The landing page's integrations, grouped by what each tool does.** "Built on, and works with" is now Integrations,
  a section of its own before the developers': accounting (Xero, QuickBooks Online, Zoho Books), sales and CRM (HubSpot,
  Pipedrive and, newly shown, Zoho CRM), and work and team chat (Asana, Slack, Telegram), each group saying what its
  tools share and each card what is particular to its tool, with a link to its setup guide. Arc, Circle and the SDK sit
  together under the hood. QuickBooks Online's card, and its guide, say that the hosted service connects to QuickBooks
  sandbox companies only until Intuit completes its assessment of the app.

### Fixed

- **The agent no longer pays a bill early for nothing.** When the model chose to pay today a bill with no early-payment
  discount available, no shortfall and a due date ahead, the payment went, though nothing was gained by it; once, the
  model's own reasoning argued for the due date. Code now schedules such a bill for its due date, and the reasoning
  says so. A bill set for today, by a person from the payment plan or on a day chosen before, is still paid today.
- **The docs' sidebar keeps its first sections in view at the end of a page.** Scrolled to the bottom, the footer
  pushed the sidebar up under the header, so its first sections were hidden, and scrolling over the sidebar could not
  bring them back until the page itself was scrolled up. The footer now sits under the page, beside the sidebar, which
  stays below the header to the last line.
- **Bank payouts on Arc testnet are timed against USDB.** BlindPay takes its test token, USDB, there, but the agent
  weighed a bank-paid bill against the operating wallet's USDC and held it as short on cash, to be decided again once
  USDC came in. It now weighs the wallet's USDB alone, tells the model so, and holds a payment it would make for a
  person under the bank payout rule. Arc mainnet, where BlindPay takes USDC, is unchanged.
- **The connect pages of QuickBooks and Zoho Books name their data right.** They said "QuickBooks's data" and "Zoho
  Books's data"; they now say QuickBooks' and Zoho Books'. Usage this month names Asana's syncs "Asana", not "asana".

## [0.1.0-beta.7] - 2026-10-15

### Added

- **Vestiarion Invoice Capture is on the Chrome Web Store.** Install it with Add to Chrome from
  [its store page](https://chromewebstore.google.com/detail/vestiarion-invoice-captur/jfhjgbdbolhnneomgifdnjamoldlioan); Chrome keeps it up to date. The store's copy connects as soon as
  invoice capture is on, with no change on the deployment, as the downloaded copy does, which stays for where the store
  is not available. The landing page, the README and the [guide](https://www.vestiarion.xyz/docs/guides/invoice-capture#1-install-it)
  link it.
- **A new demo and product tour.** The README links [the demo](https://youtu.be/-gMv3ipzDyA) (2:55) and
  [the full product tour](https://youtu.be/yfDxzibSYQc) (7:15), recorded on the live product on October 15, 2026. Each
  sentence is shown on the screen it talks about, and the tour opens how the agent decided on three decisions.
- **Download the Chrome extension.** The invoice capture guide links a zip of Vestiarion Invoice Capture to download,
  extract and load into Chrome, until the Chrome Web Store lists it. Every downloaded copy has the same extension ID,
  set by a public key in its manifest, and Vestiarion allows it as soon as invoice capture is on, so it connects with no
  change on the deployment. A copy loaded from the repository's own folder still has an ID of its own.
  [Guide](https://www.vestiarion.xyz/docs/guides/invoice-capture#1-install-it).
- **Ready for the Pipedrive Marketplace and the Asana App Directory.** What to submit to each, field by field within
  their limits, with the scopes and why each is needed, the reviewers' path, a demo script, the listing images and the
  icons, is in [docs/distribution](docs/distribution).

### Fixed

- **Installing Vestiarion from Pipedrive leads to the connect page.** An install started in Pipedrive, such as Install
  now in the Pipedrive Marketplace, came back with no state of Vestiarion's and was refused as an expired link. It now
  opens the connect page, which says Vestiarion was installed from Pipedrive: pick the workspace, agree, and Pipedrive
  asks once more. Nothing is exchanged with Pipedrive before that. The same holds for every connector.

- **A payment sent again needs two people behind a new address too.** When the outcome of a payment's earlier send
  was never recorded, the agent looks the send up at Circle and, if Circle has none, sends the payment again to the
  payee's address as it stands now. It used to do so without asking who stood behind that address: a member could
  change a payee's address to their own wallet and confirm it while a payment waited, and the next cycle sent it there.
  Now, when sending it again would be the first payment to that payee at that address, with two different people not
  behind it, the agent holds it as `counterparty.new_payee` for a person, as its own decision would, for bills and
  milestones alike. Its reasoning says "Not sent again: this is the first payment to this address, …". Another owner,
  admin or approver pays it, and their Approve and pay, or Pay now, looks the earlier send up at Circle before sending
  anything, so a transfer Circle took is recorded rather than sent twice. A transfer recorded with its Circle
  transaction id is only checked, as before.
  [Guide](https://www.vestiarion.xyz/docs/guides/first-payment#6-approve-a-held-payment).
- **The agent looks for an unanswered send before holding it.** When Circle never answered a payment's send (the call
  ran out of time, Circle answered with a server (5xx) error or no id, or the send stopped before its answer was
  recorded), the transfer may have gone through anyway. The agent checked the payee's screening, address, first
  payment and two approvals before looking, or decided the bill again with every guardrail, so a payment that had
  moved could be recorded as held or flagged. Now the agent looks on Circle first, sending nothing: a transfer Circle has is recorded
  as paid, one not listed yet waits for the next cycle, and only a send Circle never took goes on to the checks or a
  new decision, for bills and milestones alike. A payout to another chain cannot be looked up this way, so it still
  gets those checks first, and can be held while Circle may hold it; Approve and pay then asks Circle for it under the
  same payment key, which Circle takes only once. With no operating account to look from, the bill or milestone stays
  where it is rather than held.
  [Runbook](https://www.vestiarion.xyz/docs/guides/payment-exceptions#outcome-unknown).
- **A payment counts as paid at the address it went to.** A payment sent again to a payee's new address, such as a
  held bill paid once the payee gave a new one, was recorded at the address its first attempt asked for. The new
  address kept counting as never paid, so later bills to it were held as first payments, while the old address counted
  as paid. Each send now records the address it pays. Payments already made keep the address they were recorded with.
  [Guide](https://www.vestiarion.xyz/docs/guides/first-payment#6-approve-a-held-payment).
- **A lost batch's milestones are all recorded paid in the cycle that finds it.** When milestones released together
  in one transaction lost Circle's answer, the agent finding that transaction for one of them records it on all of
  them, but the others were left pending, as if another request were still settling them, and recorded paid only on
  the next cycle. They are now reconciled in the same cycle.
  [Runbook](https://www.vestiarion.xyz/docs/guides/payment-exceptions#outcome-unknown).
- **A release from escrow already sent is recorded, whatever the contractor's address says now.** A milestone whose
  release went out from its escrow hold, locked for the contractor's old address, stayed verified every cycle, and its
  audit entry said to refund the hold and pay again, though the money had gone where the hold pays. The release is now
  recorded as paid and the hold as released, by the agent and by a Pay now that only checks it. Only a new release
  from such a hold waits for a person.

## [0.1.0-beta.6] - 2026-10-15

### Added

- **Capture invoices from Chrome.** Vestiarion Invoice Capture, a Chrome extension, sends an invoice you select on a
  page, or a file you choose, to your workspace as a draft: you check the fields it read, with what is missing named,
  and send it. It waits under **Captured drafts** on Bills & receivables until an owner or admin adds it as a bill,
  through the same add-invoice step as any bill, or discards it; a possible duplicate is said first. The extension
  connects by signing in and allowing it, never with an API key, and can only create and read its own drafts: it never
  adds a bill, approves or pays. A connection lasts at most 90 days, and ends when its member can no longer add bills.
  Settings lists connected extensions under **Chrome extension**, with Disconnect. The captured text is kept until the
  draft is decided, 30 days at most, and read in the console only when opened. Loaded unpacked for now; it needs migration
  `0121` and `CHROME_EXTENSION_IDS`. [Guide](https://www.vestiarion.xyz/docs/guides/invoice-capture).
- **A security page for reviewers.** [vestiarion.xyz/security](https://www.vestiarion.xyz/security) sets out, as the
  code does it today, how data moves through Vestiarion and where each boundary is: tenant isolation, what is encrypted
  and with what, who can approve what, how connector tokens are refreshed and revoked, how webhooks are signed both
  ways, the signed ledger, retention and deletion, how the model is used, and the services that process data, dated.
  It ends with what we do not claim, and is linked from every footer. The repository now has a security policy,
  [SECURITY.md](SECURITY.md): report a vulnerability privately with GitHub's **Report a vulnerability**, never in a
  public issue. The README opens with a five-minute path through the live app for anyone evaluating it.
- **Try the API from Postman.** Two Postman collections and an environment, served by the site and generated from the
  API's own description, so they always match it. "Vestiarion: Getting Started" goes from a key to a first answer in
  three reads (the workspace's status, its invoices, the agent's decisions with its reasoning), then adds a
  counterparty, at a wallet you control that you set first, and an invoice for it with a read-and-write key.
  "Vestiarion API reference" has every operation, with the answers and errors each one documents. No file holds a
  key, and no request can approve or pay. [Guide](https://www.vestiarion.xyz/docs/get-started/postman).
- **The MCP server, described for the MCP Registry.** `server.json` describes the remote MCP server for the official
  MCP Registry, with the API key as a required, secret header; publishing it is a manual step. The MCP page now
  says which key to use: a read-only key by default, and a read-and-write key only for an agent that should add
  records. [Guide](https://www.vestiarion.xyz/docs/ai-integration/mcp#which-key-to-use).

### Changed

- **The privacy page says more exactly what leaves Vestiarion.** It names each RPC node the server reads balances,
  fees and receipts from, which receive wallet addresses and transaction hashes only, and says the other chains' nodes
  are handed only to your own wallet. For each email to a workspace's invoice address, the model provider reads its
  first PDF, .eml or .txt attachment or else its text, and a Slack post about one that cannot be read names its
  sender's address. Google Analytics loads on every page, signed-in pages included. Each model provider handles
  requests under its own API terms, now linked, in place of a promise about training the code cannot keep. Deleting
  an account also deletes the payment approvals the person gave, which the ledger keeps, and their Slack and Telegram
  links, and the team's own record of a business stays when its workspace is deleted.
- **API write limits, said as they work.** Writes from one key come in bursts of up to 30, then one every 2 seconds,
  as the limits page and the API invoices guide now say.
- **The site says what Vestiarion is in plain words: your AI agent for bills and payments, for small businesses.** The
  landing page, the page titles and descriptions, the link preview image, the footer, the docs overview and the README
  lead with it, in place of "an accounts payable agent for small teams".

### Fixed

- **On Arc mainnet, the agent's spending limit always stands.** A workspace whose limit was missing or empty was read
  as having none; it is now held to the starting limit, 50 USDC a day and 150 USDC in 7 days, as a missing
  two-approvals figure already was.
- **An API write's idempotency outcome is deleted after its 24 hours.** It was given back for 24 hours, as documented,
  but the row, with its response, stayed. The daily cleanup now deletes outcomes older than that, in every workspace,
  and reports how many.
- **Connector consent says what the model provider does under its own terms.** The statements a person agrees to
  before connecting Xero, QuickBooks, HubSpot or Pipedrive no longer promise that the agent's model provider may not
  train on the facts it sees, which its terms do not say. They now say the provider (DeepSeek, on the hosted service)
  sees each bill's facts, or may see a deal's, under its own API terms, and the connect page links DeepSeek's API terms
  and privacy policy, as the terms of use do. Vestiarion's own promise stays: it never uses that data to train or
  improve any AI model. Pipedrive's also says that disconnecting stops the reading at once and revokes Vestiarion's
  access, which, as Pipedrive documents it, uninstalls Vestiarion from the company. New consent versions `2026-10-15`
  (Asana's did not change): any new connection or reconnection agrees to them, including Allow Vestiarion to book
  payments and Allow writing to HubSpot, which reconnect. An existing connection keeps the version it agreed to until
  it reconnects, and an accountant approves bookings on a Xero connection agreed under `2026-10-13` or `2026-10-15`.
  A connect page left open while the words changed now says so and shows them again, instead of recording words the
  person did not read.
- **An address a member asked the payee for needs a second person, as a typed one does.** Whoever creates a payee
  link now counts as having given the address the payee sends through it. When that person is also the only one who
  confirms the address, the agent no longer makes the first payment to it on its own: it holds it as
  `counterparty.new_payee`, and another owner, admin or approver pays it with Approve and pay, or Pay now on a
  milestone. Before, one admin could ask for an address, send their own wallet through it, confirm it, and the agent
  would pay it with no second person. Who created the link is read from the workspace's signed ledger, so deleting that
  account changes nothing. When someone else confirms the address, the agent pays as before. The card and the refusal
  say "You asked for this address with a payee link". No migration.
  [Guide](https://www.vestiarion.xyz/docs/guides/first-payment#ask-a-payee-for-their-address).
- **An address sent on GitHub always waits for a second person.** A GitHub account is tied to no member, and every
  bounty acts as the person who connected GitHub, whoever typed it, so any member who could write to the repository
  could have bountied their own pull request, sent their own wallet and confirmed it. For an address sent with
  `/payto`, and for any address no member can be named as having given, a confirmation no longer counts as the second
  person: the agent holds the first payment, and two different members stand behind it, one who confirms the address on
  Counterparties and another who approves it. Whoever confirmed it cannot approve it, and no one approves it alone
  before another member has confirmed it, since Approve and pay would confirm it itself. The member the bounty acts as,
  who adds the bounty's milestone, may pay it with Pay now once someone else confirmed it: a hold for the address alone
  is not theirs to be refused as the milestone's creator. "Who can act" and the overdue email leave out whoever cannot
  approve it. A bounty typed by the pull request's own author names no member.
- **Confirming an address always says who confirmed it.** A confirmation whose ledger entry could not be written is
  undone and refused, so it can be given again, rather than leaving a first payment no one could approve.
- **The only approver's own first payment is on the record.** The workspace's only approver still pays a first payment
  to an address they gave, asked for or confirmed, or that no one else confirmed, and its ledger entry now says they
  did it alone.
- **A first payment is the first to that payee at that address.** An address the workspace had paid for someone
  else, such as a member paid once as a contractor, let the agent pay any other counterparty pointed at it with no
  second person. The check now counts only payments to the same counterparty.

## [0.1.0-beta.5] - 2026-10-15

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
- **What to do when a payment does not settle.** A payment slow to confirm, of unknown outcome, failed, cancelled or
  not sent now says what to do about it where you meet it. Under the stages of **Where the payment is**, on its card,
  a **What to do** block says who acts, what Vestiarion already did, the next step and the trail, with the transfer's
  Circle id. On Treasury, **Payments in flight** gives each payment slow to confirm or of unknown outcome a
  **What to do:** line, and links the runbook. The transfer watch's email links it too. A new guide lists every state
  with the same words, including why a confirmed payment cannot be returned or reversed on Arc.
  [Guide](https://www.vestiarion.xyz/docs/guides/payment-exceptions).

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
- **Paying a bill whose earlier transfer may exist says it checks first.** When a transfer was already sent, or Circle
  never answered one, **Approve and pay** and **Pay now** no longer ask "Pay … now?": the confirmation asks to check
  the payment already sent, or to look for the earlier one on Circle first, its button reads **Check it** or
  **Look first**, and the notice while it runs says it is checking, never sending. Approve and pay from Slack says the
  same before it runs.
- **Approve and pay and Pay now look for an unanswered send before anything else.** Where Circle never answered a
  send, they now look for it on Circle first, as Reject, Return and Close do. Found, it is recorded and nothing new is
  sent. Not listed yet, nothing is claimed or sent, and the answer says when to try again; before, the approval went
  ahead and the agent's cycle looked for it later. Once Circle shows none, 15 minutes after the send, the payment is a
  new one, and every check a new payment gets applies: screening and limits, two approvals, the funds, and in shadow
  mode the verdict on the agent's decision. Two people approving at once never both conclude it was never sent: the
  second is asked to try again. A payout to another chain, which Circle cannot list this way, is still asked for again
  under its own payment key, which Circle takes only once.

- **The header names the page you are on.** On a page inside a section, the line at the top that says where you are
  now ends with that page, where it stopped at the section: Commissions reads "Your workspace › Bills & receivables ›
  Commissions". A deal, a project or a payment's evidence ends with the deal's title, the project's name or the bill's
  or milestone's name, and the section's name takes you back to the section. A long name is cut short, and pointing at
  it shows it whole. On a phone, the bar at the top names the page, with its section under it.

### Fixed

- **A payment whose sending was cut off is no longer called sent.** When Vestiarion started a payment and stopped
  before Circle's answer was recorded, Approvals said "A payment was already sent" and Reject and Return refused it.
  It is now told as a payment of unknown outcome, as its track already did: Approvals and Contractors say it may still
  be sending, or its answer was lost, and Reject, Return and Close look for it on Circle first, so it is closed if
  Circle never took it.
- **A milestone paid in one transaction with others is never closed while that transaction may have paid it.** When
  the agent released several milestones together and Circle's answer was lost, Close looked for each by its own
  reference, which Circle does not list for a batch, and could close a milestone the batch had paid. Each is now
  looked for by the batch's own reference, as the agent's cycle and Pay now already did, and nothing concludes until
  Circle shows no batch 15 minutes after it was sent.
- **Pay now on a transfer already sent never sends a new one.** When Pay now only checked a milestone's transfer in
  flight and Circle reported it failed by then, a new transfer went out without the checks a new payment gets. Now the
  failure is recorded, the milestone is held again, and the next Pay now sends a new transfer after every check, as
  Approve and pay already did for an invoice.
- **Slack's confirmation stays within Slack's limits.** A payee with a very long name could make Slack refuse the
  message carrying a stopped payable's card. The name is now cut short in the confirmation, which never runs past
  Slack's 300 characters.
- **The evidence page no longer calls a payment that may still settle a failure.** Its payment step said "The transfer
  failed." for a send Circle never answered, a transfer whose last read failed and a Gateway payout that may still be
  minted. Each is now said as what it is, and a milestone's points to Contractors rather than Approvals.
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

[Unreleased]: https://github.com/duongnq2798/vestiarion/compare/v0.1.0-beta.11...HEAD
[0.1.0-beta.11]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.11
[0.1.0-beta.10]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.10
[0.1.0-beta.9]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.9
[0.1.0-beta.8]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.8
[0.1.0-beta.7]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.7
[0.1.0-beta.6]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.6
[0.1.0-beta.5]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.5
[0.1.0-beta.4]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.4
[0.1.0-beta.3]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/duongnq2798/vestiarion/releases/tag/v0.1.0-beta.1
