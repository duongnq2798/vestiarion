# The payee lock on the landing, with its proof on Arc

Date: 2026-10-26. Status: accepted.

## Why

The payee lock (`2026-10-20-payee-lock-design.md`) is the control that stops the fraud small businesses meet most: a
vendor's payment address quietly changed to someone else's wallet. The landing never named it. Its safety section said
only that "a first payment to a new address waits for a second person", and its one worked case is a spending-limit
refusal. The lock has run in production, and a payment it held settled on Arc testnet only after the holds ended. A
visitor should see that, step by step, with a link they can check.

## What

**PLL1. A second worked case in Safety, after the refusal.**
- It sits in the Safety section (`src/components/landing/Safety.tsx`), the page's one dark section, under the existing
  historical refusal, which stays first.
- No new top-level section, no new anchor in the header, and nothing in Proof, which shows only live reads by design
  (bill journey spec; `tests/landing-proof.test.tsx` bans historical strings there).
- Its heading is a plain question, as the first case's is: "What happens when a payment address changes?"

**PLL2. Written facts, not read ones.**
- `src/components/landing/payee-lock-example.ts` holds the case, as `safety-example.ts` holds the refusal: a past
  decision's facts do not change, so they are written rather than read, and the page makes no read for them.
- The facts, read from production read-only on 2026-10-26 and cited in the file's doc comment, all on 2026-10-20 UTC:
  - entry 4832, 11:12:39: the payee lock turned on with a 4-hour wait after an address changes;
  - entry 4839, 11:14:01: the vendor's payment address changed, to a fresh wallet holding 0 USDC;
  - entry 4840, 11:15:06: a 3.00 USDC bill was added;
  - entry 4843, 11:15:17: the agent decided to pay and code held it, `counterparty.address_unconfirmed`;
  - the member who had entered the address tried to confirm it and was refused ("You entered or asked for this address,
    so someone else confirms it.", per the payee lock spec's rollout record). There is no ledger entry for the refusal;
  - entry 4863, 12:10:52: a second member confirmed the new address;
  - entry 4866, 12:11:00: the agent decided to pay again and code held it, `counterparty.cooling_off`;
  - entry 4917, 15:15:56: the held bill reopened;
  - entry 4919, 15:16:07: the agent paid it.
- The transaction is `0x49787501…0551` on Arc testnet: success, block 68200055, block time 15:16:04 UTC, 3 USDC from
  the workspace's operating wallet to the new address, sent as a Circle smart-wallet user operation (EntryPoint
  `handleOps`), not through the spending-limit contract. The README already cites it.
- The workspace is the team's own on Arc testnet, labelled "Vestiarion team workspace" as the refusal is; neither it nor
  the vendor is named. It was live, never in shadow mode (it has no `shadow_mode_started` entry), so the case's label
  says "live". Each case names its own mode; the refusal keeps "shadow mode".
- The network is `ARC_TESTNET`, named through its `label`, never a literal (network copy ratchet).

**PLL3. Five steps, each with the time the ledger recorded it.**
1. The address changes (the lock already on, with its 4-hour wait; then the bill came in).
2. Code holds it: the agent decided to pay, `counterparty.address_unconfirmed` held it.
3. A second person confirms: the member who entered the address was refused, in the product's words; a second member
   confirmed it.
4. Code holds it again: the agent decided to pay again, `counterparty.cooling_off` held it through the 4-hour wait;
   the address was confirmed by then (entry 4863), but it had changed at 11:14:01 UTC (entry 4839), less than an hour
   earlier.
5. Paid: after the wait the bill reopened and the agent paid 3.00 USDC to the confirmed address.
- Each step says only what that workspace recorded. Why the lock or its wait exists is general process, so it is said
  with the lock's description (PLL5), never in a step (`docs/design/visual-system.md`: "Explain general process
  separately from observed events").
- Each step shows its ledger entry number and its UTC time to the second, from that entry; the header shows the day.
- Each step's tone is one of the dark section's: neutral for an event, amber for a hold, and a new green "paid" tone
  (`border-proof-line/40 bg-proof/10`, label `text-proof-line`, as `HowItWorks` uses on ink) for the payment.
- Rule ids are shown as the refusal shows its rule, and are held to the product's words for them (`ruleLabel`).

**PLL4. The proof on Arc, and what it does and does not show.**
- A proof block names the network, the amount, where it went and links the transaction on the explorer, built from
  `ARC_TESTNET.explorer`.
- It tells the chain's time from the ledger's, as `docs/design/visual-system.md` asks: "Confirmed on chain" 15:16:04
  UTC in block 68200055, "Recorded in the ledger" 15:16:07 UTC.
- It says plainly that the lock is held by Vestiarion's code and by people, not by a contract, and that the transaction
  shows what followed: the payment settled only after both holds ended, to the confirmed address, for the bill's
  amount. No copy says a contract checked a payee or refused anything.
- The explorer link is styled by hand in `text-proof-line`: `Hash`'s `text-proof` is unreadable on ink.

**PLL5. The lock by name, in one sentence a business owner reads.**
- "The payee lock" is named, for the first time on the landing.
- One sentence says what it does: when a vendor's payment address changes, nothing is paid to the new address until a
  person confirms it, recording how they checked it with the vendor, and any wait you set has passed; whoever entered
  the address cannot confirm it while someone else can.
- One more says how it is set: an owner turns it on in Settings, with a wait of 4, 24, 48 or 72 hours, or none (read
  from `COOLING_HOURS_CHOICES`), and a workspace created on Arc mainnet starts with it on, with no wait. Between the
  two, one says why a wait helps, in the product's own reason (the Settings panel's 24-hour choice, the first-payment
  guide): "A wait gives the real vendor time to notice a change they did not make."
- This general text is set apart from the observed steps. On a wide screen it is the left column's first row, at its
  own height (`lg:grid-rows-[auto_1fr]`); the proof sits right under it, in the row that takes whatever height the
  steps, on the right across both rows, need beyond the two. Without the row sizes the steps' height was shared
  between both rows and left a blank under the text.

**PLL6. Links.**
- "View the payee lock case source" opens the committed `payee-lock-example.ts` on GitHub, as the refusal links its own.
- "How the payee lock works" opens `/docs/guides/first-payment#payee-lock`, with prefetching off (`landingPrefetch`,
  landing motion M4).

**PLL7. Readable on ink, and still at rest.**
- The line colours the dark section sets text in (`agent-line`, `proof-line`, `held-line`, `refused-line`) reach 4.5:1
  on ink, and each step's label on its own tinted box over ink; `tests/ui-tokens.test.ts` asserts both.
- Nothing moves: no animation, no new client component.
- No colour literal, and entry numbers are interpolated (`#${entry}`), never written after a quote in a `.tsx` line.

**PLL8. Docs.**
- The first-payment guide's payee lock section gains the proof: the transaction link and what it shows, on Arc testnet.
- The controls guide, which "Explore all safety controls" opens, names the payee lock beside the address checks.
- `ARCHITECTURE.md`'s landing Safety bullet and `CHANGELOG.md` say what changed. The README's proof already cites the
  transaction correctly. Its safety table's payee lock row, stale since the lock started on for Arc mainnet, said
  "Opt-in", that only someone other than whoever entered an address confirms it, and that approving never confirms
  one; it now says what the code does and the landing says: off on Arc testnet until an owner turns it on, on with no
  wait for a workspace created on Arc mainnet, a lone member confirms alone and the record says so, and with the lock
  on approving no longer confirms an address. No API, webhook or ledger change, so no API changelog entry. No
  migration.

## Tests

- `tests/landing-safety.test.tsx`: two worked cases after the principles (h3 count `PRINCIPLES.length + 2`); the first
  `<ol>` is still the refusal's three steps; the second case's label with its network and "live", its five steps in
  order with their entries and times, its two rules in the product's words, the refusal quoted as the product says it,
  the transaction link, block and both times, the honest scope, the source and guide links, and no name of the vendor
  or workspace. The guide and the README cite the same transaction. Why a wait helps sits before the steps, and no
  step says it; step 4 says when the address changed, held to step 1's time. The wide-screen grid sizes its rows
  `auto` then `1fr`, with the steps across both.
- `tests/readme-facts.test.ts`: the README's payee lock row, held to `MAINNET_STARTING_PAYEE_LOCK` and
  `COOLING_HOURS_CHOICES`: off on Arc testnet, on with no wait on Arc mainnet, the four waits, the lone member's
  confirmation, and approving no longer confirming an address with the lock on.
- `tests/landing-prefetch.test.tsx`: the guide link is not prefetched.
- `tests/network-constants-ratchet.test.ts`: `payee-lock-example.ts` reads `ARC_TESTNET` on purpose, with why.
- `tests/ui-tokens.test.ts`: the dark section's line colours on ink and on their step tints.
- `tests/docs-guides.test.ts`: the controls guide quotes **Payee lock** from its Settings panel.
- Unchanged and still passing: `tests/motion-policy.test.ts` (Safety moves nothing at rest),
  `tests/network-copy-ratchet.test.ts`, `tests/ui-consistency.test.ts`, `tests/landing-stream.test.tsx`.
