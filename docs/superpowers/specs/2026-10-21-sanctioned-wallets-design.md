# Sanctioned payout addresses

Date: 2026-10-21. Status: accepted.

## Why

Vestiarion screens a counterparty's name against sanctions lists (OpenSanctions in a live workspace, a short bundled
list in a sandbox). It does not check the address it pays. OFAC's SDN list names digital currency addresses beside
the people and entities it sanctions: 124 EVM addresses on Oct 21, 2026, listed under ETH, USDT, USDC, ARB, BSC and
ETC. An EVM address is the same on Arc and on every chain Vestiarion pays across. A payee whose name screens clean can
still give a sanctioned address, by mistake or on purpose.

The plan named Chainalysis's free sanctions tools. Their documentation now says the on-chain oracle is "no longer
supported or maintained" and not recommended for new integrations. It points to the paid Address Screening product, and
no longer documents the free API. The SDN list itself is the primary source, published by the Treasury, free and
without a key, so Vestiarion reads it directly.

## What

**SW1. The addresses.**
- The Treasury publishes the list as `SDN.CSV`, plus `SDN_COMMENTS.CSV` for remarks that overflow the first file's
  field.
- `parseSdnWallets` (`src/lib/sanctioned-wallets.ts`) reads both:
  - it joins an entry's remarks across the files, since an address can straddle them;
  - it takes every `Digital Currency Address - <currency> 0x…` with 40 hex digits;
  - it keeps each address once, lowercase, with the entry's number, name and every currency it is listed under.
- Addresses that are not EVM (XBT, TRX and others) are left out: Vestiarion pays none.

**SW2. Live in production, kept 12 hours.**
- A production deployment (`VERCEL_ENV=production`), or one with `SANCTIONED_WALLETS=live`, reads both files from
  `sanctionslistservice.ofac.treas.gov` once every 12 hours per instance, with a 20-second timeout.
- One read runs at a time per instance; callers meanwhile wait on it. Requests skip the HTTP cache.
- A read counts only when the comments file has rows and it finds at least half as many addresses as the snapshot (and
  at least 50). One that fails or falls short keeps what there was: the last live read, else the snapshot.
- After a failed read, the next waits 30 minutes, so a slow Treasury site never holds every cycle up.
- `SANCTIONED_WALLETS=snapshot` keeps the snapshot even in production. Elsewhere the snapshot answers.

**SW3. The snapshot.**
- `src/lib/data/ofac-sdn-evm-wallets.json` is bundled with the code and dated. `scripts/ofac-sdn-wallets.mjs` makes it
  from the two downloaded files. (Since 2026-10-28 it also makes the vendor check's name snapshot from `ALT.CSV` and
  `ADD.CSV` in the same run, `2026-10-28-check-vendor-design.md` CV1.)
- A lookup that cannot wait on the network uses the last live read or this snapshot (`cachedSanctionedWallets`).

**SW4. Screening.**
- Every compliance sweep checks each counterparty's payout address against the list, due for screening or not.
- An address on it decides the verdict:
  - risk `high`, with notes naming the address, the entry and the currencies;
  - source `ofac-sdn` and matched entity `ofac-sdn-<entry>`;
  - a payment limit of 0, as for any high-risk verdict.
- It is written as any verdict is: the counterparty's row, a `compliance_checks` row, and a `risk_level_changed` entry
  (or `screen_counterparty` for a first screen).
- No dismissal answers it, since the match is the address itself, not a similar name.
- Only a live read of the list clears it. The snapshot, or a list another instance read earlier, may predate the
  listing, so with either the verdict stands and nothing is written.
- A counterparty whose verdict already names that entry is not screened again for it.
- `screenCounterparty` (adding one, **Screen again**) uses the list at hand without the network.

**SW5. The sweep says which list.** The `compliance_sweep` entry carries `sanctionedWallets: { list: "ofac-sdn",
from, readAt, addresses }`.

**SW6. Never paid by a person either.**
- **Approve and pay** refuses an invoice whose address is on the list (`sanctioned_address`), before any claim. An
  approval can confirm a changed address and pay it before a sweep has read it, so this check runs here too.
- **Pay now** on a held milestone does the same.
- Both load the list live where the deployment does, so their copy is no older than 12 hours.
- The agent takes such an address as high risk at the moment it would pay, in the AP stage's guardrail input and the
  contractor stage, from the list this cycle's sweep read. That covers an address confirmed after the sweep.

## Not in this change

- Addresses that are not EVM, and other lists (EU, UN, UK) for addresses. OpenSanctions' crypto wallet entities can
  cover them once its key is in place.
- Refusing a sanctioned address when it is entered. It is saved, then flagged and never paid, so the record shows what
  was attempted.

## Tests

`tests/sanctioned-wallets.test.ts` covers:
- the parser: currencies, case, an address split between the files, non-EVM entries and lookalike lengths left out;
- the lookup;
- the snapshot's integrity;
- the live read, its 12 hours, failures and too few addresses;
- which list a deployment reads.

`tests/screening-mode.test.ts` covers:
- the sweep making a counterparty with such an address high risk, however fresh its screening, with no name lookup;
- not doing so again;
- `screenCounterparty`.

`tests/screening-mode.test.ts` also covers:
- a verdict kept with the snapshot;
- one screened again by name after a live read without the address;
- a dismissal that does not answer it.

`tests/approvals.test.ts`, `tests/milestone-decisions.test.ts` and `tests/ap-stage.test.ts` cover the refusals.
`tests/sanctioned-wallets.test.ts` also covers one shared read, the 30-minute wait, the stricter guard, CRLF files and
quoted commas.

## Rollout

No migration. After merge, the production sweep reads the live files. The `compliance_sweep` entry then says
`from: "live"`. Live screening reads OpenSanctions, so it needs `OPENSANCTIONS_API_URL`; the address check needs no
key.
