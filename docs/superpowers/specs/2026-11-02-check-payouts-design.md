# Payout batch check: every address in a batch, before it is sent

Date: 2026-11-02. Status: accepted (decided under the standing autonomy grant); built on branch feat/check-payouts, in
review. Where the build reads the rules more narrowly, or adds one, "As built" at the end says so.

## Why

A batch payout sends many transfers at once: a Safe CSV Airdrop, a Disperse list, an exchange's batch withdrawal, or a
sheet of contractors and amounts. One wrong row loses that row's money for good, and nobody reads 300 addresses by eye.
Address poisoning puts an address with the same first and last digits as a real payee into a wallet's history, and from
there it is copied into the next batch. A study of Ethereum and BNB Chain from Jul 2022 to Jun 2024 counted about 270M
poisoning attempts and at least $83.8M lost (Tsuchiya, Dong, Soska and Christin, "Blockchain Address Poisoning",
USENIX Security 2025).

The free address checker (`/check-address`, `2026-10-21-address-checker-design.md`) checks one address at a time
against the ones someone knows. The vendor check (`/check-vendor`) checks a vendor list's names against OFAC, and its
wallets too, but it does not read a payout file's amounts or tokens. Neither reads a batch the way it will be sent.

This page reads the batch file itself, checks every row's address with the address checker's rules, compares every
address with every other in the batch, reads the amounts and the tokens, and gives the file back with a verdict on each
row. Nothing is sent anywhere. Vestiarion does the same for every payout inside a workspace (payee lock, OFAC wallet
screening, lookalike checks), so the step after the check is short.

## What

**CP1. The page** (`/check-payouts`, `src/app/check-payouts/page.tsx`).
- Public and static, at the top level, like the other free tools: not under `/tools`, which serves downloads.
  `requiresSession` lets it through.
- Title "Batch payout address check, free" (the root layout adds the name), a description, a canonical address and
  social cards. Its heading: "Check a batch payout before you send it".
- Under the checker: how it works, and what it does not do; then what Vestiarion does with payouts and the shared
  `ToolCta` (CP12).
- It is `check-payouts` in `FREE_TOOLS` (`src/lib/free-tools.ts`), so the footer's Free tools group and the sitemap
  list it. `/check-address` links to it for a whole batch, and `/check-vendor`'s "what it does not do" links to it for
  amounts and tokens.
- The OFAC list's date is shown wherever a result is, read from `ofac-sdn-evm-wallets.json` as `/check-address` does.

**CP2. The batch** (`PayoutBatchChecker`, `src/components/payout-check/PayoutBatchChecker.tsx`).
- A CSV, TSV or text file chosen or dropped (at most 2 MB), or rows pasted from a sheet or a text box.
- Read with the bill import's readers, `decodeList` and `readTable` (`src/lib/bill-import/table.ts`), with one step
  before them (`readPayoutBatch`, `src/lib/payout-check/read.ts`): a list in Disperse's form, each line an address and
  an amount separated by a space, a comma or `=`, with no column names, is read as two columns. Only when every
  non-empty line has that form. After a comma the amount holds no comma: `0x…,100,8453` is a CSV of three columns.
- Known forms, found by their column names:
  - Safe's CSV Airdrop: `token_type,token_address,receiver,amount,id` (and the older `token_address,receiver,amount`);
  - Disperse: `address amount`, one a line;
  - any sheet with an address column and, optionally, a name, an amount and a token column.
- The first row is read as column names when one of its cells names a column the check knows. The person can say
  otherwise, and change any column's match, as on `/check-vendor`.
- Columns (`detectPayoutColumns`): **Address** (needed: receiver, recipient, address, wallet, wallet address, to,
  payout address, pay-to address, destination and the like), **Name** (name, payee, vendor, contractor, label,
  recipient name), **Amount** (amount, value, quantity, qty), **Token** (token, token address, token_address, asset,
  currency, symbol), **Token type** (Safe's `token_type`). Of several columns named as an address, the one whose
  first rows hold the most addresses; a "Recipient" or "Receiver" left over is the name. Without column names, only
  the address and the amount are found, by what the first rows hold.
- At most 5,000 rows (`PAYOUT_ROWS_MAX`). A longer batch is checked up to its 5,000th row, and the page says how many
  were left out. A row with no address and no amount is skipped.
- **Try an example** loads a made-up batch (CP11). **Download the example** saves it as a CSV.
- While the check runs, the button shows it is busy and takes no second press, as on `/check-bills`.

**CP3. Each row's address** (`checkAddress`, `src/lib/address-check.ts`, unchanged rules).
- An EVM address, read as `/check-vendor` reads a wallet cell (`evmPart`: a `0x` address, 40 hex digits, a chain
  prefix such as `base:0x…`, or a payment link such as `ethereum:0x…@1`). A cell holding a character outside ASCII is
  first checked, up to the end of its address, for a hidden character or another alphabet's letter that `evmPart`
  would read past (one before the `0x`, or a `0x` whose x is not Latin); only those characters are judged there, so a
  prefix's or a link label's Latin letters are not. The address checker's rules, unchanged:
  - empty, hidden characters, letters from another alphabet that look like Latin ones, no `0x`, wrong length, not hex;
  - the EIP-55 checksum of a mixed-case address;
  - on OFAC's SDN list (the EVM wallet snapshot);
  - a zero, burn or system address, or a token contract (USDC, EURC on the chains Vestiarion knows): money sent there
    does not reach a person.
- A name such as `northwind.eth` is not looked up (that needs the server): "Not checked: an ENS name is not looked up
  here. Check the address it points to on the day you pay."
- Anything else (a Bitcoin, Solana or Tron address): "Not checked: only EVM addresses (0x) are checked."

**CP4. Across the batch** (`checkPayoutRows`, with `lookalikeNeighbours`, `src/lib/payout-check/findings.ts`). Each
row's address is compared with every other row's:
- **Made to look alike** (`madeToLookAlike`: at least 3 hex digits shared at each end, or 5 at one, and not the same
  address). Both rows are told to stop: one of the two is very likely not the payee's. The words say which digits the
  two share and how rarely two unrelated addresses do (`sharedWords`, `chanceWords`).
- **Sized to the batch**: those odds are for one pair, and a batch of n addresses compares n(n-1)/2 pairs, so a long
  one holds lookalikes by chance (5,000 addresses hold about two dozen pairs sharing 5 digits at an end). A pair is a
  stop only while a batch its size would hold one sharing as many digits by chance less than once in 100 batches
  (`chancePairs`, `CHANCE_PAIRS_MAX`); past that, both rows are to look at, and the words say how often chance does
  it: "in a batch of 5,000 addresses, about 12 pairs share that many digits by chance". Small batches keep the rule
  above: 5 at one end is a stop up to about 145 addresses, 3 at each end up to about 580, and 4 at each end at any
  size the page checks.
- **Sharing 4 digits at an end** (`PARTIAL_MIN`): a row to look at, not a reason to stop.
- **The same address on more than one row**: to look at. When the rows also share the name and the amount, it says the
  row may be in the batch twice; when the names differ, it says one address is given for two payees.
- **One name with two or more addresses** (names compared as the bill check groups vendors, `vendorKeyOf`, built on
  `nameKey`, `src/lib/invoice-document/match.ts`, so names in another script are not one for sharing a Latin word): to
  look at, naming the rows.
- Only pairs that share digits at an end are compared digit by digit (bucketed by their first and last digits), so
  5,000 rows stay fast. Each row is told about at most 25 lookalikes and 25 partial matches (`NEIGHBOURS_KEPT`),
  lookalikes looked for first; within that, no pair that `madeToLookAlike` or `PARTIAL_MIN` would catch is missed.

**CP5. The addresses you have paid before** (optional, `readKnownAddresses`). A second box takes the addresses someone
knows, one a line with its name, up to 200, as on `/check-address`. Each row is compared with them: the same address
says "Paid before as <name>"; one made to look like a known address is a stop, sized as in CP4 to the pairs the
batch and the list make (n times the known addresses); one sharing 4 digits at an end is a look. With this box empty,
the page says the batch was compared only with itself.

**CP6. Amounts** (`readPayoutAmount`, with the bill import's `readAmount` and `decimalMarkOf`).
- When the batch's amounts can be read two ways (`1,000` as one thousand or one), the page asks how they are written,
  as `/check-bills` does.
- Each amount: **fix** when it is not a number, zero or below zero, or has more decimal places than its token has
  (6 for USDC and EURC; 18 for a native coin; not checked for a token the page does not know). Never too large: an
  airdrop of a token with a large supply may send 10^15 of it. **Look** when it is at least 100 times the median of
  the batch's other amounts of the same token (a decimal point moved, or an amount written in base units).
- A batch with no amount column is checked for its addresses alone, and says so.
- Totals: the number of rows and the sum for each token, summed as exact decimals (never floats), each sum labelled with
  the token as the batch names it. Rows with an amount to fix, or a token that cannot be read, are left out of the sum,
  and the page says how many. An NFT row's amount is not read, so it is not totalled either, and the page says so.

**CP7. Tokens** (`tokenOf`). Optional.
- A token contract address (Safe's `token_address`) that is USDC or EURC on a chain Vestiarion knows (`specialAddress`'s
  token labels): labelled, such as "USDC on Base".
- One **made to look like** a known token's contract (`madeToLookAlike` against every known token address): a stop.
  Fake tokens with a real token's ends are sent to people's histories so a copied row pays the wrong contract.
- Any other contract: a look ("A token this page does not know: check its contract before you send it."), shown once
  per contract with the rows that use it.
- A symbol (`USDC`, `EURC`, `ETH`) or Safe's `native` type: labelled, nothing more. Outside Safe's form a token cell is
  read through `evmPart` first, as the address is: a contract after a chain prefix, a payment link's target or 40 hex
  digits without their `0x` is a contract, never a symbol.
- A batch of more than one token says so above the totals.

**CP8. Each row's verdict** (`payoutVerdict`).
- **Fix**: the row cannot be sent as written (address unreadable, hidden or lookalike character, amount to fix).
- **Stop**: do not send until it is checked (OFAC, an invalid checksum, a special address or token contract as the
  receiver, made to look like another row or a known address, a token made to look like a known one).
- **Look**: send only after checking (the same address on two rows, one name with two addresses, 4 shared digits, an
  amount 100 times the median, a token the page does not know, an ENS name or a non-EVM address not checked).
- **Nothing found**: none of these checks found anything. The page never says "safe" or "verified".

**CP9. The results** (`PayoutCheckResults`).
- First the counts: rows read, to fix, to stop, to look at, nothing found; then the totals per token (CP6).
- Then the tokens with a finding, each said once with the rows that pay it.
- Then the rows with a finding, in batch order, each with its line, name, address (checksummed, the shared digits of a
  lookalike pair marked, not by colour alone; a cell read after a chain prefix or in a link shown as written), amount
  and token, and each finding in words. Then the rows with nothing found, folded, and drawn only once opened. Each list
  is drawn 200 rows at a time, and a press for more moves the focus to the first row it drew.
- The tones follow the other tools: refused for fix and stop, attention for look.

**CP10. The batch back, with a verdict column** (`checkedPayoutCsv`, `src/lib/payout-check/csv.ts`).
- Every row as the batch wrote it, its column names first when it has them, then one added column, `Payout check`:
  "Fix: …", "Stop: …", "Look: …" or "Nothing found", a byte-order mark first, and the batch's own delimiter (semicolon
  kept, anything else as commas), built in the browser like `/check-bills`'s `checkedCsv`. Rows past 5,000 say they
  were not checked.
- No "rows to send" export: the page does not pick what to pay.

**CP11. The example** (`samplePayoutBatch`, `src/lib/payout-check/sample.ts`). Made up, in Safe's CSV Airdrop form with
a `name` column added (`token_type,token_address,receiver,amount,id,name`), 14 rows of USDC on Base, showing nine
kinds of finding: a pair made to look alike, the same address twice, a name with two addresses, an OFAC row, an
invalid checksum, the USDC contract as a receiver, an amount with 7 decimals, an amount 1,000 times the rest, a token
contract made to look like USDC's, and two rows with nothing found. Its OFAC row uses an address that is on the
snapshot, as the address checker's tests do. Every other address is made up and owned by no one the page knows.

**CP12. The call to action.** "Vestiarion checks each payee's payout address against OFAC's list and the payee's
past addresses, and holds any payment whose address changed until a person confirms it, before it pays." (Until Nov 5
it began "locks each payee's payout address", which overstated the payee lock, off by default on Arc testnet.) The
shared `ToolCta tool="check-payouts"`, and a secondary link to the guide on payee checks.

**CP13. Nothing leaves the browser.** The batch is read and checked in the page. No request carries any of it, no
cookie or storage keeps it, and the page test holds the checker to making no request and touching no cookie, as
`tests/check-bills-page.test.tsx` does. Analytics may count the page and a click on the start button, by path only
(`FREE_TOOL_COUNT_LINE`).

**CP14. Docs and checks.** README's free tools list, CHANGELOG `[Unreleased]`, ARCHITECTURE's free tools section, the
`/check-address` and `/check-vendor` links, the production check (`scripts/synthetic-check.mjs`: the page and its
sitemap entry) and the tests that list every free tool (`docs-content`, `site-footer`). Not `/api/v1`, so no
`content/docs/changelog.mdx` entry.

## What it does not do

- It does not look up ENS names, balances or an address's history, or exposure through mixers and clusters: direct
  matches against OFAC's list only.
- It does not know who owns an address. Nothing found means none of these checks found anything, not that the row is
  safe to send.
- It checks EVM addresses only, the first 5,000 rows, and converts no amount.

## Out of scope

- Sending anything, or an export of rows to send.
- ENS lookups (they need the server).
- A refresh of the OFAC snapshot (`scripts/ofac-sdn-wallets.mjs` stays the one way).

## As built

- **CP2.** The box for the addresses paid before (CP5) is in the Columns step, not the first: a dropped file moves to
  Columns at once. Its text is kept while another batch is read, in the page's state only.
- **CP3.** The ENS check is `isAddressName` (`src/lib/ens-words.ts`): `.eth` names and Basenames. Any other name, such
  as a DNS name, is "Not checked: only EVM addresses (0x) are checked."
- **CP6.** Two of `readAmount`'s reasons still say "list": "could be read two ways: say how the list writes its
  amounts", seen only if the decimal question is skipped, and "does not fit the list's amounts, written like
  1,234.50". Its bill reason for a negative amount is "is below zero" here. ETH, POL, MATIC, AVAX and BNB written as
  symbols are given 18 decimals. Totals follow the token as the batch names it, so the symbol `USDC` and the USDC on
  Base contract are totalled apart, as are `ETH` and Safe's `native`.
- **CP7.** Safe's own rules, which the spec does not give: a `token_type` other than `erc20`, `native`, `nft`,
  `erc721` or `erc1155` is a fix; an `erc20` or NFT row with a blank `token_address` is a fix; an `erc20` row whose
  `token_address` is not a contract address (a symbol such as `USDC`) is a fix. NFT rows (`nft`, `erc721`,
  `erc1155`) have their amount neither read nor totalled (CP6 says so on the page), and their contract still gets the
  token checks, so an unknown NFT contract is a look. A blank token cell is the chain's own coin only under a column
  named `token_address`, Safe's form (`blankTokenIsNative`); under any other token column it names no token. The
  unknown-contract sentence is said once under **Tokens with a finding**; each row's card points to it, and the CSV
  carries it on every row.
- **CP9.** The headline ("Do not send this batch as it is", "Look at N rows before you send this batch", "Nothing
  found") and the five count tiles sit inside the announced summary.
- **CP10.** Cells come back as the batch wrote them, as `/check-bills`'s do, with no guard against spreadsheet
  formulas: `/check-vendor`'s apostrophe before `=`, `+`, `-` or `@` would change an amount written `-5`.
- **CP12.** The CP12 sentence is followed by "It is an AI agent for bills and payments, and every step is signed into
  a ledger anyone can verify." The first-payment guide links the check beside the address checker.
