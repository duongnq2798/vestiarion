# Landing for a business owner: the hero, and the latest decision

Date: 2026-10-08. Status: approved scope (the partner chose items 1 and 2 of a landing review), design decided here.

## Why

The landing's hero speaks to someone who verifies ("Money moves. Evidence remains."), not to the business owner who
would use the product. It says what the agent is, not what the owner gets, and it never mentions shadow mode, which is
how an owner tries the agent on real bills without changing how they pay. Further down, the landing shows the founding
workspace's chain head (sequence and hash), but the founding workspace has not decided anything since 2026-09-30: the
team's real decisions happen in other team workspaces.

## L1. The hero speaks to the owner

- Eyebrow: "An agent for your bills · Live on Arc mainnet" (Arc testnet until Arc mainnet opened to everyone; see
  "Naming the network" below).
- Headline: "The agent pays your bills." with "Evidence remains." kept as the second, serif line.
- Lead: keep paying as you do, the agent decides each bill beside you; agree and it is paid in USDC on Arc testnet at
  the same amount, disagree and nothing moves; every decision, refusals included, is signed into a chain anyone can
  verify.
- Primary button: "Try it on your bills" when this deployment offers a hosted testnet wallet, "Open a workspace"
  otherwise (unchanged rule); both open `/onboarding`. Secondary: "How a decision is made", unchanged.
- Under the buttons, the existing sign-in line, then a link to the shadow mode guide.
- Product copy rules hold: Arc testnet is named plainly, no disclaimers about money.

### Naming the network (2026-10-08, Arc mainnet open to everyone)

The platform's own copy names **Arc** for what both networks share (signing, the decision loop, the footer, the social
card), **Arc mainnet** for a claim about real money ("Live on Arc mainnet"; paying real bills), and **Arc testnet**
only for what is Arc testnet's: shadow mode, a wallet in one click, Circle's faucet, and what Go live lists as not on
Arc mainnet yet (payouts to other chains, the EURC swap, the USYC reserve, escrow). The lead tells the path: try it
beside how you pay today on Arc testnet, then the agent pays real bills on Arc mainnet within the spending limits you
set. A workspace's own pages already name its network from its profile.

## L2. The latest decision, from the team's own workspaces

A band right under the hero: the newest decision the agent made in a team workspace, as facts anyone can read, and a
check of its signature that runs in the reader's browser.

### Which decision (R1)

The newest ledger entry by the agent whose action is a decision on a bill or a milestone (`ap_pay`, `ap_schedule`,
`ap_hold`, `ap_request_info`, `ap_flag_fraud`, `milestone_release`, `milestone_hold`), in a workspace that is:

- the team's, by the rule `/open` lists payments with (0037 R2): the founding workspace, or one a team member created.
  A workspace whose creator deleted their account is never shown, since it may be a former customer's;
- live, not a sandbox, on either network;
- about a payee who is not sample data.

A customer's decision is never shown, in any form.

### What is shown (R2)

Only facts that name no one. Never the entry's summary, the model's reasoning, a person's reason, a name, an address, or
an id of a bill, payee or workspace.

- What happened, in words built from the action, the amount and the currency: "Paid a supplier's bill of 0.35 USDC.",
  "Scheduled a 0.35 USDC bill for Oct 10.", "Held a 0.40 USDC bill.", "Paid a contractor's milestone of 0.30 USDC.".
- Why a hold held, from its recorded marker or guardrail rule, in words without names: waiting for a person's verdict
  in shadow mode, short of cash, the agent paused, the spending limit, or the rule code refused it by (payee's payment
  limit, unconfirmed address, not screened yet, screened high risk, repeats a paid bill, first payment to a new address
  needs two people, purchase order or receipt missing, and so on).
- Who decided: the model (Anthropic, OpenAI or DeepSeek) or the written policy; whether the written policy agreed;
  whether code let it through or refused it; a person's verdict when one was given (agreed, disagreed), or that one is
  awaited.
- When, as "2 h ago" from the page's own read, and on which network.
- The transaction on the explorer, when the decision paid and its reference is an on-chain hash, or when a person paid
  it afterwards (0088): a payment held for a person's verdict, or held and then approved, is sent by that person, so the
  agent's entry never records it. Its bill's or milestone's confirmed payment intent gives the hash. Once a verdict is
  given, the band never says the decision still waits for one: "Paid a 4.50 USDC bill after a person agreed.", or that
  the person disagreed and nothing was paid.
- The entry's sequence number and its signature check.

### The check in the browser (R3)

The entry's text stays private, so the page cannot prove that the facts above are its content. It proves what it can,
and says so: that the platform's ledger key signed the entry's body hash, and that the entry follows the one before it
(`hash = sha256(prev_hash || body_hash || signature)`). The page sends the body hash, signature, previous hash, chain
hash, key id and the public halves of the platform's keys; the check is the receipt verifier's own code
(`src/lib/receipts/verify.ts`), split so the signature-and-link half runs without the body. A browser without Ed25519 in
Web Crypto is told the check could not run here, never that it failed.

### How it is read (R4)

Migration 0087 adds `latest_team_decision()` (0088 adds the payment that followed a decision): security definer, `search_path = ''`, executable by the service role
only, returning one jsonb document or null. It returns the workspace id for the server's own use (none today) and the
fields above; the server never passes the workspace id, or anything not listed in R2, to the page.

`src/lib/platform/latest-decision.ts` calls it through `platformDb()`, parses it, and returns the band's view or null.
Until the migration runs, or if the read fails, the band is not shown and the rest of the landing is unchanged.

## L3. What the agent pays

A grid of six cards right under the latest decision, so an owner sees at once which of their payments the agent can
take, each in their own words, with a small illustration and a link to the guide that says how it decides. Every card
states only what the product does today, as its guide says:

| Card | What it says | Guide |
|---|---|---|
| Supplier bills | forwarded or read from a PDF, matched to the purchase order and receipt, paid on the discount's last day or the due date | first payment, When the agent pays |
| Freelancers and contractors | paid once the work is verified; a new freelancer gets a link to say where | pay a contractor |
| Bounties on pull requests | `/bounty 25` on a pull request; paid once merged, the transaction posted on it | GitHub, Attach a bounty |
| Retainers and subscriptions | set up once, each period becomes a bill, paid no later than due | first payment, Pay something every period |
| Payees on other chains | Base, Arbitrum or Ethereum Sepolia from Arc, through CCTP or a Gateway balance when cheaper | first payment, Pay a payee on another chain |
| Bills in euros | paid in EURC; a USDC swap through Circle when short, within a 3% cost cap | first payment, Invoices in EURC |

Under the grid, one line on the other direction: a client's pay link, matched on arrival, and reminders the agent
times (first payment, Get paid by a client). A caption says the illustrations use example payees and amounts, and that
the steps, checks and rules are the agent's own, as the hero's replay does. A test holds every link to a guide and a
heading that exist.

## Out of scope

A customer story (only with a named business's consent) and a new illustration: later items.

## Cost if wrong

L1 is copy: reverting is one commit. L2 publishes facts from the team's own workspaces only; if a field proved too
revealing, dropping it from the server's view hides it at once, without a migration.
