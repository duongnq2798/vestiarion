# Free OFAC check for vendors

Date: 2026-10-28. Status: accepted.

## Why

"ofac check" and the long tail around it ("ofac check vendor list", "bulk ofac screening", "ofac wallet check") are
searched by people who pay vendors. Treasury's own search (https://sanctionssearch.ofac.treas.gov/) is free and fuzzy,
but takes one name at a time and knows nothing of wallets. A business with a vendor list wants the whole list checked at
once, names and pay-to wallets together, with a file back.

Vestiarion already screens every counterparty, and checks every payout address against OFAC's SDN list before it pays
(screening providers SP1-SP3, sanctioned wallets SW1-SW4). A free page that does a first version of that for anyone,
with nothing to sign up for and nothing sent anywhere, helps people who do not use Vestiarion yet and shows what the
product checks. It sits beside the address lookalike checker (`2026-10-21-address-checker-design.md`).

## What

**CV1. The name snapshot** (`parseSdnNames`, `src/lib/sanctioned-wallets.ts`).
- Read from four of OFAC's SDN files, downloaded from the Treasury's Sanctions List Service:
  - `SDN.CSV`: each entry's number, name, type and programs, and its remarks;
  - `SDN_COMMENTS.CSV`: remarks that overflow `SDN.CSV`, joined to them as `parseSdnWallets` joins them, untrimmed:
    OFAC cuts the remarks at a fixed length, and a cut right after a space ("Digital Currency Address - XBT ") keeps
    it, so the address after it is read;
  - `ALT.CSV`: the entry's other names (a.k.a., f.k.a. and n.k.a.);
  - `ADD.CSV`: its addresses, of which only the country is kept.
- Each entry, in number order:
  - its number, which Treasury's search opens at `Details.aspx?id=<number>`;
  - its name;
  - its type: `entity` (the file's `-0-`), `individual`, `vessel` or `aircraft`;
  - its programs, such as `IRAN`, `SDGT` or `RUSSIA-EO14024`, split from the file's `IRAN] [SDGT`;
  - its other names, in the file's order, each once, without the name itself;
  - its countries, sorted: each address's country, without a `Region: ` prefix, and each nationality and citizenship
    the remarks give ("Nationality of Registration", a vessel's flag, is not one);
  - its digital-currency addresses, as `<currency> <address>` written as the list writes them, such as
    `ETH 0x098B…2f96` or `XBT 1Boat…`.
- The weak a.k.a.s that OFAC writes only inside an entry's remarks are not read: OFAC keeps them out of `ALT.CSV`
  because they are broad enough to match many people.
- The snapshot is `src/lib/data/ofac-sdn-names.json`: `source`, `readAt` (the day the files were read) and one entry a
  line, so a refresh shows in review as the entries that changed. 19,471 entries and 20,188 other names on 2026-10-28:
  about 2.3 MB, about 0.55 MB compressed.
- `scripts/ofac-sdn-wallets.mjs` writes it and the EVM wallet snapshot (SW3) from the same download, so both carry one
  date. It now runs the parsers in `src/lib/sanctioned-wallets.ts` themselves, through `tsx`, rather than a copy of
  them: `npx tsx scripts/ofac-sdn-wallets.mjs <SDN.CSV> <SDN_COMMENTS.CSV> <ALT.CSV> <ADD.CSV> [YYYY-MM-DD]`.
- How it stays fresh: the snapshot is refreshed by running that script and committing the result. There is no server
  route that reads OFAC's files for this page in this change; the page says the list's date wherever it gives a
  result.

**CV2. A name as compared** (`nameWords`, `src/lib/vendor-check/match.ts`).
- Accents are dropped and case ignored; `&` reads as "and"; dots and apostrophes are dropped (`S.A.` is `sa`,
  `QA'IDA` is `qaida`); any other punctuation separates words. An apostrophe is `'`, its curly form, the backtick, or
  one of the modifier letters some Latin spellings write it as (U+02B9 to U+02BF and U+02C8): the Hawaiian okina, the
  modifier apostrophe of "Hizb'allah" written so, the half rings of Arabic transliterations. They are letters of no
  script, so kept, they would make a Latin word read as one in another script.
- Legal forms are dropped wherever they stand: LLC, Ltd, Limited, Inc, Corp, Co, Company, PLC, GmbH, AG, SA, SARL, SRL,
  SpA, BV, NV, AB, Oy, KG, LLP, LP, Pte, Pty, JSC, PJSC, OJSC, CJSC, OOO, OAO, ZAO, PAO, FZE, FZCO, DMCC, Sdn Bhd,
  Ltda and the like, and the long forms "limited liability company", "(public, open or closed) joint stock company" and
  their Russian transliterations.
- A name made only of such words keeps them.
- A word with a letter outside the Latin script (`nonLatinWords`), such as one in Cyrillic or Chinese letters or a
  Latin-looking one with a Cyrillic letter in it, is left out: every name on OFAC's list is written in Latin letters, so
  it could never pair. A name with no other word is not compared at all, and says so (CV6, CV7), rather than "No match".
- Nor is a name with such words whose words in Latin letters are only legal forms and numbers (`nameCompared`): a
  Russian bank's name in Cyrillic followed by PJSC, or a Chinese company's in Chinese followed by "Co., Ltd.", would
  otherwise be compared on PJSC, or on Co and Ltd, which say nothing of who the vendor is and pair with nothing on the
  list (its names' legal forms are dropped too). `matchName` finds nothing for a name not compared.

**CV3. Two words as compared** (`wordCloseness`).
- The same word: 1.
- The same word spelled another way: the same letters once vowels (with `y`) and doubled letters are run together
  (`soundKey`: "hezbollah" and "hizballah", "osama" and "usama", "mohamed" and "mohammed"), and a Jaro-Winkler of at
  least 0.80: 0.9.
- A close spelling: a Jaro-Winkler (`jaroWinkler`) of at least 0.88: from 0.5 at 0.88 up to 0.9.
- Anything else: 0. Words of 3 letters or fewer only count when they are the same.
- A typed word is compared with the list's words that start with a letter of its group (vowels and `y`; `c`, `k`, `q`
  and `g`; any other letter alone) and differ in length by at most a third of its own, or 2 letters, and with the
  words of its sound key: so "Kadhafi" finds "QADHAFI", and a long list stays fast.

**CV4. A name's score** (`matchName`).
- A name is scored against every entry's name and each of its other names, and an entry takes its best.
- Words are paired one to one, the closest pairs first.
- Each word weighs by how rare it is among the list's names: `ln(1 + names / names with the word)`. So "trading",
  "group" or "al" count for little and "melli" for much.
- Score, with `w` a word's weight (a typed word in no name on the list weighs as the rarest) and `c` a pair's closeness
  (CV3):

  `score = Σ pairs c × 2w(listed) / (Σ pairs 2w(listed) + Σ typed words with no pair w + Σ listed words with no pair w)`

  So each pair adds its full `2w` below the line whatever its closeness, and its closeness of it above: a one-word name
  whose only pair is close at 0.5 scores 0.5. A word on either side with no pair adds only below the line, and lowers
  the score.
- The same letters spaced another way ("Alqaida" and "AL QA'IDA") score at least 0.95.
- A name made only of rare words, each longer than 3 letters and in at most 10 of the list's names (`RARE_IN_NAMES`),
  scores at least 0.70 against a name that holds them all, however many more words that name has: "Suex" is a possible
  match to SUEX OTC, S.R.O., and "Kadyrov" to KADYROV, Ramzan Akhmatovich. The rule never makes a match strong, and the
  match says it applied.
- Bands:
  - **strong**: 0.85 or more, the same cut-off as `STRONG_SANCTIONS_MATCH_THRESHOLD`, which the product's screening
    applies to its provider's score to call a sanctions match high risk. The two scores are not the same: this one is
    this matcher's, against the SDN snapshot, so a strong match here does not mean screening would call the vendor
    high risk;
  - **possible**: from 0.70, yente's default cut-off, to 0.85;
  - below 0.70 is not shown.
- At most 3 entries are shown, the highest first. On a tie, an entry whose country agrees comes first, then one
  matched on its own name, then the lower number. Within an entry, a tie goes to its own name, then to a name with the
  words in the order typed.
- Only a name form that could reach 0.70 is scored: with every pair the same word, its score is at most
  `2h / (h + its weight + the weight of typed words close to nothing)`, `h` the weight of its words close to a typed
  one. A name made only of rare words also scores every name form holding them all.
- How long it takes, measured on a laptop: a typed word is compared with the listed words of its group the first time
  the page meets it, about 1 to 4 ms, and remembered after, so a list's time grows with its distinct words more than its
  rows. 5,000 rows with about 1,000 distinct words took about 2 seconds; a list with more distinct words takes longer.
  The list is checked 250 rows at a time, the page showing how far it has got.
- Each match says which name matched (the entry's, or one of its other names), the word pairs and how each paired
  (same, spelled another way, close), the typed words with no pair and the entry's words with no pair, and whether the
  country agrees.

**CV5. The country** (`countryAgreement`). Optional. Compared with the entry's countries, accents and case ignored:
- OFAC's inverted names read the usual way ("Korea, North" is "North Korea");
- a two-letter code reads as its country, through the browser's `Intl.DisplayNames`;
- a few other names are known: USA, US, UK, Great Britain, UAE, DPRK, Burma and Myanmar, Russian Federation, Türkiye,
  Czechia and the like.
- The result: it agrees, it differs (naming the entry's countries), the entry names no country, or none was given. The
  country never changes the score or the band: it is shown, and it orders equal scores, agreeing first.

**CV6. A vendor list** (`src/lib/vendor-check/list.ts`).
- Read as the bill import reads a list (`readTable`, `decodeList`, import design B2): a CSV file, a semicolon CSV, or
  rows pasted from Excel or Google Sheets. A file of at most 2 MB.
- Title lines (`readVendorList`). A report exported from an accounting tool can start with its title and dates, one
  cell a line, above its column names ("Vendor Contact List", "All Dates", then "Vendor,Phone,Email,Wallet"). When a
  row of more than one cell within the first 6 names the columns (`looksLikeVendorHeader`) and each line above it is
  one cell, those lines are left out, and the page names them: "Above its column names, not checked: …". The rows keep
  their line numbers.
- Names written "Last, First" (`readVendorList`, `vendorTable`). A spreadsheet copies one column without quoting a
  cell that holds a comma, and the bill import cuts a comma list at every comma. So:
  - a comma list is one column, the cells a comma cut each line into joined back with ", ", when no row has more than
    two cells, no row of two cells names the columns, and either its first row (past any title lines) is one cell, or
    every comma in it is followed by a space, as in "Kadyrov, Ramzan" and never between a CSV's columns. So a pasted
    column of "Last, First" names stays whole, with or without a first row naming it;
  - a row of more than two cells keeps its columns: joined, a phone number, an email or a wallet would become words of
    its name, and a listed name with such words added can score below a possible match;
  - in a comma list whose last named column holds the names, a row with more cells than there are column names has
    them joined back into its name (`vendorTable`). The page counts the columns, shows what each reads, checks the rows
    and writes the CSV from that joined table, so what it shows is what it checks.
  - Two cases are still read as one column of names, and the page shows "1 column" and what it reads: a list without
    column names of two columns, every comma followed by a space ("Northwind Design, US"); and a list of at most two
    columns under a title line whose column names the check does not know.
- The first row holds column names when one of its cells names a column the check knows (`looksLikeVendorHeader`);
  the person can say otherwise.
- Three columns, found by their names (`detectVendorColumns`) and changeable as in the bill import (B3):
  - **Vendor name**: vendor, supplier, payee, name, company, counterparty, beneficiary and the like; without column
    names, the first column;
  - **Country**: country, nationality, jurisdiction, country code and the like;
  - **Wallet address**: wallet, wallet address, payout address, pay-to address, crypto address, USDC address and the
    like. A bare "Address" is not taken: in a vendor list it is most often where the vendor is.
- Up to 5,000 rows (`VENDOR_ROWS_MAX`); the page says when more were left out. A row with neither a name nor a wallet is
  skipped. A row with a wallet and no name is checked for its wallet alone.
- A wallet (`vendorRowChecker`, worded by `walletWords`):
  - the part the address checker reads (`evmPart`): the cell, when it starts with `0x` or is 40 hex digits; the
    address after a chain prefix, `eth:0x…` or `base:0x…` (EIP-3770); a payment link's own address, `ethereum:0x…@1`
    (EIP-681); or the cell from a `0x` that starts a word, so a cut or mistyped address gets the checker's reason
    rather than a clean answer. A `0x` inside a word is part of another currency's address: a bech32 one can hold it;
  - a payment link that calls a contract function, `ethereum:<token>@1/transfer?address=<payee>&uint256=…`, pays
    `address=`, and its own address is the token's contract: so its `address=` is read and nothing else, a name such
    as `vendor.eth` getting the checker's "Not an address" reason, and a link without one is "Not an address to pay:
    this payment link calls a contract and gives no pay-to address (address=)." Its token contract is never checked
    as the payee;
  - that part gets the address checker's rules (AC1-AC4, `checkAddress`): its characters, its checksum, the EVM
    addresses in the name snapshot, addresses that are not a wallet, and the other rows' addresses that share its
    first 3 and last 3, first 5 or last 5 hex digits, so one made to look like another row's (AC3) stops, naming that
    row, on both rows. When it is only part of the cell, the result starts "Read as <address>.";
  - the very same address under another row is a note to look at: "The same address as Northwind Design's. Check one
    wallet is meant for both.";
  - any other is compared with every digital-currency address the snapshot lists, of any currency, case ignored for
    hex and single-case forms such as bech32: the cell as written, then each of its words, split at spaces, commas,
    colons, parentheses, `?`, `&`, `=` and the like. So an address written with its currency, as OFAC writes them
    (`XBT <address>`, `TRX <address>`, `USDT (TRC20): <address>`, `<address> (BTC)`), or inside a payment link such as
    `bitcoin:<address>?amount=0.1` (BIP 21), stops when it is listed;
  - a row without a name is called by its row number.
- A name with no word in Latin letters, or none but legal forms and numbers beside words in another script (CV2,
  `nameCompared`), is not compared: "Not compared: OFAC's SDN list writes every name in Latin letters." A name with
  others is compared on those, and names the words left out. Either way the row is one to look at.
- Counts (`vendorSummary`): rows checked, rows with a name and of those strong matches, possible matches, no match and
  not compared, wallets checked, and of those the ones that say do not pay and the ones to look at.
- A CSV of the results (`vendorResultsCsv`): the list as read, with four columns added, "OFAC SDN result" (No match,
  Possible match, Strong match, or "Not compared: not in Latin letters", with any words left out named), "Possible
  matches" (each entry's name, number, score and programs), "Wallet result" and "SDN list as of". Built in the browser
  and saved from it (a `Blob`); a cell a spreadsheet would run as a formula starts with an apostrophe.

**CV7. The checker** (`VendorChecker`, `src/components/vendor-check/VendorChecker.tsx`).
- One name, with an optional country, checked on **Check this name** or Enter.
- A list: a file chosen or dropped, or rows pasted and read with **Read the list**; then the columns, and **Check the
  list**. A long list shows how far it has got.
- **Try an example** fills a short made-up list with one name on OFAC's list and a wallet made to look like another
  row's.
- The snapshot loads only when a check runs, as a separate file the page's own code imports. What was typed or pasted
  is never in a request, a URL, the browser's storage, a cookie or analytics, and there is no form to submit.
- The index is built once, in steps (`buildNameIndexInSteps`): 1,000 entries, then 5,000 listed words, at a time, the
  page given back between them, so it keeps drawing and taking input. Built at once it takes about 0.7 seconds on a
  laptop; in steps, none took more than about 60 ms.
- Each name gets either "No match in OFAC's SDN list as of <date>.", up to 3 matches, or, when it is not compared
  (CV2), "Not compared: OFAC's SDN list writes every name in Latin letters." Words left out of a name for not being
  in Latin letters are named under its result. Each match shows its band and score, the entry's name, its type and
  programs, why it matched (and when the rare-word rule of CV4 applied), its other names (the first 6, then how many
  more), its countries, its digital-currency addresses, and **Check it on Treasury's search** "by its name, <entry's
  name>.": a link to Treasury's search page, `https://sanctionssearch.ofac.treas.gov/`, in a new tab, with no
  referrer.
- The link is to the search page itself, not to the entry's own page there (`Details.aspx?id=<number>`), and no link
  the checker draws carries anything of what was typed or what it matched. The site's Google Analytics code sends
  page views and `cta_click` events; GA4's enhanced measurement, on by default and a setting of the Analytics property
  rather than of this code, also sends the address of a link clicked to another site, and an entry's number in it
  would say which entry a name typed here resembles. `tests/check-vendor-page.test.tsx` holds every link the checker
  draws to having no digit in its address.
- A list's results start with the counts, then the rows with a match, words left out, or a wallet to look at, in list
  order, then the rows with nothing found, folded. The counts take the refused tone for a strong match or a wallet
  not to pay, else the held tone when any row is one to look at, a name not compared among them, else the neutral one.
  A folded row's text wraps, so a long address stays inside the page on a phone. **Download the results (CSV)** saves
  the CSV.
- The headline of a result (one name's, or a list's counts) is announced politely as it changes, not each line.
- No result is ever called safe, cleared, verified or compliant.
- Fields are 16 px on a phone, so the browser does not zoom into them.

**CV8. The page** (`/check-vendor`, `src/app/check-vendor/page.tsx`).
- Public and static, outside `/tools`, which serves downloads. `requiresSession` does not cover it, and the enforced
  Content Security Policy needs nothing new: the snapshot is a script file from the same site.
- Title "OFAC check for vendors: one name or a whole list, free", a description, a canonical address, and the social
  cards.
- Heading "Check your vendors against OFAC's sanctions list", what it checks, and "The check runs in this page, and
  nothing you type or paste is kept.", then `FREE_TOOL_COUNT_LINE` (free tool attribution TA6) and the list's date.
- Below the checker, "What this check covers, and what it does not":
  - it covers OFAC's SDN list only: not OFAC's other (non-SDN) lists, gathered in its Consolidated Sanctions List, nor
    the EU's, the UN's or the UK's;
  - names and listed addresses only: not who owns a company (OFAC's 50 percent rule), nor a wallet's history;
  - a match is a reason to look closer on Treasury's search, and no match does not prove a vendor is not on the list;
  - a first look, not a compliance decision;
  - the list's date, and how it is refreshed, linking the script.
- Each link that opens a new tab says so to a screen reader, as the result cards' links do.
- The list's date is read from the wallet snapshot, which the script writes from the same download on the same day, so
  the server page does not carry the name snapshot for one date.
- "How names are compared": CV2-CV4 in a paragraph: another spelling counts for nine tenths of the same word, a close
  one for between half and nine tenths, the rare-word rule, words not in Latin letters, and both thresholds.
- "What Vestiarion does before it pays": the call to action (CV9) and **How screening works**, to the first payment
  guide's counterparty step.
- An entry in `FREE_TOOLS` (`check-vendor`, titled "OFAC vendor check"), from which the sitemap and the footer's Free
  tools group list it, the full footer as `<SiteFooter tool="check-vendor" />`, and a link from the first payment
  guide's screening section.

**CV9. The call to action** (`VendorCheckCta`, `src/components/vendor-check/VendorCheckCta.tsx`). Its button is the free
tools' shared `ToolCta` for `check-vendor` (`docs/superpowers/specs/2026-10-28-free-tool-attribution-design.md` TA3).
- "Vestiarion screens every vendor and checks every pay-to wallet against OFAC's list. The agent pays no vendor until
  screening gives a verdict, and no one can pay a vendor screened high risk." Each claim is what the product's code
  does (the guardrails' `counterparty.unscreened` and `counterparty.high_risk`, the approval's `high_risk` refusal);
  this page's own score plays no part in it.
- **Try it on your bills**, to the landing's `TRY_HREF`, with `data-cta="check-vendor-start"`: `ToolCta`, which credits
  a workspace opened after it to this tool.
- "In shadow mode it decides on your real bills while you keep paying them as you do now."

## Not in this change

- A server route that reads OFAC's files every 12 hours for this page; the dated snapshot answers, refreshed by the
  script.
- OFAC's non-SDN lists, and the EU, UN and UK lists.
- Weak a.k.a.s, dates of birth and identifiers as match signals.

## Tests

- `tests/sanctioned-names.test.ts`: `parseSdnNames` on small files (types, programs, other names, countries from
  addresses and remarks, a vessel's flag left out, overflowing remarks, remarks cut right after a space, addresses of
  any currency, the files' end-of-file character); the snapshot's shape, order, date and size, and real entries in it,
  the two addresses whose remarks were cut after a space among them.
- `tests/vendor-check-match.test.ts`: `nameWords` and legal forms, words not in Latin letters, modifier-letter
  apostrophes, `nameCompared` for a name in another script with a legal form or a number, `jaroWinkler` on known
  pairs, `soundKey`, `wordCloseness`; real SDN entries from the snapshot found by their name, another name, word order,
  accents and legal forms, other spellings and spacing, and their rare words alone; the bands against
  `STRONG_SANCTIONS_MATCH_THRESHOLD`; at most 3 matches and their order; ordinary business names that find no strong
  match; the country's agreement; the index built in steps.
- `tests/vendor-check-list.test.ts`: reading a list with and without column names, past title lines (a listed name
  and wallet below them still found), one column read whole with or without a first row naming it, a row of more than
  two cells kept in its columns, a name in the last column joined back for the page's columns as for the check, the
  columns found, the row limit, wallets (OFAC's EVM and other addresses, chain prefixes and payment links, a transfer
  link read by its `address=` alone, a listed address written with its currency, a lookalike of another row's, the
  same address under two names, a wrong checksum, not an address), names not compared (a legal form or a number
  beside another script among them), the counts and the CSV.
- `tests/check-vendor-page.test.tsx`, in a DOM: one name, a name of rare words, a name not in Latin letters (with a
  legal form too), the example list and its download, one pasted column, a title line, a name joined back in the
  columns and the CSV, the counts' tone for names not compared, a folded row that wraps, the live headline, 16 px
  fields, a link to Treasury's search with no digit in its address; the page's metadata, headings, coverage notice,
  new-tab links, how names are compared, the counting line, call to action (`ToolCta`) and footer start, and that it
  is public; and no request, storage, cookie, address-bar or history write, analytics call, form or named field in the
  checker's code.
- `tests/free-tool-attribution.test.tsx`, `tests/site-footer.test.tsx` and `tests/docs-content.test.ts` cover the
  entry in `FREE_TOOLS`, the footer, the sitemap and the guide's link.
