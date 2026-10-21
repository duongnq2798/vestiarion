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
- a character nobody sees: zero-width spaces and joiners, direction marks and overrides, the byte-order mark. An
  override can show characters in an order other than the one pasted. The message names the code point;
- a character that only looks like one an address uses: Cyrillic and Greek letters, full-width digits (anything NFKC
  changes), and `O`, `o`, `l` or `I` for `0` or `1`. The message names it, its place and what it looks like;
- no `0x`, saying so when the 40 digits are there without it;
- a character that is not hex, by its place;
- a length other than 40 digits after `0x`.

Spaces around the address are ignored, and `0X` is taken as `0x`. An input that is not an address is checked no further.

**AC2. The checksum.** EIP-55, through viem's `getAddress`:
- a mixed-case address that matches is `valid`;
- one that does not is `invalid`, typed wrong or changed, and the page says not to pay it;
- an address in one case carries no checksum (`none`), which is not a fault.

**AC3. Made to look like a known address.**
- `sharedEnds` counts the hex digits after `0x` two addresses share from the start and from the end, case ignored.
- Two different addresses are made to look alike (`madeToLookAlike`) when they share at least 3 at each end, or 5 at
  one. Wallets show both ends, some only one.
- Two unrelated addresses share 6 such digits by chance about once in 17 million, and 5 at one end once in a million,
  so a match is no accident.
- Every pair the payee lock's warning catches (first 6 and last 4) is caught here too. The test holds the two rules to
  each other.
- The very address, every character, is `same`.
- Matches come lookalikes first, most digits shared first. The page shows both addresses with the shared ends marked
  and each differing digit in between, and how rare that is ("about 1 in 4.3 billion").

**AC4. OFAC's list, and addresses that are not a wallet.**
- An address among the EVM addresses on OFAC's SDN list stops the check, naming the entry. The page carries the dated
  snapshot sanctioned wallets SW3 bundles (`src/lib/data/ofac-sdn-evm-wallets.json`) and says its date. It does not
  read the live list, which would send a request.
- Addresses no payee should give, from the network profiles (`specialAddress`):
  - the zero address and `0x…dEaD`, where anything sent is lost;
  - the USDC and EURC contracts on Arc;
  - USDC on every chain Vestiarion pays to or brings USDC from;
  - Arc's USDC system address.

**AC5. The addresses someone knows** (`knownAddresses`).
- Pasted one or more a line, each takes the rest of its line as its name ("Northwind Design, 0x…"), or "Address 2".
- Each address is kept once, case ignored, and at most 200.
- A longer hex string, such as a transaction hash, is not read as an address.

The verdict:

| Verdict | When | Says |
|---|---|---|
| `fix` | Not an address yet | What is wrong with it |
| `stop` | On OFAC's list, made to look like a known address, a special address, or an invalid checksum | Do not pay, and why |
| `same` | The very address of a known one, and nothing to stop it | It is the address you know as … |
| `check` | Anything else | Nothing says it is wrong, nor whose it is: confirm it with the payee on a contact you already had |

**AC6. The checker** (`AddressChecker`, `src/components/address-check/AddressChecker.tsx`).
- Two fields, "Address you are about to pay" and "Addresses you know", checked as someone types.
- The second field says to copy addresses from one's own records or past invoices, not from a wallet's recent activity,
  where a poisoned address hides.
- There is no form, so nothing typed can be submitted to a server or land in the address bar, before or after the
  script runs. No field value is put in a URL, analytics or storage.
- **Try an example** fills a made-up pair: an address sharing Northwind Design's first 4 and last 4 digits.
- Only the headline is announced to screen readers as it changes, not every line under it at each keystroke.

**AC7. The page** (`/check-address`).
- Public and static; the snapshot is read at build time. It is not under `/tools`, whose files are served as downloads.
- Below the checker:
  - what address poisoning is;
  - what Vestiarion does on every payment: a changed address held until a person confirms it; with the payee lock on,
    another person, a contact from before the change and a wait; lookalike warnings; OFAC's list.
  - **Try it on your bills** (`data-cta="check-address-start"`) and a link to the payee lock guide.
- It is in the sitemap and the footer's Resources. The payee lock guide links to it.

## Not in this change

- The live OFAC list on the page: the snapshot is dated, and the page says so.
- Using this broader lookalike rule in the product's own warning (PL6 stays first 6 and last 4).
- Names: ENS and Basenames are a later item.

## Tests

`tests/address-check.test.ts`:
- each format problem, invisible and lookalike characters with the code point named;
- the checksum both ways;
- shared ends, the lookalike thresholds both sides, order, and that every PL6 pair is caught;
- the chance in words, the example;
- OFAC's list and every kind of special address;
- reading known addresses, a transaction hash left out.

`tests/check-address-page.test.tsx`, in a DOM:
- no form;
- the example's headline, comparison and checks, with only the headline live;
- an input that is not an address yet, a known address, nothing found, OFAC and a token contract;
- the page's metadata, CTA, guide link and that it is public;
- no request, address-bar read or analytics call in the checker's code.

`tests/site-footer.test.tsx` and `tests/docs-content.test.ts` cover the footer and the sitemap.
