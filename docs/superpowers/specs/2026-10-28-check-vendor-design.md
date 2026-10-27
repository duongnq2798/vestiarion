# Free OFAC check for vendors

Date: 2026-10-28. Status: accepted.

## Why

"ofac check" and the long tail around it ("ofac check vendor list", "bulk ofac screening", "ofac wallet check") are
searched by people who pay vendors. Treasury's own search (https://sanctionssearch.ofac.treas.gov/) is free and fuzzy,
but takes one name at a time and knows nothing of wallets. A business with a vendor list wants the whole list checked at
once, names and pay-to wallets together, with a file back.

Vestiarion already screens every counterparty and checks every payout address against OFAC's SDN list before it pays
(screening providers SP1-SP3, sanctioned wallets SW1-SW4). A free page that does a first version of that for anyone,
with nothing to sign up for and nothing sent anywhere, helps people who do not use Vestiarion yet and shows what the
product checks. It sits beside the address lookalike checker (`2026-10-21-address-checker-design.md`).

## What

**CV1. The name snapshot** (`parseSdnNames`, `src/lib/sanctioned-wallets.ts`).
- Read from four of OFAC's SDN files, downloaded from the Treasury's Sanctions List Service:
  - `SDN.CSV`: each entry's number, name, type and programs, and its remarks;
  - `SDN_COMMENTS.CSV`: remarks that overflow `SDN.CSV`, joined to them as `parseSdnWallets` joins them;
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
  `QA'IDA` is `qaida`); any other punctuation separates words.
- Legal forms are dropped wherever they stand: LLC, Ltd, Limited, Inc, Corp, Co, Company, PLC, GmbH, AG, SA, SARL, SRL,
  SpA, BV, NV, AB, Oy, KG, LLP, LP, Pte, Pty, JSC, PJSC, OJSC, CJSC, OOO, OAO, ZAO, PAO, FZE, FZCO, DMCC, Sdn Bhd,
  Ltda and the like, and the long forms "limited liability company", "(public, open or closed) joint stock company" and
  their Russian transliterations.
- A name made only of such words keeps them.

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
- Each word weighs by how rare it is among the list's names: `ln(1 + names / names with the word)`. A typed word that is
  in no name on the list weighs as the rarest. So "trading", "group" or "al" count for little and "melli" for much.
- Score: the sum, over the pairs, of their closeness times both words' weight, over the weight of every word on both
  sides. A word on either side with no pair lowers it.
- The same letters spaced another way ("Alqaida" and "AL QA'IDA") score at least 0.95.
- Bands:
  - **strong**: 0.85 or more, `STRONG_SANCTIONS_MATCH_THRESHOLD`, the score from which the product's screening calls a
    sanctions match high risk, and never pays the counterparty;
  - **possible**: from 0.70, yente's default cut-off, to 0.85;
  - below 0.70 is not shown.
- At most 3 entries are shown, the highest first. On a tie, an entry whose country agrees comes first, then one
  matched on its own name, then the lower number. Within an entry, a tie goes to its own name, then to a name with the
  words in the order typed.
- Only a name form that could reach 0.70 is scored: with every pair the same word, its score is at most
  `2h / (h + its weight + the weight of typed words close to nothing)`, `h` the weight of its words close to a typed
  one. So 5,000 rows take about a second.
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
  - one that starts with `0x`, or is 40 hex digits, gets the address checker's rules (AC1-AC4, `checkAddress`): its
    characters, its checksum, the EVM addresses in the name snapshot, addresses that are not a wallet, and the other
    rows' addresses that share its first 3 and last 3, first 5 or last 5 hex digits, so one made to look like another
    row's (AC3) stops, naming that row, on both rows;
  - the very same address under another row is a note to look at: "The same address as Northwind Design's. Check one
    wallet is meant for both.";
  - any other is compared, as written (case ignored for hex and single-case forms such as bech32), with every
    digital-currency address the snapshot lists, of any currency;
  - a row without a name is called by its row number.
- Counts (`vendorSummary`): rows checked, rows with a name and of those strong matches, possible matches and no match,
  wallets checked, and of those the ones that say do not pay and the ones to look at.
- A CSV of the results (`vendorResultsCsv`): the list as read, with four columns added, "OFAC SDN result" (No match,
  Possible match or Strong match), "Possible matches" (each entry's name, number, score and programs), "Wallet result"
  and "SDN list as of". Built in the browser and saved from it (a `Blob`); a cell a spreadsheet would run as a formula
  starts with an apostrophe.

**CV7. The checker** (`VendorChecker`, `src/components/vendor-check/VendorChecker.tsx`).
- One name, with an optional country, checked on **Check this name** or Enter.
- A list: a file chosen or dropped, or rows pasted and read with **Read the list**; then the columns, and **Check the
  list**. A long list shows how far it has got.
- **Try an example** fills a short made-up list with one name on OFAC's list and a wallet made to look like another
  row's.
- The snapshot loads only when a check runs, as a separate file the page's own code imports. What was typed or pasted
  is never in a request, a URL, the browser's storage, a cookie or analytics, and there is no form to submit.
- Each name gets either "No match in OFAC's SDN list as of <date>." or up to 3 matches. Each match shows its band and
  score, the entry's name, its type and programs, why it matched, its other names (the first 6, then how many more),
  its countries, its digital-currency addresses, and **Check it on Treasury's search**, a link to the entry's page on
  `sanctionssearch.ofac.treas.gov`, in a new tab, with no referrer.
- A list's results start with the counts, then the rows with a match or a wallet to look at, in list order, then the
  rows with nothing found, folded. **Download the results (CSV)** saves the CSV.
- The headline of a result (one name's, or a list's counts) is announced politely as it changes, not each line.
- No result is ever called safe, cleared, verified or compliant.
- Fields are 16 px on a phone, so the browser does not zoom into them.

**CV8. The page** (`/check-vendor`, `src/app/check-vendor/page.tsx`).
- Public and static, outside `/tools`, which serves downloads. `requiresSession` does not cover it, and the enforced
  Content Security Policy needs nothing new: the snapshot is a script file from the same site.
- Title "OFAC check for vendors: one name or a whole list, free", a description, a canonical address, and the social
  cards.
- Heading "Check your vendors against OFAC's sanctions list", what it checks, and "The check runs in this page. Nothing
  you type or paste is sent anywhere or kept."
- Below the checker, "What this check covers, and what it does not":
  - it covers OFAC's SDN list only: not OFAC's other (non-SDN) lists, gathered in its Consolidated Sanctions List, nor
    the EU's, the UN's or the UK's;
  - names and listed addresses only: not who owns a company (OFAC's 50 percent rule), nor a wallet's history;
  - a match is a reason to look closer on Treasury's search, and no match does not prove a vendor is not on the list;
  - a first look, not a compliance decision;
  - the list's date, and how it is refreshed, linking the script.
- "How names are compared": CV2-CV4 in a paragraph, with both thresholds.
- "What Vestiarion does before it pays": the call to action (CV9) and **How screening works**, to the first payment
  guide's counterparty step.
- The sitemap, the footer's Resources ("OFAC vendor check"), and a link from the first payment guide's screening
  section.

**CV9. The call to action** (`VendorCheckCta`, `src/components/vendor-check/VendorCheckCta.tsx`): one small file, so a
shared tool call to action can replace it in one line.
- "Vestiarion screens every vendor and checks every pay-to wallet against OFAC's list before it pays, and never pays a
  vendor with a strong match."
- **Try it on your bills**, to the landing's `TRY_HREF`, with `data-cta="check-vendor-start"`.
- "In shadow mode it decides on your real bills while you keep paying them as you do now."

## Not in this change

- A server route that reads OFAC's files every 12 hours for this page; the dated snapshot answers, refreshed by the
  script.
- OFAC's non-SDN lists, and the EU, UN and UK lists.
- Weak a.k.a.s, dates of birth and identifiers as match signals.
- Attribution of a workspace to this page: a separate change adds a shared tool call to action.

## Tests

- `tests/sanctioned-names.test.ts`: `parseSdnNames` on small files (types, programs, other names, countries from
  addresses and remarks, a vessel's flag left out, overflowing remarks, addresses of any currency, the files'
  end-of-file character); the snapshot's shape, order, date and size, and real entries in it.
- `tests/vendor-check-match.test.ts`: `nameWords` and legal forms, `jaroWinkler` on known pairs, `soundKey`,
  `wordCloseness`; real SDN entries from the snapshot found by their name, another name, word order, accents and legal
  forms, other spellings and spacing; the bands against `STRONG_SANCTIONS_MATCH_THRESHOLD`; at most 3 matches and
  their order; ordinary business names that find no strong match; the country's agreement.
- `tests/vendor-check-list.test.ts`: reading a list with and without column names, the columns found, the row limit,
  wallets (OFAC's EVM and other addresses, a lookalike of another row's, the same address under two names, a wrong
  checksum, not an address), the counts and the CSV.
- `tests/check-vendor-page.test.tsx`, in a DOM: one name, the example list and its download, the live headline, 16 px
  fields; the page's metadata, headings, coverage notice, call to action and that it is public; and no request,
  storage, cookie, address-bar or history write, analytics call, form or named field in the checker's code.
- `tests/site-footer.test.tsx` and `tests/docs-content.test.ts` cover the footer, the sitemap and the guide's link.
