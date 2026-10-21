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
- A read that fails, or finds fewer than 50 addresses, keeps what there was: the last live read, else the snapshot.
- `SANCTIONED_WALLETS=snapshot` keeps the snapshot even in production. Elsewhere the snapshot answers.

**SW3. The snapshot.**
- `src/lib/data/ofac-sdn-evm-wallets.json` is bundled with the code and dated. `scripts/ofac-sdn-wallets.mjs` makes it
  from the two downloaded files.
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
- A counterparty whose verdict already names that entry is not screened again for it.
- `screenCounterparty` (adding one, **Screen again**) uses the list at hand without the network.

**SW5. The sweep says which list.** The `compliance_sweep` entry carries `sanctionedWallets: { list: "ofac-sdn",
from, readAt, addresses }`.

**SW6. Never paid by a person either.**
- **Approve and pay** refuses an invoice whose address is on the list (`sanctioned_address`), before any claim. An
  approval can confirm a changed address and pay it before a sweep has read it, so this check runs here too.
- **Pay now** on a held milestone does the same.
- The agent never pays a high-risk counterparty, so the guardrail it already has covers its own payments after the
  sweep.

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

`tests/approvals.test.ts` and `tests/milestone-decisions.test.ts` cover the refusals.

## Rollout

No migration. After merge, the production sweep reads the live files. The `compliance_sweep` entry then says
`from: "live"`. Live screening reads OpenSanctions, so it needs `OPENSANCTIONS_API_URL`; the address check needs no
key.
