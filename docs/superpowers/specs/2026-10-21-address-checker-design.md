# Address lookalike checker

Date: 2026-10-21. Status: accepted.

## Why

Address poisoning is how a payment to a known payee goes to someone else. Wallets and explorers show an address by its
ends, like `0x7a2d…e10d`. An attacker makes an address with the same ends as one the victim pays and sends a transfer of
nothing from it, so it sits in the victim's history. The next payment copied from that history goes to the attacker.
The same goes for an invoice whose payment details were edited, or an email announcing a supplier's new wallet.

Vestiarion's payee lock already holds a changed address and warns about lookalikes inside a workspace (payee lock PL6).
A free public page that does the comparison for anyone, with nothing to sign up for, helps people who do not use
Vestiarion yet, and shows what the product checks. It is a page to share on X.

## What

**AC1. What was pasted** (`checkAddress`, `src/lib/address-check.ts`). Before anything else, it says what keeps the input
from being an address, in this order:
- nothing pasted;
- a character nobody sees, or sees as a space: format characters (zero-width spaces and joiners, direction marks and
  overrides, the byte-order mark, tags), spaces other than the plain one, combining marks and variation selectors, and
  blank fillers such as U+3164. An override can show characters in an order other than the one pasted. The message
  names the code point. The rules write these characters as escapes, and a test keeps any hidden or foreign character
  out of the checker's own source;
- a character that only looks like one an address uses: Cyrillic and Greek letters, full-width digits (anything NFKC
  changes), and `O`, `o`, `l` or `I` for `0` or `1`. The message names it, its place and what it looks like;
- no `0x`, saying so when the 40 digits are there without it, or `0X`, which wallets refuse;
- a character that is not hex, by its place;
- a length other than 40 digits after `0x`.

Spaces around the address are ignored. An input that is not an address is checked no further.

**AC2. The checksum.** EIP-55, through viem's `getAddress`:
- a mixed-case address that matches is `valid`;
- one that does not is `invalid`, typed wrong or changed, and the page says not to pay it;
- an address in one case carries no checksum (`none`), which is not a fault.

**AC3. Made to look like a known address.**
- `sharedEnds` counts the hex digits after `0x` two addresses share from the start and from the end, case ignored.
- Two different addresses are made to look alike (`madeToLookAlike`) when they share at least 3 at each end, or 5 at
  one. Wallets show both ends, some only one.
- By chance, two unrelated addresses share 3 digits at each end about once in 17 million, and 5 at one end or the other
  about once in 524 thousand, so a match is very unlikely to be chance.
- 4 digits shared at one end, short of that, is a partial match: the page says to compare the whole address, without
  stopping. Some people check only the last 4.
- Every pair the payee lock's warning catches (first 6 and last 4) is caught here too. The test holds the two rules to
  each other.
- The very address, every character, is `same`.
- When the address is one in the list and another in the list is made to look like it, the list holds a fake: one of the
  two is not the payee's (`conflict`). This happens when someone pastes their history, poisoned address included.
- Matches come lookalikes first, then the very address, then partial matches, most digits shared first. The page shows
  both addresses with the shared ends marked and each differing digit bold on a tint, and how rare that is ("about once
  in 4.3 billion"), naming which ends match.

**AC4. OFAC's list, and addresses that are not a wallet.**
- An address among the EVM addresses on OFAC's SDN list stops the check, naming the entry. The page carries the dated
  snapshot sanctioned wallets SW3 bundles (`src/lib/data/ofac-sdn-evm-wallets.json`) and says its date. It does not
  read the live list, which would send a request.
- Addresses no payee should give, from the network profiles (`specialAddress`):
  - the zero address and `0x…dEaD`, where anything sent is lost;
  - the USDC and EURC contracts on Arc;
  - USDC on every chain Vestiarion pays to or brings USDC from;
  - Arc's USDC system address.

**AC5. The addresses someone knows** (`readKnownAddresses`).
- Pasted one or more a line, each takes the rest of its line as its name ("Northwind Design, 0x…"), or "Address 2".
- Each address is kept once, case ignored, and at most 200; the page says when more were left out.
- A longer hex string, such as a transaction hash, is not read as an address.
- A line that seems meant to hold an address (`0x`, or 30 hex digits in a row) but holds none that can be read is listed
  with what is wrong with it, as AC1 says it. So an address with a hidden character is never dropped unnoticed, which
  would let its lookalike through.
- The page lists what it read under the field: names and shortened addresses.

The verdict:

| Verdict | When | Says |
|---|---|---|
| `fix` | Not an address yet | What is wrong with it |
| `stop` | On OFAC's list, a special address, an invalid checksum, or made to look like a known address | Do not pay, and why |
| `conflict` | The very address of a known one, and another known one made to look like it | One of the two is not the payee's: confirm it |
| `same` | The very address of a known one, and nothing to stop it | It is the address you know as … |
| `check` | Anything else | Nothing says it is wrong, nor whose it is: confirm it with the payee on a contact you already had |

**AC6. The checker** (`AddressChecker`, `src/components/address-check/AddressChecker.tsx`).
- Two fields, "Address you are about to pay" and "Addresses you know", checked as someone types.
- The second field says to copy addresses from one's own records or past invoices, not from a wallet's recent activity,
  where a poisoned address hides.
- There is no form, so nothing typed can be submitted to a server or land in the address bar, before or after the
  script runs. No field value is put in a URL, analytics or storage.
- **Try an example** fills a made-up pair: an address sharing Northwind Design's first 4 and last 4 digits.
- Only the headline is announced to screen readers as it changes, not every line under it, and not what is wrong with
  an input that is not an address yet, which changes at each keystroke.
- The fields are 16 px on a phone, so the browser does not zoom into them.

**AC7. The page** (`/check-address`).
- Public and static; the snapshot is read at build time. It is not under `/tools`, whose files are served as downloads.
- Below the checker:
  - what address poisoning is;
  - what Vestiarion does inside a workspace: a changed address held until a person confirms it; with the payee lock
    on, another person, a contact from before the change for a call or message, and a wait of up to 72 hours; its
    lookalike warning (first 6 and last 4 characters); OFAC's list.
  - **Try it on your bills** (`data-cta="check-address-start"`) and a link to the payee lock guide.
- It is in the sitemap and the footer's Resources. The payee lock guide links to it. (Since 2026-10-28 the footer
  lists it under Free tools, and its button credits a workspace to it:
  `2026-10-28-free-tool-attribution-design.md`.)

## Not in this change

- The live OFAC list on the page: the snapshot is dated, and the page says so.
- Using this broader lookalike rule in the product's own warning (PL6 stays first 6 and last 4).
- Names: ENS and Basenames are a later item.

## Tests

`tests/address-check.test.ts`:
- each format problem, `0X`, invisible characters of each kind and lookalike characters with the code point named;
- no hidden or foreign character in the checker's source;
- the checksum both ways;
- shared ends in words, the lookalike thresholds both sides, partial matches, order, a list holding a fake, and every
  PL6 pair caught at any length of shared ends;
- the chance in words, the example;
- OFAC's list and every kind of special address;
- reading known addresses, the 200 limit, lines that could not be read and why, a transaction hash left out.

`tests/check-address-page.test.tsx`, in a DOM:
- no form;
- the example's headline, comparison, checks and what was read, with only the headline live and differing digits
  marked by more than colour;
- an input that is not an address yet, unannounced; a known address; a list holding a fake; a line not read; a partial
  match; nothing found; OFAC; a token contract; 16 px fields;
- the page's metadata, CTA, guide link and that it is public;
- no request, storage, cookie, address-bar or history write, analytics call, form or named field in the checker's code.

`tests/site-footer.test.tsx` and `tests/docs-content.test.ts` cover the footer and the sitemap.
