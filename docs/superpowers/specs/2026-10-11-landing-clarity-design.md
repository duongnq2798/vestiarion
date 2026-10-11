# Landing clarity: a page a business owner understands first

Date: 2026-10-11. Branch `feat/landing-clarity`.

## Why

The landing page was built for readers who already knew what a signed ledger and a model-versus-code boundary are.
Measured on www.vestiarion.xyz before this change:

- The hero ("The agent pays your bills. Evidence remains.") did not say what kind of bills, for whom, or what the agent
  does with one. Its supporting sentence named Arc testnet, Arc mainnet, USDC and "a chain anyone can verify" in four
  lines. The first screen's preview used rule ids (`invoice.duplicate_of_settled`), hashes and "ap · pay".
- The page was about 10,000 px tall at 1440 px and about 15,900 px at 375 px. At 1024×768 the hero's call to action
  sat below the fold.
- Three labels led to the same step ("Try it on your bills", "Open console", "Open a workspace"), and the last two
  dropped shadow mode.
- All four "evidence" links under "Claims with receipts" went to `/onboarding`.
- The largest figure in the measurements, payments settled, counted the team's own payments with customers'.
- Nothing said, on the page, that trying it needs no wallet or funds, though the product allows exactly that: a sandbox
  in shadow mode decides on real bills with no wallet (guides/shadow-mode).

## Direction

Business first, with the technical difference kept and moved behind progressive disclosure. The page leads with what
a small team gets, says how money is controlled in plain words, then shows proof. The full mechanism is a page of its
own.

## Sections

| Id | Section | What it does |
|---|---|---|
| H1 | Hero | Eyebrow "An accounts payable agent for small teams"; "Every bill checked before it's paid. *Every decision on record.*"; one sentence on what the agent does with an invoice; one call to action; "Start in shadow mode … No wallet or funds needed to start." |
| H2 | Hero preview | Two sample bills drawn with the product's own labels ("Waiting for your verdict", "Agent's reasoning", "Do you agree with the agent?", "Held for you", "Blocked by code, not by the model"), checks in plain words, and a caption saying payees and amounts are examples. Nothing in it can be pressed. |
| S1 | How it works | Three steps: add your bills, see what the agent decides, agree and then let it pay. Title: "Evaluate first. Turn on payments later." |
| U1 | Who it's for | One tab per kind of team (software agencies, creative studios, cloud and DevOps, Web3 studios): a bill that team knows, three things Vestiarion does with it, the decision it ends with, and the guide. Every panel is in the HTML. |
| S2 | Safety and control | The page's one dark section. Two bills take the same first step (the agent proposes to pay) and end apart (paid, or held because code refused it). Then six questions a cautious owner asks, each tagged with what enforces the answer: rules in Vestiarion's code, a contract on Arc, or your team. |
| P1-P3 | Proof | The agent's latest real decision (team workspace, signature checked in the browser) and, since 2026-10-11, the decisions before it (`2026-10-11-landing-recent-decisions-design.md`), the open numbers with customers' figures alone under "Customers" and the team's on a line of their own, what runs live, and where to check each claim without us. |
| — | For developers | The API/SDK/MCP/GitHub terminal, unchanged, and the built-on strip. |
| F1 | Questions | Seven questions, folded: crypto, payees' wallets, automatic payment, fitting the current workflow, real money, testnet and mainnet, who sees the bills. No price question: there is no published price. |
| C1 | Close | "See what the agent decides on your next bill." The same call to action, the four steps after it, and a guided setup (`/studios#guided-setup`) for a team that wants a call. |
| D1 | /how-it-decides | The previous hero's decision receipt in its arch beside the live ledger head, the decision loop step by step, and the claims with receipts, their links now pointing at the evidence. |

Removed from the landing: "What the agent pays" (six feature cards; cross-chain and EURC are Arc testnet only and
belong in the guides, which the use cases link), the Product Hunt badge in the hero (now in the full footer: launch week
is over), and the hero's provenance strip (now in the proof).

## Copy rules applied

- Every claim was checked against the code or the guides on 2026-10-11: shadow mode with no wallet (guides/shadow-mode
  "your first verdict needs no wallet"), Pause agent (guides/go-live), a first payment to a new address needs two
  people (`counterparty.new_payee`), two approvals above 100 USDC on Arc mainnet and a daily and 7-day figure that
  always applies there (guides/go-live "On Arc mainnet"), the wallet-held treasury paying only through a contract it
  deploys and "Vestiarion never holds your USDC" (path C), no second transfer while one may settle and the 15-minute
  notice (guides/first-payment), bounties within the daily limit (guides/github), manual milestone verification
  (guides/pay-a-contractor).
- The answer about Arc mainnet says it is open to anyone only when the deployment opens it to everyone
  (`mainnetOpenToEveryone`); otherwise "for the accounts it is open to so far".
- No disclaimer talks the product down (tests/landing-hero.test.tsx keeps the list); "No wallet or funds needed to
  start" says what trying it asks, not what the product lacks.
- The hero keeps the technical vocabulary out: the test fails on ledger, hash, chain, testnet, mainnet, guardrail or
  counterparty there.

## Journey

Every call to action goes to `/onboarding?shadow=1`. Signed out, the proxy sends the visitor to
`/login?next=%2Fonboarding%3Fshadow%3D1`; the sign-in page now says what follows the link ("Next, you name your
workspace and add one of your bills to see what the agent decides. No wallet or funds needed to start."). After the
link, the workspace form opens with shadow mode ticked, and the console's checklist starts with the first bill.

## Measurement (M1, M2)

- Each call to action carries `data-cta` (`hero-try`, `hero-how`, `header-start`, `menu-start`, `final-try`,
  `final-guided`, `decides-try`). Where Google Analytics runs, a click sends `cta_click` with that name and the redacted
  path; the privacy page says so. Activation (a real bill, a decision, a verdict) is read from the database on
  `/admin/growth`, not from clicks.
- The page carries `SoftwareApplication` structured data with no price, and its title and description say what the
  product is. The social image says "Every bill checked. Every decision on record."

## Not changed

Payment, approval and guardrail code; onboarding beyond the sign-in note; the legal pages' intros (they still call
Vestiarion "an autonomous treasury agent on Arc testnet": the partner's to rewrite).

## Streaming the hero (S1, follow-up)

Measured on production after the redesign shipped: LCP 4.2 s at 375 px under Slow 4G and 4x CPU, and the hero's HTML
arrived only with the proof's figures, because the page awaited every production read (open numbers, the latest
decision, chain modes, the reserve count) before it returned anything. The page now starts those reads and returns at
once; the proof section draws its words and links, and streams the latest decision, the figures and the live legs in
behind fallbacks sized like what they hold. On a local production build, cold, the hero arrived at 0.48 s and the
figures at 1.2 s; LCP at 375 px under the same throttling was 1.6-1.9 s, CLS 0.
