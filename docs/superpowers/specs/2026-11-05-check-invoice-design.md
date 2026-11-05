# Invoice details check: an invoice's payment details against the vendor's on file

Date: 2026-11-05. Status: accepted (decided under the standing autonomy grant); built on branch feat/check-invoice.
Where the build reads the rules more narrowly, or adds one, "As built" at the end says so.

## Why

The most common way a small business loses a payment is not a hacked wallet. It is an invoice, or an email beside it,
that changes where the vendor is paid: "we have changed banks, please update your records". The FBI's IC3 counts
business email compromise among the costliest kinds of fraud it is told of each year, and the usual advice is the
same everywhere: compare the new details with the ones you have, and call the vendor on a number you already had
before you pay.

Nobody does that comparison field by field when a bill is due today. The address checker (`/check-address`) compares
one wallet address with the ones someone knows, and the payout batch check (`/check-payouts`) a batch's rows. Neither
reads a bank account, a sender's domain or the words a change request uses.

This page takes what is on file for a vendor and what the new invoice says, compares them field by field, reads the
message that came with it for the words such requests use, and writes the call to make before paying. Nothing is sent
anywhere. Inside a workspace Vestiarion does the same with the payee lock and "Was this you?", so the step after the
check is short.

## What

**IC1. The page** (`/check-invoice`, `src/app/check-invoice/page.tsx`).
- Public and static, at the top level, like the other free tools. `requiresSession` lets it through.
- Title "Invoice payment details check, free" (the root layout adds the name), a description, a canonical address and
  social cards. Its heading: "Check an invoice's payment details before you pay it".
- Under the checker: how it works and what it does not do, then what Vestiarion does and the shared `ToolCta`.
- It is `check-invoice` in `FREE_TOOLS`, so the footer's Free tools group and the sitemap list it. The address checker
  and the payout batch check link to it for bank details and change requests.

**IC2. The fields** (`InvoiceChecker`, `src/components/invoice-check/InvoiceChecker.tsx`). Each field has two inputs,
**On file** and **On this invoice**, side by side from 640 px and one above the other on a phone. All optional; a
field is compared only when both sides are filled, and a field filled on the invoice only is a new way to be paid when
it is a payment detail.
- **Vendor name**.
- **Email it came from**: the sender's address, and on file the vendor's address you already had.
- **Phone**: the number on the invoice, and the one in your records.
- **IBAN**, **Account number** (when there is no IBAN), **Routing or sort code**, **SWIFT / BIC**, **Bank name**.
- **Wallet address** (EVM), last: most invoices are paid to a bank.
- One box below them, **The message that came with it** (optional): the email or the invoice's note, pasted.
- There is no form and no submit: what the checks say changes as someone types, as on `/check-address`.

**IC3. Field rules** (`checkInvoice`, `src/lib/invoice-check/findings.ts`; formats in `bank.ts` and `domain.ts`).
- **Name**: compared with `nameKey` (`src/lib/invoice-document/match.ts`), so "Northwind Design Ltd." is "Northwind
  Design". A different name is a look.
- **Email**: each side read for one address. The domains compared, case and a trailing dot ignored:
  - the same domain, or one a subdomain of the other: nothing found;
  - a domain made to look like the one on file: a stop. Made to look like: the same name under another ending
    (`northwind.co` for `northwind.com`), the name with a word or a hyphen added (`northwind-billing.com`), one or two
    letters changed, added, removed or swapped, or the same once look-alike letters are read alike (`rn` for `m`, `vv`
    for `w`, `0` for `o`, `1` and `I` for `l`);
  - a domain written with letters outside ASCII, or in its `xn--` form: a stop;
  - a free mail address (Gmail, Outlook, Yahoo, iCloud, Proton and the like) where the one on file is not: a look;
  - any other domain: a look.
- **Phone**: compared as digits. A different number is a look, and the call script says to call the one on file.
- **Wallet address**: the invoice's checked with `checkAddress` (`src/lib/address-check.ts`) against the one on file
  and OFAC's EVM list. Not an address: a fix. On OFAC's list, an invalid checksum, or not a wallet: a stop. Made to look
  like the one on file: a stop. Any other different address: a stop, as a change of payment details.
- **IBAN**: spaces removed, capitals. Its country, its length for that country (the IBAN registry's lengths) and its
  ISO 13616 check digits (mod 97). A failed check: a fix. Different from the one on file: a stop, saying the country
  when it changed too ("The new account is in GB; the one on file is in DE").
- **Account number**: compared as letters and digits. Different: a stop.
- **Routing or sort code**: 9 digits are a US routing number, checked with the ABA check digit; 6 digits, with or
  without hyphens, a UK sort code; anything else is compared as written. A failed ABA check: a fix. Different: a stop.
- **SWIFT / BIC**: 8 or 11 characters in its form (bank, country, place, branch). Not in that form: a fix. A different
  bank or country: a look (a changed account says it as a stop). An IBAN and a BIC on the invoice in different
  countries: a look.
- **Bank name**: compared as `nameKey`. Different: a look.
- **A payment detail on the invoice only** (a wallet, IBAN, account or routing code with nothing on file beside it):
  a look, "a way to be paid that is not on file", unless nothing at all is on file, when the page says it compared
  nothing and the call is for a first payment.

**IC4. The message** (`readMessage`, `src/lib/invoice-check/message.ts`). The pasted text is read for the words change
requests use, each found phrase quoted with its kind:
- **A change of payment details**: new or changed bank, account, banking details, wallet or address; "update your
  records"; "do not use the old account".
- **Pressure**: urgent, immediately, today, as soon as possible, final notice.
- **Keeping you from checking**: do not call, cannot take calls, reply only to this email, email only.
- **Secrecy**: confidential, keep this between us.
- **A reason given for the change**: an audit, tax reasons, an account frozen, closed or on hold.
- A pasted header with a `From:` and a `Reply-To:` on different domains: a look.
A change of payment details in the message is a stop when the fields say nothing changed: what is on file may already
be the new one, so the call is the check. Pressure, keeping you from checking or secrecy beside a change: said in the
headline's reason. Any of the others alone: a look.

**IC5. The verdict** (`checkInvoice`'s `verdict` and `lead`). **Fix** (a detail on the invoice cannot be right as written), **Stop** (do not
pay until you have called the vendor on the number on file), **Look** (check before you pay), **Nothing found**. The
headline names the worst and its reason: "Do not pay yet: the bank account is not the one on file". The page never says
"safe" or "verified"; Nothing found says these checks found nothing, not that the invoice is the vendor's.

**IC6. The call to make** (`callScript`, `src/lib/invoice-check/call-script.ts`). Shown for every verdict except Fix,
with **Copy the script**:
- Who to call: the vendor, on the phone number on file, never one from the invoice or the message. With no number on
  file: one from your own records or their public website, found by you.
- What to say, naming what changed: "We received an invoice asking us to pay a new bank account."
- Ask them to read the details to you, never read them out first; for a wallet, its first and last 6 characters.
- Ask who at their company made the change, and when.
- If they did not make it: do not pay, forward the email to them, and tell your bank at once if anything was sent.
- Write down who you spoke to, the number you called, and when.
Plain text, with placeholders such as `[your name]`; no field's value is put in a link.

**IC7. The example** (`SAMPLE_INVOICE`, `src/lib/invoice-check/sample.ts`). Made up: Northwind Design on file, and an
invoice from `billing@northwlnd-design.com` with a new IBAN in another country, a new phone number, the wallet made to
look like the one on file and a message asking to update records after an audit, saying it cannot take calls this
week. Every value is made up; the IBANs pass their check digits so the example shows the change, not a typo.

**IC8. Nothing leaves the browser.** The page has no form and makes no request. No cookie or storage keeps what is
typed, and the page test holds the checker to that, as `tests/check-payouts-page.test.tsx` does. Analytics may count the
page and a click on the start button, by path only (`FREE_TOOL_COUNT_LINE`).

**IC9. The call to action.** "Vestiarion holds every payment to a payee whose address changed until a person confirms
the new address; with the payee lock on, that takes a recorded check on a contact you had before. Once a workspace pays
for real, it emails the payee's billing address on file to ask whether they made the change, and a payout to a bank
account waits for a person every time." The shared `ToolCta tool="check-invoice"`, and a link to the
payee lock in the first-payment guide.

**IC10. Docs and checks.** README's free tools list, CHANGELOG `[Unreleased]`, ARCHITECTURE's free tools section, the
`/check-address` and `/check-payouts` links, the production check (`scripts/synthetic-check.mjs`: the page and its
sitemap entry) and the tests that list every free tool. Not `/api/v1`, so no `content/docs/changelog.mdx` entry.

## What it does not do

- It does not know who owns an account, a wallet or a domain, and looks nothing up: no bank, no WHOIS, no ENS.
- It does not read a PDF: the details are typed or pasted.
- Nothing found means these checks found nothing, not that the invoice is the vendor's: a first payment, and any
  change, still needs the call.

## Out of scope

- Reading the invoice's file. The bill import's reader runs on the server, and this page sends nothing.
- Checking a name against OFAC's list (`/check-vendor` does).
- Keeping a vendor's details between visits.

## As built

Three reviews (security, a bookkeeper's eye, the code) read the first build. What changed from the rules above:

- **Typing settles first.** The check reads what was typed once typing pauses for 600 ms (`SETTLE_MS`), so a half-typed
  IBAN is not called wrong. The example and Clear are read at once; Clear puts the focus back on the first field.
- **The lead.** A stop's headline names the first stop on a way to be paid (wallet, IBAN, account, routing code, BIC)
  before a stop on the email or the message: "Do not pay yet: the bank account is not the one on file". A fix's
  headline is "Check what you typed: ...".
- **A detail on file that cannot be read** beside one on the invoice that can is a fix for a payment detail or a BIC,
  and a look for an email: "... on file cannot be read, so the invoice's was not compared". It is never a silent skip.
- **Bank details as written.** Spaces of any kind, dashes and labels ("IBAN:", "Sort code:", "ABA", "SWIFT/BIC",
  "Account no.") are taken off before reading. A hidden character (zero-width, a direction mark) is a fix, named by its
  code point. A UK sort code is checked for its form only.
- **Any BIC difference** is a look; with no IBAN on either side it is a stop, since the BIC is then the bank account's
  only sign of which bank it is at, and the call names "bank account".
- **A way to be paid on the invoice only**: a stop when something to pay is on file and none of it matches (a switch
  from an IBAN to an account and routing number, or from a wallet to a bank), a look beside one that matches, and
  nothing when nothing is on file. An account number and its routing code are said once, as one bank account.
- **The sender.** The address in angle brackets is the sender; a display name holding another address is a stop. A
  domain on file may be written alone. A registered name is read under two-label endings (`co.uk`, and `com`, `net`,
  `org` and the like before a two-letter country), and on hosts anyone can have a name on (`onmicrosoft.com` and the
  like), so two names there are never taken as one. The vendor's name as a label of another domain
  (`northwind.com.evil.io`) is a lookalike. Look-alike letters also read `cl` as `d` and `5` as `s`. With free mail on
  file the whole address is compared: one made to look like it is a stop, any other a look. An invoicing service
  (Xero, QuickBooks, Stripe and the like) is a look and its address is not compared. With no email typed, a pasted
  `From:` line is read. The same domain says in its note that a vendor's own mailbox can be broken into.
- **Names in any script.** A name whose `nameKey` is empty (Cyrillic, Greek and others) is compared in NFKC lower case.
- **The message.** Phrases are narrower than IC4's list, so ordinary invoice emails say nothing: "today" alone,
  "tax purposes", "new account manager", "new bank holiday" and a "strictly confidential" footer are not cues; pressure
  needs a payment word near "today" or "immediately". A change cue is always a stop. Pressure, keeping you from
  checking, secrecy and a reason are looks only beside a change, in the fields or the message. Overlapping phrases of
  one kind are said once. A Reply-To from an invoicing service's From is not a look. At most 20,000 characters are read.
- **The call script.** Step 1 asks for the person you usually deal with; step 2 names what changed, or the email that
  asked; step 3 asks them to read the details out and, for a wallet, the whole address or its first 6, last 6 and 6
  from the middle, and says that one character different means do not pay. When a change was asked: do not pay or
  reply, forward the email, ask your bank to recall anything sent the same day, and in the US report it at ic3.gov.
  It ends "Update your records only after this call." With no phone on file it says to use your own records, a past
  invoice you paid, or the vendor's website typed in yourself. With nothing on file it calls the payment a first one.
- **The payout batch check's call to action** said it looked addresses up in more places than it does; it now says
  what Vestiarion checks (`/check-payouts`, CP12).
