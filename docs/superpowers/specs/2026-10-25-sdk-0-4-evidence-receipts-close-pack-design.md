# SDK 0.4: evidence packs, receipts and the close pack through the API (2026-10-25)

Status: accepted. D11 item "[T] SDK 0.4: functions for evidence packs, receipts and the close pack". It is built after
the monthly close pack (`docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md`) merges, on its module
(`src/lib/close-pack/`). If `src/lib/close-pack/read.ts` and `export.ts` are not on `main`, stop: this item needs them.

The 30-day build list puts "API and MCP for payee lock, evidence pack, close pack" on D16. This item pulls the API part
of it forward: five keyed reads, their OpenAPI operations, Postman, and SDK 0.4.0 with an offline verifier. The MCP
tools stay on D16 (EA9), and so does anything else D16 plans for the payee lock.

## Why

Vestiarion signs every fact about a payment into its ledger, and the workspace's pages already hand those facts out as
signed files: **Download evidence** on a payment's evidence page (`vestiarion-evidence/1`), the payee lock's evidence pack
(`vestiarion-payee-lock-evidence/1`), a shared receipt, and the monthly close pack (`vestiarion-close-pack/1`). Each needs
a person signed in, in a browser.

The people who need these files most often are not in the browser:
- a bookkeeping or close tool that wants each month's close pack, with every payment's signed entry, without someone
  downloading it by hand;
- an auditor's or an insurer's tooling that samples payments and checks each one's evidence on its own machine;
- the business's own system, which attaches a paid bill's receipt to its record.

The SDK can only call what `/api/v1` exposes, so this item adds the reads, then gives the SDK one method for each and a
function that checks any of these files offline with Web Crypto alone, the way `verifyLedgerEntry` checks one entry.

It reads and checks. It decides nothing, pays nothing, calls no model, and writes nothing: no ledger entry, no row.

## Rules

Each rule ends with what it costs if it is wrong. Code comments and test names cite the ids, for example "(evidence API
EA6)".

**EA1. Five keyed reads, under a new tag "Evidence".**

| Operation id | Route | SDK method | What answers |
|---|---|---|---|
| `get-invoice-evidence` | `GET /api/v1/invoices/{id}/evidence` | `vestiarion.invoices.evidence(id)` | `readEvidence("invoice", id, { people: "id" })`, then `evidenceDocument` |
| `get-milestone-evidence` | `GET /api/v1/milestones/{id}/evidence` | `vestiarion.milestones.evidence(id)` | `readEvidence("milestone", id, { people: "id" })`, then `evidenceDocument` |
| `get-invoice-receipt` | `GET /api/v1/invoices/{id}/receipt` | `vestiarion.invoices.receipt(id)` | `readReceiptDocument` (new, EA4) |
| `get-payee-lock-evidence` | `GET /api/v1/payee-lock/evidence?from=&to=` | `vestiarion.payeeLock.evidence({ from, to })` | `readPayeeLockEvidence({ period, people: "id" })` |
| `get-close-pack` | `GET /api/v1/close-packs/{month}` | `vestiarion.closePacks.get(month)` | `readClosePack({ month, people: "id" })`, then `closePackDocument` |

- Route files: `src/app/api/v1/invoices/[id]/evidence/route.ts`, `src/app/api/v1/milestones/[id]/evidence/route.ts`,
  `src/app/api/v1/invoices/[id]/receipt/route.ts`, `src/app/api/v1/payee-lock/evidence/route.ts`,
  `src/app/api/v1/close-packs/[month]/route.ts`. Each `export const dynamic = "force-dynamic"`, `GET` only.
- Each handler is the pinned v1 shape (`tests/access-gates.test.ts`): `const guard = await guardApiRequest(request, {
  scope: "read" });` then `if ("denied" in guard) return guard.denied;`, then `await params` and the cheap checks (EA5),
  then the brake (EA6), then `handleApiRequest("<label>", guard.key, ...)`, which runs inside `withOrg(key.orgId)`.
- `params` is a Promise in Next.js 16: `{ params }: { params: Promise<{ id: string }> }`, awaited.
- The five come last in `OPERATIONS`, in the order of the table, tag `"Evidence"` added to `DocOperation["tag"]`. The
  endpoint overview and Postman get an "Evidence" table and folder, after "Insights".
- The two evidence reads are one operation per record kind, nested under the record's own path, as `get-counterparty`
  is: `invoices.evidence(id)` reads as what it is, both subject shapes get their own example, and no path takes an enum.
- If wrong: an integrator finds the reads under a path they did not expect. Paths are the reference page URLs, so moving
  one later is a breaking change and a changelog entry; the ids are pinned in `tests/openapi.test.ts`.

**EA2. Each answers the same document its download gives, in `{ data }`.**
- `data` is the exact document the session download builds, by the same builder, with members named by id (EA3). So a
  file downloaded from the workspace and an API answer's `data` are checked by the same `verifyEvidence` (EA13).
- JSON only. The SDK's transport parses every `2xx` as JSON (`sdk/src/http.ts`), the MCP call path does too, and a CSV
  is already a session download. The Google Sheets export uses `closePackTable`, not this route.
- The answer is serialized once by `documentAnswer` (`src/lib/api/evidence.ts`): `JSON.stringify({ data })`, with
  `content-type: application/json` and `cache-control: no-store`, as a payee link's answer is.
- The file formats change only additively:
  - `vestiarion-payee-lock-evidence/1`: a member is `{ kind: "member", userId, email }`, `userId` added (EA3);
  - every document's `checkAnEntry` is a plain array, `[...CHECK_AN_ENTRY]`, not a readonly tuple (EA10); its JSON is
    unchanged;
  - the payee lock's `lock.changes[].from` and `to` are read as a lock (`{ on, coolingHours }`) or `null`, never an
    arbitrary value (EA10); every `payee_lock_changed` entry already signs a lock there.
- If wrong: an integrator gets a document that differs from the download and has to handle two shapes. The format
  strings are versioned, so an incompatible change is `/2`.

**EA3. Members are named by user id, never by email.**
- The ledger API already names people by id (`detail.by`), and an API key is held by a system, not a person: member
  emails stay inside the workspace's pages and its downloads.
- Per document:
  - evidence: `readEvidence` takes `people: "id"`, and its people map becomes user id to user id, so each fact's `who`
    and every sentence that names a person name them by their full user id. Someone no longer a member is "a former
    member"; when members cannot be read, "a member", as today (evidence chain E5).
  - payee lock: `readPayeeLockEvidence` takes `people: "id"`; a member is `{ kind: "member", userId, email: null }`; a
    former member stays `{ kind: "former_member", id }` with the first 8 characters.
  - close pack: `readClosePack({ people: "id" })`, as its spec's CP18 says: `ClosePackWho` with `email: null`.
  - receipt: names no one, as a receipt never does (payment receipts R1).
- Session downloads keep naming members by email; the default stays `"email"` everywhere.
- If wrong: an integration cannot show who approved a payment without a list of members, which v1 does not offer. Adding
  emails later is additive (`email` is already a field, `null` for now); taking them away after shipping them is not.

**EA4. The receipt read.** `GET /api/v1/invoices/{id}/receipt` answers `vestiarion-receipt/1` for a payable of the
workspace (`ReceiptDocument`, `src/lib/receipts/document.ts`):
- `ready`: the payment has a receipt: paid, confirmed, on chain, and a signed entry records its transaction, exactly what
  **Share receipt** needs (`buildReceipt`).
- `notReady`, when not ready: `{ code, reason }`, `reason` being the builder's own sentence and `code` its name:

| `code` | `reason` (unchanged, `src/lib/receipts/facts.ts`) |
|---|---|
| `not_payable` | "Only a payment the workspace made has a receipt." (never answered: a receivable is a 404 first) |
| `not_paid` | "This invoice is not paid yet." |
| `simulated` | "A simulated payment has nothing on chain to show." |
| `not_minted` | "The payee's chain has not minted this payout yet." |
| `no_transaction` | "This payment has no transaction on chain to show." |
| `not_recorded` | "No ledger entry records this payment's transaction." |

- `facts`: what a receipt states for this payment, as `buildReceipt` builds it now (`ReceiptFacts`: amount, token, paid
  at, the address paid, its chain, the transaction, route, burn, route fee, invoice number, the invoice's amount when a
  discount took part off, `feesPaidBy: "sender"`). `null` when not ready.
- `records`: the entry that recorded the transaction, `{ seq, hash }` (`recordingEntry`). `invoiceEntry`: the
  `create_invoice` (or `import_invoice`, `recurring_invoice_created`) entry the invoice number comes from, or `null`.
- `shared`, when a member shared the receipt: `{ at, entry, linkOpen, changes }`: when it was first shared
  (`payment_receipts.created_at`), the `receipt_shared` entry that signed its statement (`entry_seq`), whether its link
  opens now (`revoked_at` is null), and the `receipt_link_renewed` / `receipt_revoked` entries since, `{ action, at,
  entry }`. Never the link, its token or its hash: `token_hash` is never selected.
- `checks`, when ready: `recorded`, the recording entry checked alone (`verifyEntry`) and holding the transaction
  (`recordsTransaction`), else `{ ok: false, reason: "The entry this receipt names does not record its transaction." }`;
  and `onChain`, `readOnChain(facts)`, Arc's or the payee chain's record (4 s timeout, mined receipts remembered).
- `entries`: `invoiceEntry`, the recording entry, `receipt_shared` and its changes, oldest first, in full with the
  server's check, and `keys`, `signedEntryProves`, `checkAnEntry`, as the evidence file carries them.
- A shared receipt signed before receipts v2 states less than `facts` does now. The document carries its
  `receipt_shared` entry in full, so the statement the payee saw is there, signed, beside what a share would state now.
- A milestone has no receipt route: a milestone has no receipt (payment receipts P1).
- The recording entry is carried in full, though the public receipt page never shows it (it holds reasoning and ids):
  a read key already reads every entry through `GET /api/v1/ledger`, and carrying it lets the SDK check the receipt
  offline.
- If wrong: a poller treats a sandbox payment as "not paid yet" and asks forever, or a link that works as a credential
  leaks. The codes tell a permanent state (`simulated`) from a passing one, and the link is never read.

**EA5. Ids, months and periods are checked before anything is read.**
- An evidence or receipt `id` that is not a UUID is answered `404` with no query, as `evidenceRequest` already refuses
  it. A receivable, and an id the workspace does not hold, another workspace's included, answer the same `404`: every
  read runs in the key's workspace through `db()`.
- `month` is read by `closePackMonth(month, now)`. `null` (a malformed month, one before 2020, one still to come) is
  `400`. This month is allowed and reads "so far" (`month.ended: false`).
- `from` and `to` are read by `parsePeriod`, whole UTC days, either end open. `null` is `400`.
- A `400` or a malformed `404` takes no token from the brake (EA6).
- If wrong: a typo spends a heavy read, or a probe learns whether an id exists elsewhere. Neither happens: both are
  answered before the database is asked.

**EA6. The evidence reads have their own brake, per key.**
- `takeApiEvidenceToken(keyId)` (`src/lib/rate-limit.ts`): 10 at once, then one every 6 seconds, per API key, per
  server instance, one bucket shared by the five operations. Over it: `429 rate_limited`, `Retry-After: 60`, "Too many
  evidence reads from this key. Try again in a minute."
- Why: each read checks every cited entry's signature, and the evidence reads also ask Arc's RPC for the transaction and
  check the links people gave against GitHub and Asana, with Vestiarion's own connection where the workspace has none.
  The session routes are braked the same way (`takeEvidencePackToken`). Every other read stays unlimited.
- `Retry-After: 60` is when the bucket is full again, the same header every `429` of the API carries, so the SDK's wait
  (it waits out a `Retry-After` of up to 60 s) gives a loop about 10 reads a minute.
- The guard's unused `rateLimited` option (keyed by IP, shared with the cycle endpoint) is not used.
- If wrong: a backfill of a year of evidence takes hours, or a loop on many instances gets through more than the brake
  says. The close pack gives a whole month in one read, and the brake is a soft one, as the write brake is.

**EA7. A period's answer is at most 4 MB.**
- Vercel's functions refuse a response body over 4.5 MB. The close pack and the payee lock's evidence grow with the
  period (a month of 2,000 payments, or a lock's whole history), so `documentAnswer` measures the UTF-8 bytes of
  `{ "data": ... }` and, over `API_DOCUMENT_MAX_BYTES` (4,000,000), answers `400 invalid_request`:
  - close pack: "This month's close pack is over 4 MB, more than one answer carries. Download it from the workspace's
    Monthly close pack page."
  - payee lock: "This period's evidence is over 4 MB, more than one answer carries. Ask for a shorter period with from
    and to."
- One payment's evidence and its receipt are bounded by one record (at most 500 counterparty entries), so they are not
  measured.
- If wrong: a business with a few hundred payments a month cannot read its close pack through the API. A later item can
  page the rows (`/close-packs/{month}/rows?cursor=`), which is additive.

**EA8. The reads write nothing.**
- No ledger entry, no webhook delivery, no row, no cache. A key's use is recorded as every read's is: `last_used_at`, at
  most once a minute.
- Unlike the close pack's download (`close_pack_exported`, CP13), the API's close pack records no entry, as its spec's
  CP18 says: a sync job that reads a month every hour would fill the ledger and every webhook endpoint. The key, its
  name and its last use, on Settings, say which system reads.
- If wrong: an auditor cannot tell from the ledger that a system took a month's books. Adding an entry later is
  additive.

**EA9. No MCP tool yet: those are D16's.**
- `DocOperation` gains `mcp?: false`. The five carry it. `MCP_TOOLS = OPERATIONS.filter((op) => op.mcp !== false)
  .map(toTool)`, and `src/lib/mcp/call.ts` does not import their routes.
- Why: a tool's answer goes into a model's context whole. One payment's evidence carries every entry in full (tens of
  KB) and a close pack up to 4 MB; both are full of text from outside (vendors' names, memos, purchase orders a vendor
  typed). A tool needs its own answer (a summary, the rows without their entries, the server's verdict) and its own
  handling of that text, which is design work for D16, together with its tool count, `server.json` and the registry.
- `tests/access-gates.test.ts` names the five route files in `NO_MCP_TOOL_YET`, so the MCP route reaches every keyed
  route but those, and the list equals the routes of the operations with `mcp: false`. D16 removes the flag and the list
  row by row.
- If wrong: an agent on MCP cannot read evidence until D16. It still reads the ledger and the records.

**EA10. Schemas and types the SDK can render.**
- `src/lib/api/schemas.ts` adds `EntryCheckSchema`, `OnChainCheckSchema`, `EvidenceKeySchema`, `SignedEntrySchema`,
  `PaymentEvidenceSchema`, `PaymentReceiptSchema`, `PayeeLockEvidenceSchema` and `ClosePackSchema`.
- They import nothing at run time from the builders (`import type` only) and write the format strings and enums as
  literals: `/api/v1/openapi.json` is public and must load no module that reads tenant data (`tests/access-gates.test.ts`,
  "the public /api/v1 routes").
- Each mirrors an explicit exported interface, and `tests/api-schemas.test.ts` holds them equal with `toEqualTypeOf`:
  - `EvidenceDocument` and `SignedEntry` (`src/lib/evidence-export.ts`), replacing `ReturnType<typeof evidenceDocument>`,
    and `evidenceDocument` declares it returns one;
  - `PayeeLockEvidence` (`src/lib/payee-lock-evidence.ts`), replacing its `ReturnType`, the same way;
  - `ReceiptDocument` (`src/lib/receipts/document.ts`);
  - `ClosePackDocument` (`src/lib/close-pack/export.ts`), whose `ClosePackEntry` becomes `SignedEntry`.
- Only what `scripts/lib/sdk-types.ts` renders: `z.object`, `z.string` (`.regex` at most), `z.number`, `z.number().int()`,
  `z.boolean`, `.nullable()`, `.optional()`, `z.literal`, `z.enum`, `z.array`, `z.union` of objects, `z.record(z.string(),
  ...)` and `z.partialRecord(z.enum(...), ...)`. No `.readonly()`, no tuple, no `z.unknown()` as a field's own type, no
  `format`, no `.meta({ id })`. So `checkAnEntry: string[]`, and `lock.changes[].from` is `PayeeLock | null`.
- `detail` is `z.record(z.string(), z.unknown())`, as `LedgerEntrySchema` has it.
- Descriptions never write a network's name: "the workspace's network" (`tests/network-copy-ratchet.test.ts`).
- If wrong: `npm run sdk:types` throws on a keyword, or the SDK's types drift from what the routes answer. Both fail
  `npm run verify`.

**EA11. The examples are built, not recorded.**
- Every other operation's example is a recorded answer. These five are built by `scripts/evidence-examples.ts` (run
  `npx tsx scripts/evidence-examples.ts`) with the real builders, from a made-up workspace, "Northstar Studio"
  (`northstar-studio`) on Arc testnet, signed with an Ed25519 key the script makes for the run and never writes down:
  - a payable paid by a person after an accountant's co-sign, with its address given by one member and confirmed by
    another, and its receipt shared once;
  - a milestone the agent released after GitHub reported its pull request merged;
  - the payee lock's evidence for October 2026, one change, confirmed by a second person, then paid;
  - the close pack of October 2026: those two payments and one not settled.
- Why: a recorded pack would publish a real workspace's private entries (reasoning, member ids, payees) in a public
  repository, and a redacted one would no longer verify. A built one has the exact shape and verifies with the key it
  carries, which `tests/sdk-evidence.test.ts` checks for every example.
- Each is written as one line of JSON, `{ "data": ... }`, as the others are. A rerun signs again with a new key, so it is
  run only when a shape changes.
- If wrong: the reference pages show a made-up workspace. Every id, hash and address in them is made up and says so in
  the workspace's name; the prod proof below reads the real ones.

**EA12. SDK 0.4.0 has a method for each.**
- `invoices.evidence(id): Promise<PaymentEvidence>`, `invoices.receipt(id): Promise<PaymentReceipt>`,
  `milestones.evidence(id): Promise<PaymentEvidence>`, `payeeLock.evidence(params?: GetPayeeLockEvidenceParams):
  Promise<PayeeLockEvidence>`, `closePacks.get(month: string): Promise<ClosePack>`.
- Each returns the answer's `data`. Path values are `encodeURIComponent`-ed; the SDK checks no id or month itself: the
  API answers `400` or `404`, which the SDK throws at once.
- The generated names (`scripts/lib/sdk-types.ts` `NAMED`): `PaymentEvidence` (`GetInvoiceEvidenceResponse.data`, the
  same as `GetMilestoneEvidenceResponse.data`), `PaymentReceipt`, `PayeeLockEvidence`, `ClosePack`.
  `GetPayeeLockEvidenceParams` is generated from the query parameters.
- No change to the transport: no new timeout, no binary path. A `429` is waited out as every `429` is.
- If wrong: a method name is part of the SDK's API for good. These follow the existing nouns (`invoices`, `milestones`)
  and the operation ids.

**EA13. `verifyEvidence` checks a document offline.** `sdk/src/evidence.ts`, exported from `@vestiarion/sdk` (the root,
not a new subpath): `verifyEvidence(document, { keys? })`.
- It takes any of `vestiarion-evidence/1`, `vestiarion-payee-lock-evidence/1`, `vestiarion-receipt/1` and
  `vestiarion-close-pack/1`, from the API or downloaded from the workspace, as it is: snake_case entries are mapped to
  `verifyLedgerEntry`'s fields (`body_hash` to `bodyHash`, `prev_hash` to `prevHash`, `signing_key_id` to
  `signingKeyId`). Anything else throws a `TypeError` (copy below).
- It checks, with Web Crypto only and no request:
  - every entry it carries, with `verifyLedgerEntry` (body hash, Ed25519 signature by a key filed under its true id,
    chain hash); the document's own `check` fields are never read;
  - every entry a fact cites is carried: evidence `steps[].facts[].entries`; payee lock `changes[].change.entry`,
    `confirmation.entry`, `holds[].entry`, `firstPayment.entry` and `lock.changes[].entry`; receipt `records.seq`,
    `invoiceEntry`, `shared.entry` and `shared.changes[].entry`; close pack `rows[].entries`, `rows[].record.seq`,
    `rows[].bill.entry`, `rows[].bill.vendorDocuments[].entry`, `rows[].approval.agent.entry`,
    `rows[].approval.approvals[].entry`, `rows[].approval.verdict.entry`, `rows[].approval.address.entries`,
    `rows[].checks.<check>.entries`, `rows[].books.booked.entry` and `escrow[].entry`. A row's `entries` is the union of
    the fields after it (`buildRow`), and each is read too, so a file that keeps only that list tidy still fails;
  - where it carries two entries whose `seq` follow each other, the later one's `prev_hash` is the earlier one's `hash`:
    nothing of the same workspace can sit between them, as `verifyChain` reads the chain by `seq`;
  - a copy matches what it copies: a close pack row's `record` (`hash`, `signature`, `signingKeyId`) equals its entry's,
    and a receipt's `records.hash` equals its entry's `hash`.
- `keys`: the public key from the workspace's **Audit log** page, or a map of key id to PEM after a rotation, exactly
  as `verifyLedgerEntry` takes them. Without `keys`, it uses the document's own `keys` and says so (`keys:
  "document"`): that proves the entries were not changed after those keys signed them, not that the keys are the
  workspace's.
  - Ruled in review: `keys` named with no value (`{ keys: undefined }`, as `process.env.X!` gives when the variable is
    unset) throws the `keys` `TypeError`, as `verifyLedgerEntry` fails closed on it, so an unset variable never falls
    back to the document's keys. Leaving `keys` out, or passing no options, still uses the document's keys, and `ok` is
    still `true` when everything holds: `keys: "document"` and its note say whose keys checked it.
  - A key given that cannot be decoded as a PEM throws the same `TypeError` before any entry is checked, since
    `verifyLedgerEntry` decodes every key it is given and one bad key would leave every entry `ok: null`. A key the
    document carries that cannot be decoded is left out, with the note "The key filed under <id> could not be read as a
    PEM public key."; the entries the other keys signed keep a real `true` or `false`.
- It answers `{ ok, format, keys, entries: [{ seq, check }], counts: { cited, carried, verified, failed, unchecked },
  problems }`. `ok` is `false` when any entry fails or any problem other than an unknown key is found; `null` when
  nothing failed but some entry's key was not among those given; `true` otherwise. An empty month is `true`.
- What it cannot say, and the docs say: that the facts' words follow from the entries (that is the server's reading),
  that the document carries every entry of the period (compare `seq` and `hash` with `GET /api/v1/ledger` or an audit
  export), or anything on chain (open the explorer link).
- If wrong: a tampered document reads as verified. Each entry's check is `verifyLedgerEntry`, already held equal to the
  receipt verifier, and `tests/sdk-evidence.test.ts` holds this one's verdicts to the server's `verifyEntry` too.

**EA14. The version, the tarball and the CLI.**
- `sdk/package.json` and `sdk/src/version.ts` become `0.4.0`; `npm run sdk:types`, then `npm run sdk:pack`, which writes
  `public/sdk/vestiarion-sdk-0.4.0.tgz`, committed. No earlier tarball is touched or repacked.
- Why 0.4.0, not 0.3.8: a new capability, and every `^0.3.x` range (the CLI's) keeps resolving 0.3.x until it is moved
  on purpose.
- The CLI is not touched, and keeps working against the SDK on npm:
  - `cli/package.json` keeps `"@vestiarion/sdk": "^0.3.2"`, the root `package.json` devDependency keeps `"^0.3.2"`, and
    `package-lock.json` keeps resolving `0.3.2` from registry.npmjs.org. A caret on 0.x pins the minor, so `^0.3.2`
    never resolves 0.4.0, and no `npm install` is run in this PR.
  - `npm run check:lock` compares the declared ranges with the lock: unchanged, it passes. `tests/cli-package.test.ts`
    still unpacks `public/sdk/vestiarion-sdk-0.3.2.tgz`, which stays.
  - The CLI imports the SDK from npm, never `sdk/src`, so nothing in it sees the new methods.
- After the partner publishes 0.4.0 to npm, a later PR moves both ranges to `^0.4.0` together, runs `npm install` on
  Windows for the lock, and may then add CLI commands (`vestiarion evidence verify <file>`). RELEASING already says the
  SDK version the CLI needs must be on npm first.
- If wrong: the CLI breaks for every user the moment the lock or a range moves to an SDK not on npm. Nothing moves.

**EA15. Postman and the reference.**
- `npm run postman:build` regenerates both collections; the reference collection gets an "Evidence" folder.
- `scripts/lib/postman.ts` `errorMessage` learns each new message: `not_found` for the three record reads,
  `invalid_request` for the month and the period (a read's `invalid_request` is no longer always the cursor's), and
  `rate_limited` for a read. Each quoted message is a literal in `src/lib/api` or `src/app/api/v1`, where
  `tests/postman.test.ts` looks for it.
- The reference pages, the endpoint overview, the `.md` views and `/llms.txt` are generated from `OPERATIONS`: nothing
  to write by hand but `info.description` (`src/lib/api/openapi.ts`) and `SUMMARY` (`src/lib/docs/markdown.ts`).
- If wrong: a saved Postman error quotes a message the API never sends. The test fails until it matches.

**EA16. Text, links and files from outside are data.** Vendors' names, invoice numbers, memos, purchase orders typed
on a document request page, a GitHub login, a link a person gave: the documents carry them as JSON strings and nothing
else.
- No model reads or writes anything in these reads.
- Links: only what the builders already build (explorer links from the chain profiles, checked as `0x` plus 64 hex;
  evidence pages from `orgHref`). A link a person or a payee gave keeps `given: true` and the state its check found.
- No file is read or served: documents are named by the SHA-256 their entries signed.
- Each operation's description says: "Text that came from outside, such as a vendor's name, an invoice number or a
  memo, is carried as data."
- If wrong: a consumer that pipes a pack into a model is steered by a vendor's memo. The documents say what such text
  is, and MCP, where a model reads them directly, waits for D16 (EA9).

**EA17. No migration.** Every table and column read is already there; see "No migration" below.

**EA18. Docs and lists.** See "Docs and lists to update".

## The shared contract

Pure modules import types only from server modules.

```ts
// src/lib/rate-limit.ts adds (EA6)
/** Ten evidence reads at once per API key, then one every 6 seconds; one bucket for the five. Single-instance. */
export function takeApiEvidenceToken(keyId: string, now?: number): boolean;

// src/lib/api/evidence.ts: server; every helper the five routes share
export const API_DOCUMENT_MAX_BYTES = 4_000_000;
export const EVIDENCE_READS_LIMITED = "Too many evidence reads from this key. Try again in a minute.";
/** 429 rate_limited, Retry-After: 60 (EA6). */
export function evidenceReadsLimited(): NextResponse;
/** The key's workspace, `{ slug, name }`, from `orgs` by `currentOrgId()`, through `platformDb()`. */
export async function workspaceInScope(): Promise<{ slug: string; name: string }>;
/**
 * `{ data: document }` as JSON, with `cache-control: no-store`. With `tooLarge`, a body over API_DOCUMENT_MAX_BYTES
 * answers 400 invalid_request with that message instead (EA7).
 */
export function documentAnswer(document: object, options?: { tooLarge?: string }): NextResponse;
/** One payable's or milestone's evidence, members by id (EA3); null when the workspace holds no such payable or milestone. */
export async function readPaymentEvidence(kind: "invoice" | "milestone", id: string): Promise<EvidenceDocument | null>;
```

```ts
// src/lib/evidence-read.ts: readEvidence's options gain `people` (EA3)
export async function readEvidence(
  kind: unknown,
  id: unknown,
  options?: { fetch?: typeof fetch; rpcUrl?: (chain: string) => string; links?: LinkCheckOptions; people?: "email" | "id" }
): Promise<EvidenceRead | null>;

// src/lib/evidence-export.ts (EA10)
/** A cited entry in full, snake_case, with the server's check: every evidence file carries these. */
export interface SignedEntry {
  seq: number;
  id: string | null;
  ts: string;
  actor: string;
  domain: string;
  action: string;
  summary: string;
  detail: Record<string, unknown>;
  body_hash: string;
  signature: string;
  prev_hash: string;
  hash: string;
  signing_key_id: string | null;
  check: EntryCheck | null;
}
export interface EvidenceDocumentFact {
  label: string;
  kind: EvidenceKind;
  text: string;
  who: string | null;
  at: string | null;
  fill?: string;
  notes?: string[];
  link?: EvidenceLink;
  warn?: true;
  entries: number[];
}
export interface EvidenceDocumentStep {
  id: EvidenceStepId;
  title: string;
  label: string;
  kind: EvidenceKind;
  caveat?: string;
  facts: EvidenceDocumentFact[];
}
export interface EvidenceDocument {
  format: typeof EVIDENCE_FORMAT;
  exportedAt: string;
  workspace: { slug: string; name: string };
  network: { id: Network; label: string };
  subject: EvidenceChain["subject"];
  labels: Record<string, { words: string; meaning: string; facts: number }>;
  steps: EvidenceDocumentStep[];
  signedEntryProves: string;
  checkAnEntry: string[];
  keys: EvidenceKey[];
  entries: SignedEntry[];
}
export function evidenceDocument(input: { chain: EvidenceChain; workspace: { slug: string; name: string }; keys: EvidenceKey[]; now: Date }): EvidenceDocument;
```

```ts
// src/lib/payee-lock-evidence.ts (EA3, EA10)
export type Who =
  | { kind: "member"; userId: string; email: string | null }
  | { kind: "former_member"; id: string }
  | { kind: "payee_link"; linkId: string | null }
  | { kind: "github"; login: string | null }
  | { kind: "unknown" };
export interface PayeeLockEvidenceInput {
  /* ...as today, plus: */
  /** "email" for a member's download; "id" for the API (EA3). Default "email". */
  people?: "email" | "id";
}
/** The document as an interface, field for field what `payeeLockEvidence` returns today, with the changes of EA2. */
export interface PayeeLockEvidence { /* format, exportedAt, workspace, network, period, lock { now, changes[{ at, by, from: PayeeLock | null, to: PayeeLock | null, entry }] }, summary, changes, signedEntryProves, checkAnEntry: string[], keys, entries: SignedEntry[] */ }
export function payeeLockEvidence(input: PayeeLockEvidenceInput): PayeeLockEvidence;

// src/lib/payee-lock-evidence-read.ts
export async function readPayeeLockEvidence(input: { workspace: { slug: string; name: string }; period: Period; now?: Date; people?: "email" | "id" }): Promise<PayeeLockEvidence>;

// src/lib/payee-lock-evidence-report.ts: whoWords names a member by email, else by user id.
```

```ts
// src/lib/receipts/facts.ts (EA4): the refusals become named sentences, text unchanged
export type ReceiptNotReady = "not_payable" | "not_paid" | "simulated" | "not_minted" | "no_transaction" | "not_recorded";
export const RECEIPT_REFUSALS: Readonly<Record<ReceiptNotReady, string>>;
/** The code of one of the builder's refusals; "not_recorded" for none of them, which never happens. */
export function receiptNotReady(reason: string): ReceiptNotReady;

// src/lib/receipts/document.ts: pure (EA4)
export const RECEIPT_FORMAT = "vestiarion-receipt/1";
export interface ReceiptDocument {
  format: typeof RECEIPT_FORMAT;
  exportedAt: string;
  workspace: { slug: string; name: string };
  network: { id: Network; label: string };
  invoiceId: string;
  ready: boolean;
  notReady: { code: ReceiptNotReady; reason: string } | null;
  facts: ReceiptFacts | null;
  records: { seq: number; hash: string } | null;
  invoiceEntry: number | null;
  shared: {
    at: string;
    entry: number;
    linkOpen: boolean;
    changes: Array<{ action: "receipt_link_renewed" | "receipt_revoked"; at: string; entry: number }>;
  } | null;
  checks: { recorded: EntryCheck; onChain: OnChainCheck } | null;
  signedEntryProves: string;
  checkAnEntry: string[];
  keys: EvidenceKey[];
  entries: SignedEntry[];
}
export function receiptDocument(input: {
  workspace: { slug: string; name: string };
  network: Network;
  invoiceId: string;
  built: BuiltReceipt;
  /** The `payment_receipts` row, or null when never shared. */
  receipt: { created_at: string; entry_seq: number; revoked_at: string | null } | null;
  /** Every entry read for it, each with its check. */
  entries: readonly SignedEntry[];
  checks: ReceiptDocument["checks"];
  keys: EvidenceKey[];
  now: Date;
}): ReceiptDocument;

// src/lib/receipts/document-read.ts: server, inside the workspace's scope, reads through db()
/** Null when the workspace holds no payable by that id: a receivable, an unknown id, another workspace's. */
export async function readReceiptDocument(input: {
  invoiceId: string;
  workspace: { slug: string; name: string };
  now?: Date;
  fetch?: typeof fetch;
  rpcUrl?: (chain: string) => string;
}): Promise<ReceiptDocument | null>;
```

```ts
// src/lib/close-pack/export.ts: ClosePackDocument's checkAnEntry becomes string[]; ClosePackEntry = SignedEntry.

// src/lib/api/openapi.ts
export interface DocOperation {
  /* ...as today; tag adds "Evidence" */
  /** No MCP tool yet: D16 designs these tools (evidence API EA9). */
  mcp?: false;
}

// src/lib/api/schemas.ts (EA10)
export const EntryCheckSchema, OnChainCheckSchema, EvidenceKeySchema, SignedEntrySchema,
  PaymentEvidenceSchema, PaymentReceiptSchema, PayeeLockEvidenceSchema, ClosePackSchema;
```

```ts
// sdk/src/evidence.ts: Web Crypto only, no node: import (EA13)
export const EVIDENCE_FORMATS = [
  "vestiarion-evidence/1",
  "vestiarion-payee-lock-evidence/1",
  "vestiarion-receipt/1",
  "vestiarion-close-pack/1",
] as const;
export type EvidenceFormat = (typeof EVIDENCE_FORMATS)[number];
export interface EvidenceVerification {
  /** true: every cited entry is carried and verifies, and every link and copy holds; false: something does not; null: nothing failed, but some entry's key was not given. */
  ok: boolean | null;
  format: EvidenceFormat;
  /** Whose keys checked it: the ones passed, or the document's own. */
  keys: "given" | "document";
  entries: Array<{ seq: number; check: EntryCheck }>;
  counts: { cited: number; carried: number; verified: number; failed: number; unchecked: number };
  /** One plain sentence for each thing that is not as it should be. */
  problems: string[];
}
export async function verifyEvidence(document: unknown, options?: { keys?: string | Record<string, string> }): Promise<EvidenceVerification>;

// sdk/src/client.ts (EA12)
invoices.evidence(id: string): Promise<PaymentEvidence>;
invoices.receipt(id: string): Promise<PaymentReceipt>;
milestones.evidence(id: string): Promise<PaymentEvidence>;
payeeLock.evidence(params?: GetPayeeLockEvidenceParams): Promise<PayeeLockEvidence>;
closePacks.get(month: string): Promise<ClosePack>;
// `one<T>(path, query?)` takes a query for payeeLock.evidence.
```

How the close pack route reads, end to end:

```ts
export async function GET(request: Request, { params }: { params: Promise<{ month: string }> }) {
  const guard = await guardApiRequest(request, { scope: "read" });
  if ("denied" in guard) return guard.denied;

  const { month: asked } = await params;
  const month = closePackMonth(asked, new Date());
  if (!month) return apiError("invalid_request", "month must be YYYY-MM, and not a month still to come");
  if (!takeApiEvidenceToken(guard.key.keyId)) return evidenceReadsLimited();
  return handleApiRequest("GET /api/v1/close-packs/{month}", guard.key, async () => {
    const pack = await readClosePack({ month, workspace: await workspaceInScope(), people: "id" });
    return documentAnswer(closePackDocument(pack, { origin: publicOrigin() }), { tooLarge: CLOSE_PACK_TOO_LARGE });
  });
}
```

## Data it reads and writes

Every read runs in the key's workspace (`withOrg(key.orgId)`), through `db()`, which adds `org_id`; the workspace's slug
and name come from `orgs` through `platformDb()` by that same id.

| Operation | Reads |
|---|---|
| all five | `orgs` `slug, name` (`workspaceInScope`); the workspace's ledger keys, active and retired (`ledgerVerificationKeyring`, `exportKeys`, `ledgerPublicKeyPems`); `org_members` through `listMembers` |
| invoice and milestone evidence | as `readEvidence` reads today: `invoices` or `milestones` `*` by id; `counterparties` `*`; `ledger_entries` through `ledger_entries_for_targets`; `decision_verdict` by `detail->>subjectId`; the payee's compliance entries (`create_counterparty`, `counterparty_address_changed`, `counterparty_address_confirmed`, `counterparty_purchase_orders_changed`, `screening_match_dismissed`, `payee_link_created`), at most 500; `payment_intents` (`status, provider, provider_mode, token, amount, destination, tx_hash, chain, destination_chain, mint_tx_hash, bridge_fee, payout_route, confirmed_at, network, provider_tx_id, provider_state, failure_reason, last_error`); `payment_receipts` `id, entry_seq, created_at, revoked_at, created_by`; the receipt's entries by `seq` and `detail->>receiptId`; `compliance_checks` `risk_level, source, screening_mode, created_at`, the newest complete one at or before the decision. Outside: the transaction's receipt from the chain's RPC (`readOnChain`), and the given links' access (`checkEvidenceLinks`, allow-list only) |
| receipt | `invoices` `id, status, direction, amount` by id; `payment_intents` `status, provider_mode, token, amount, destination, tx_hash, chain, destination_chain, mint_tx_hash, bridge_fee, payout_route, confirmed_at, network` by `source_type = invoice` and `source_id`; `ledger_entries` through `ledger_entries_for_targets` for the invoice; `payment_receipts` `id, entry_seq, created_at, revoked_at` by `invoice_id` (never `token_hash`, never `created_by`); `ledger_entries` `*` by `seq = entry_seq`, and by `detail->>receiptId` with `action` in `receipt_link_renewed`, `receipt_revoked`. Outside: `readOnChain`, only when ready |
| payee lock evidence | as `readPayeeLockEvidence` reads today: `ledger_entries` with `action` in `counterparty_address_changed`, `payee_lock_changed` in the period, a page of 1000 at a time; every entry of the counterparties they name, 100 ids at a time; `counterparties` `id, name`; the lock (`readPayeeLock`) |
| close pack | as `readClosePack` reads it (the close pack spec's table) |

Ledger kinds read, and the fields used, beyond what the evidence chain, the payee lock pack and the close pack already
read:
- `create_invoice`, `import_invoice`, `recurring_invoice_created`: `invoiceId`, `invoiceNumber`, and under
  `xero`/`quickbooks`/`zohobooks` (`invoiceNumberInDetail`).
- `ap_pay`, `approval_paid`, `ap_reconcile` (`RECORDING_ACTIONS`): `invoiceId`, and the transaction anywhere in
  `detail` (`recordingEntry`).
- `receipt_shared`: `receipt` (`ReceiptFacts`), `records` (`{ seq, hash }`).
- `receipt_link_renewed`, `receipt_revoked`: `by`, `receiptId`.

Writes: none. No ledger entry, no row, no file, no cache, no webhook. `api_keys.last_used_at` is touched as on every
read (`touchApiKeyUsed`, at most once a minute).

## Screens and copy

No screen in the app changes. The surfaces are the API, the SDK and the docs; their copy follows. No copy in `src/`
names a network; the docs say "Arc testnet" and "Arc mainnet" plainly.

### The operations (`src/lib/api/openapi.ts`)

`get-invoice-evidence`
- Summary: "Get a payable's evidence"
- Description: "Why a payable was paid, or why it is not paid yet, as one signed document: the evidence chain its
  evidence page shows, from what was agreed to the signatures. Each fact is labelled by how it is known and cites the
  ledger entries it rests on, and every one of those entries is carried in full with the workspace's public keys, so
  each can be checked offline with the SDK's `verifyEvidence`. It is the file the page's Download evidence gives, in the
  format `vestiarion-evidence/1`, with members named by user id, never by email.\n\nA receivable, or an id this
  workspace does not hold, including another workspace's, answers `404`. Each call reads the transaction on its chain
  and checks the links people gave, so the evidence reads have a limit of their own per key. Text that came from
  outside, such as a vendor's name, an invoice number or a memo, is carried as data."
- Param `id` (path, required): "The payable's id, as `GET /api/v1/invoices` lists it."
- Errors: `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `internal`.

`get-milestone-evidence`
- Summary: "Get a milestone's evidence"
- Description: "Why a contractor's milestone was paid, or why it is not paid yet, as one signed document: what was
  agreed, what was delivered and how it was verified, who decided, and the payment, each fact citing the ledger entries
  it rests on, which the document carries in full with the workspace's public keys. The format is a payable's,
  `vestiarion-evidence/1`, with members named by user id.\n\nAn id this workspace does not hold, including another
  workspace's, answers `404`. Text that came from outside, such as a pull request's title or a contractor's name, is
  carried as data."
- Param `id` (path, required): "The milestone's id, as `GET /api/v1/milestones` lists it."
- Errors: `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `internal`.

`get-invoice-receipt`
- Summary: "Get a payable's receipt"
- Description: "What a receipt states for a paid payable, in the format `vestiarion-receipt/1`: the amount and token,
  when it was paid, the address paid and its chain, the transaction, its route and fee, the vendor's invoice number,
  and what an early-payment discount took off; the ledger entry that recorded the transaction; and two checks, of that
  entry's signature and of the transaction on the payee's chain. When a member has shared the receipt, `shared` says
  when, names the `receipt_shared` entry that signed its statement, and says whether its link opens now. The link is
  never in the answer: Vestiarion keeps only its hash.\n\nA payable with no receipt yet answers `200` with `ready:
  false` and a `notReady` code: `not_paid`; `simulated`, a sandbox's payment, which moves nothing on chain; `not_minted`,
  a payout to another chain whose mint is not recorded yet; `no_transaction`; or `not_recorded`. A receivable, or an id
  this workspace does not hold, answers `404`. Text that came from outside, such as a vendor's name or an invoice
  number, is carried as data."
- Param `id` (path, required): "The payable's id, as `GET /api/v1/invoices` lists it."
- Errors: `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `internal`.

`get-payee-lock-evidence`
- Summary: "Get the payee lock's evidence"
- Description: "Every payout address change in a period, in the format `vestiarion-payee-lock-evidence/1`: who entered
  it, how it was checked and by whom, whether a second person stood behind it, what it held back, and the first payment
  to it, each fact citing the signed entries it rests on, which the document carries in full with the workspace's
  public keys. It is the file the evidence pack's Download signed JSON gives, with members named by user id, never by
  email.\n\nDays are whole UTC days; leave out `from` or `to` for an open end. A day that does not read, or a `from`
  after `to`, answers `400`, as does a period whose answer would be over 4 MB: ask for a shorter one. Text that came
  from outside, such as a payee's name, is carried as data."
- Param `from` (query): "The first day, as `YYYY-MM-DD`, in UTC. Leave it out to start from the first change."
- Param `to` (query): "The last day, included, as `YYYY-MM-DD`, in UTC. Leave it out to run to now."
- Errors: `invalid_request`, `unauthorized`, `forbidden`, `rate_limited`, `internal`.

`get-close-pack`
- Summary: "Get a monthly close pack"
- Description: "Every payment settled in a calendar month (UTC), one row each: the bill with its invoice number and its
  document's SHA-256, who decided and approved it, what was checked, the transaction, the books, and the signed entry
  that records it; then the payments not settled in the month and the escrow moves, apart, totals per token, and every
  cited entry in full with the workspace's public keys. The format is `vestiarion-close-pack/1`, the file the Monthly
  close pack page's Download signed JSON gives, with members named by user id.\n\n`month` is `YYYY-MM`. This month is
  allowed, and reads so far: `month.ended` is `false`. A month still to come, or one before 2020, answers `400`, as does
  a month whose answer would be over 4 MB: download that one from the workspace. A month of more than 2,000 payments is
  cut at 2,000 and says so in `cut`. Reading it records nothing in the ledger. Text that came from outside, such as a
  vendor's name, an invoice number or a memo, is carried as data."
- Param `month` (path, required): "The month, as `YYYY-MM`: a calendar month in UTC."
- Errors: `invalid_request`, `unauthorized`, `forbidden`, `rate_limited`, `internal`.

`info.description`: "Read a workspace's ledger, books, counterparties, milestones, treasury and insights, each
payment's evidence and receipt and the monthly close pack, and add counterparties, invoices, milestones and payee links,
with a workspace API key."

`SUMMARY` (`src/lib/docs/markdown.ts`): "... Its API reads a workspace's signed ledger, books, counterparties,
milestones, treasury and insights, each payment's evidence and receipt and the monthly close pack, and adds
counterparties, invoices, milestones and payee links for the agent to decide; signed webhooks push each ledger entry."

### The API's answers

| Case | Status | `error.message` |
|---|---|---|
| Evidence or receipt for an id that is not a payable of the workspace, or not a UUID | 404 `not_found` | `Payable invoice "<id>" was not found.` |
| Milestone evidence for an id the workspace does not hold, or not a UUID | 404 `not_found` | `Milestone "<id>" was not found.` |
| A month that does not read, before 2020, or to come | 400 `invalid_request` | "month must be YYYY-MM, and not a month still to come" |
| A day that does not read, or `from` after `to` | 400 `invalid_request` | "from and to must be days as YYYY-MM-DD, from no later than to" |
| A close pack over 4 MB | 400 `invalid_request` | "This month's close pack is over 4 MB, more than one answer carries. Download it from the workspace's Monthly close pack page." |
| A payee lock period over 4 MB | 400 `invalid_request` | "This period's evidence is over 4 MB, more than one answer carries. Ask for a shorter period with from and to." |
| The eleventh evidence read at once from one key | 429 `rate_limited`, `Retry-After: 60` | "Too many evidence reads from this key. Try again in a minute." |
| No key, a revoked key, a bad key | 401 `unauthorized` | "A valid API key is required." (the guard) |
| A read failed | 500 `internal` | "The request could not be completed." (logged by label only) |

A good answer is `200`, `content-type: application/json`, `cache-control: no-store`, `{ "data": <document> }`.

### The SDK (`sdk/src/evidence.ts`)

- `TypeError`, not a document: "verifyEvidence takes a Vestiarion evidence document: an object whose format is
  vestiarion-evidence/1, vestiarion-payee-lock-evidence/1, vestiarion-receipt/1 or vestiarion-close-pack/1."
- `TypeError`, given a whole API answer: "Pass the document itself, the answer's data, not the whole answer."
- `TypeError`, no list of entries: "The document carries no list of entries to check."
- `problems`, one sentence each:
  - "Entry #5619 does not verify: <reason>" (the reason `verifyLedgerEntry` gives);
  - "Entry #5619 could not be checked: <reason>";
  - "Entry #5601 is cited but not in the document.";
  - "Entry #5620 does not follow entry #5619: its prev_hash is not that entry's hash.";
  - "The row for payment <paymentId> names entry #5619 with another hash or signature than the entry carries.";
  - "The receipt names entry #5619 with another hash than the entry carries.";
  - with no keys given, first: "Checked with the keys the document carries. Compare their ids with the workspace's Audit
    log to tie them to the workspace."
- Method doc comments: `evidence(id)` "A payable's evidence, as its evidence page's Download evidence gives it, members
  named by user id."; `receipt(id)` "A paid payable's receipt: what it states, the entry that recorded it and its
  checks. Not ready yet: `ready` is false, and `notReady` says why."; `milestones.evidence(id)` "A milestone's
  evidence, members named by user id."; `payeeLock.evidence(params)` "Every payout address change in the period, with
  its checks and its signed entries."; `closePacks.get(month)` "The close pack of a calendar month in UTC, `YYYY-MM`:
  every payment settled in it, one row each, with its signed entry."

### The docs

`content/docs/get-started/sdk.mdx`, a new section after "## Add records":

```text
## Evidence, receipts and close packs

The workspace's signed files, read with a key: one payment's evidence, a paid bill's receipt, the payee lock's
evidence for a period, and a month's close pack.
```

```ts
import { verifyEvidence } from "@vestiarion/sdk";

const evidence = await vestiarion.invoices.evidence("7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4e51");
const receipt = await vestiarion.invoices.receipt("7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4e51");
const lock = await vestiarion.payeeLock.evidence({ from: "2026-10-01", to: "2026-10-31" });
const pack = await vestiarion.closePacks.get("2026-10");

const result = await verifyEvidence(pack, { keys: process.env.VESTIARION_LEDGER_PUBLIC_KEY! });
if (result.ok !== true) console.error(result.problems);
```

Then, in prose:
- "Each is the file the workspace's page downloads, with members named by user id rather than email. A receipt that is
  not ready yet answers with `ready: false`, and `notReady.code` says why: `simulated` never changes, `not_paid` and
  `not_minted` pass."
- "`verifyEvidence` checks any of these files offline, an API answer or a download from the workspace, with Web Crypto
  alone: every entry's signature, that every entry a fact cites is in the file, that entries next to each other link,
  and that a row's copy of its entry matches it. Pass the public key from the workspace's **Audit log** page, or a map
  of key id to key after a rotation. Without keys it uses the ones the file carries, and says so: that proves the
  entries were not changed after they were signed, not that the keys are the workspace's."
- An answer table like `verifyLedgerEntry`'s: `ok: true` "Every entry it cites is there and verifies."; `ok: false`
  "Something does not hold: `problems` says what."; `ok: null` "Nothing failed, but some entry was signed by a key you
  did not pass."
- "These five reads share a limit per key: 10 at once, then one every 6 seconds. The SDK waits out a `429` as it waits
  out any other."
- The method table gets five rows, each linking `/docs/api/<id>`.
- The version paragraph starts: "Version 0.4.0 reads a payment's evidence, a payable's receipt, the payee lock's
  evidence and a monthly close pack (`invoices.evidence`, `milestones.evidence`, `invoices.receipt`,
  `payeeLock.evidence`, `closePacks.get`), and checks any of them offline with `verifyEvidence`." The tarball URL
  becomes `https://www.vestiarion.xyz/sdk/vestiarion-sdk-0.4.0.tgz`.

`content/docs/get-started/limits.mdx`, "## Rate limits", first sentence becomes: "Reads have no rate limit, except the
evidence reads: a payment's evidence or receipt, the payee lock's evidence and a monthly close pack. Each reads and
checks many signed entries, so one key makes up to 10 of them at once, then one every 6 seconds, counted on each server
instance; over that they answer `429 rate_limited` with `Retry-After: 60`." A new "## Response size" section: "A close
pack, or the payee lock's evidence for a long period, whose answer would be over 4 MB answers `400 invalid_request`.
Download such a close pack from the workspace's Monthly close pack page, or ask for the payee lock's evidence a shorter
period at a time."

`content/docs/get-started/authentication.mdx`, "## Keeping a key safe": "A key reads the whole workspace: its invoices,
counterparties, treasury and ledger, and each payment's evidence and receipt and the monthly close pack."

`content/docs/ai-integration/mcp.mdx`, opening paragraph: "Each tool is one of the API's operations, except the evidence
reads (a payment's evidence and receipt, the payee lock's evidence and the monthly close pack), which have no tool yet."
`src/lib/docs/nav.ts`, the MCP page's description: "Connect an AI agent to your workspace's records through MCP tools:
every API read but the evidence reads, and with a read-and-write key, adding counterparties, invoices, milestones and
payee links."

## Roles and access

| What | Who |
|---|---|
| Call the five reads | Any API key of the workspace: every key has `read` (write is never issued without it) |
| Create or revoke a key | Owners and admins, in Settings, as today |
| Whose data a key reads | Its own workspace only: `withOrg(key.orgId)`, and every query through `db()` |
| Members' emails | Never through these reads (EA3); members see them on the pages and in the downloads, as today |
| Receipt links | Never: not read, not answered |
| MCP | No tool for these reads (EA9) |

A key whose creator leaves the workspace is revoked by that departure, as every key is (migration 0069). A key whose
creator's role changes keeps reading, as every read does.

## Failure and edge cases

- **An empty month, or a period with no change**: `200`, with empty `rows` or `changes`; `verifyEvidence` answers `ok:
  true` with no entries.
- **This month**: `month.ended: false`; the pack reads "so far".
- **A payable not paid yet**: its evidence reads (steps say what is missing); its receipt answers `ready: false`,
  `not_paid`.
- **A sandbox**: evidence and close pack rows are marked simulated; a receipt is `ready: false`, `simulated`.
- **A CCTP payout whose mint is not recorded**: receipt `not_minted`; the close pack's row has no hash and its note.
- **A receipt shared before receipts v2**: `facts` now states more than the signed statement; both are in the answer.
- **A revoked receipt**: `shared.linkOpen: false`, with its `receipt_revoked` entry; `facts` still answer.
- **An entry signed by a retired key**: it verifies with the retired key, which `keys` carries. With only the active
  key passed to `verifyEvidence`, it is `ok: null`, "could not be checked", never "does not verify".
- **The workspace's signing key cannot be read**: `keys` carries what can be read; entries are checked against it, and
  those no key covers are `ok: null`.
- **Members cannot be read**: evidence says "a member"; the close pack lists `members` in `unread`; the payee lock's
  read fails and answers `500 internal`, as its download does today (`readPayeeLockEvidence` does not catch
  `listMembers`). This item does not change that.
- **Arc's RPC is slow or down**: the evidence read's on-chain check and the receipt's `onChain` are `unreadable` after
  4 seconds; the rest answers.
- **A screening read fails in the close pack**: those rows say so (`unread`), the rest answers.
- **Before 0136**: the close pack's pay-to check reads "Does not apply" (`readDocumentPayTo` on `42703`, `PGRST204`); the
  API answers `200`.
- **A month of more than 2,000 payments**: `cut: true`; over 4 MB, `400` (EA7).
- **Two keys, or two instances**: each has its own bucket; nothing is cached, so no answer reaches another key.
- **An id with URL-significant characters**: the SDK encodes it; the route reads it as the id, finds no UUID and
  answers `404` without a query.
- **An unknown query parameter** (for example `format=csv`): ignored, as every v1 read ignores one it does not take.
- **The SDK's 30-second timeout**: a close pack read that takes longer is retried by the SDK, and each retry spends a
  token, so a loop cannot multiply the load past the brake.

## Security and privacy

- **Authentication and tenancy.** The guard is the one every v1 read passes (pinned by `tests/access-gates.test.ts`).
  Each read runs inside `withOrg(key.orgId)` and queries through `db()`, so row-level security confines it even if a
  filter were wrong. Another workspace's id answers the same `404` as an unknown one.
- **What a key sees.** Nothing a read key does not already reach: the entries are in `GET /api/v1/ledger`, the payees
  in `GET /api/v1/counterparties`, screenings in `GET /api/v1/counterparties/{id}`. The documents put them together, and
  name members by id only. A payee lock confirmation's `contact` (how the address was checked) is the one a signed
  `counterparty_address_confirmed` entry already carries.
- **Receipt links.** A receipt's token works as a credential for its public page; it is shown once and only its hash is
  kept. This read never selects `token_hash` and never answers a link. A test holds both.
- **Prompt injection.** No model is called. Every outside string is carried as JSON data (EA16); each operation says so.
  MCP, where a model would read these documents directly, waits for D16 (EA9).
- **Untrusted files.** None is opened, read or served; a document is named by its SHA-256.
- **Links.** Only explorer links from the chain profiles and evidence page paths; a given link keeps `given: true` and
  its check's state.
- **Keys.** Public keys only (`exportKeys`). The SDK's verifier counts a key only under its true id, so a document
  cannot vouch for a key by labelling it.
- **Load.** The brake (EA6) and the 4 MB cap (EA7) bound what one key costs; the link checks keep their own allow-list
  and timeouts.
- **Logs.** A failure is logged by its label (`GET /api/v1/close-packs/{month}`), never the key or the body.
- **Privacy, security and terms pages.** No new data is collected, no new processor, no new storage, no public route: a
  key already "reaches its data" (privacy page). The privacy and terms pages do not change, and their pinned dates stay
  (privacy 2026-10-23, terms 2026-10-16, `SUBPROCESSORS_AS_OF` 2026-10-23). The security page changes after all (found
  in review): its limits list said API reads are not limited, so it now names the evidence reads' limit, in the limits
  list and the API section, and its date moves to 2026-10-25.

## No migration

No table, column, function or bucket is added. Every column read was there before 0136, except the close pack's
`invoices.document_pay_to` (0136), which `readDocumentPayTo` reads and answers "none" on `42703` and `PGRST204`. The
receipt read uses `payment_receipts` (0046) and `payment_intents` columns up to `network` (0075). The next free number
stays 0144 (Exception resolution part 2), then 0145 (Google Sheets).

## Not in this change

- MCP tools for these reads, the tool count, `server.json` and the MCP Registry (D16, EA9).
- CLI commands, and moving the CLI's SDK range (after 0.4.0 is on npm, EA14).
- Paging a large close pack or payee lock period (EA7).
- A CSV through the API (EA2).
- Members' emails through the API, and a members endpoint (EA3).
- A receipt for a milestone, and sharing a receipt through the API: sharing makes a link, which is a write.
- A read of the payee lock's setting itself (D16).
- Recording API reads in the ledger (EA8).
- Any app screen.

## Tests (write these first)

`tests/api-evidence-routes.test.ts` (new; `tests/support/fake-supabase`, `@/lib/platform/api-keys` mocked as in
`tests/openapi.test.ts`, `next/server`'s `after` a no-op, `readOnChain` and `checkEvidenceLinks` mocked)
- EA1, EA2: `GET /api/v1/invoices/{id}/evidence` for a payable of the key's workspace answers `200`, `cache-control:
  no-store`, and `data` equals `evidenceDocument` built from the same rows with members by id; `format` is
  `vestiarion-evidence/1`.
- EA3: no member's email from the members read appears anywhere in the body; an approval's `who` is the approver's user
  id; a member who left reads "a former member".
- EA5: a receivable answers `404` with `Payable invoice "<id>" was not found.`; `not-a-uuid` answers the same `404` and
  sends no request to `/rest/v1/invoices`; every request carries the key's org and never another's.
- `GET /api/v1/milestones/{id}/evidence`: `200` for a milestone of the workspace; `404` with `Milestone "<id>" was not
  found.` for an unknown one.
- EA6, `takeApiEvidenceToken`: ten at once, the eleventh refused, one more 6 seconds later, two keys apart.
- EA6, the routes: ten reads across the five operations answer, the eleventh answers `429` with `Retry-After: 60` and
  "Too many evidence reads from this key. Try again in a minute."; another key still reads; a `400` month and a
  malformed id take no token.
- EA8: across every case, no request is a `POST`, `PATCH` or `DELETE`, and none is `rpc/append_ledger_entry`.

`tests/api-receipt.test.ts` (new)
- EA4: a paid live payable with a shared receipt answers `ready: true`; `facts` equal `buildReceipt`'s; `records`;
  `invoiceEntry`; `shared` `{ at, entry, linkOpen: true, changes: [] }`; `checks.recorded` `{ ok: true }`;
  `checks.onChain` as the mocked `readOnChain` answered; `entries` are `create_invoice`, the recording entry and
  `receipt_shared`, oldest first, each with its check.
- A revoked receipt: `linkOpen: false`, and its `receipt_revoked` entry is in `shared.changes` and `entries`; a renewed
  link's `receipt_link_renewed` too.
- Never shared: `shared: null`.
- Not ready, one case per code: unpaid (`not_paid`), simulated (`simulated`), CCTP with no mint (`not_minted`), a hash
  that is not 32 bytes (`no_transaction`), no recording entry (`not_recorded`): `facts`, `records` and `checks` are
  `null`, `notReady.reason` is the builder's sentence, and `readOnChain` is never called.
- The `payment_receipts` select never names `token_hash`, and the body holds no `token`.
- A receivable and an unknown id answer `404`.

`tests/receipt-document.test.ts` (new, pure)
- `receiptNotReady` maps each of `RECEIPT_REFUSALS`' sentences to its code, and `buildReceipt`'s and `intentFacts`'
  refusals still read the same sentences as before.
- `receiptDocument`: format, network label from the profile, `checkAnEntry` equal to `[...CHECK_AN_ENTRY]`, keys passed
  through, entries sorted by `seq`, `shared` built from the row and the change entries, `notReady` only when not ready;
  the document survives a JSON round trip unchanged.

`tests/receipt-document-read.test.ts` (new)
- reads the invoice, its intent, its entries through `ledger_entries_for_targets`, the receipt row and its entries, in
  the workspace's scope; checks each entry with the active and the retired key; returns null for a receivable or an
  unknown id; writes nothing.

`tests/api-close-pack.test.ts` (new)
- `200`, and `data` equals `closePackDocument(readClosePack({ month, people: "id" }), { origin })`; `format`
  `vestiarion-close-pack/1`; this month has `month.ended: false`; every member's `email` is `null`; no email in the body.
- `2026-13`, `202610`, `2019-12` and next month answer `400` with "month must be YYYY-MM, and not a month still to come",
  before any tenant request.
- EA7: with `readClosePack` mocked to a pack whose answer is over 4,000,000 bytes, `400` with the close pack's message;
  just under it, `200`.
- before 0136: a `42703` on `document_pay_to` still answers `200`, with the pay-to check "Does not apply".
- no `close_pack_exported`, and no write of any kind.

`tests/api-payee-lock-evidence.test.ts` (new)
- `200` for a period, for open ends, and for none; `2026-10-32` and a `from` after `to` answer `400` with the period's
  message, before any tenant request.
- a member is `{ kind: "member", userId, email: null }`; a former member keeps its 8 characters.
- EA7: over 4 MB, `400` with the period's message.

Existing tests to extend:
- `tests/evidence-read.test.ts`: with `people: "id"`, every fact names a member by user id and a former member as "a
  former member"; without it, by email, unchanged.
- `tests/payee-lock-evidence.test.ts`: a member carries `userId` and `email`; with `people: "id"`, `email` is `null`; a
  lock change whose `from` is not a lock reads `null`.
- `tests/payee-lock-evidence-report.test.tsx`: the CSV names a member by email, and by user id when there is none.
- `tests/close-pack-export.test.ts`: `checkAnEntry` is a plain array equal to `[...CHECK_AN_ENTRY]`.
- `tests/api-schemas.test.ts`: `toEqualTypeOf` for `PaymentEvidenceSchema` / `EvidenceDocument`,
  `PayeeLockEvidenceSchema` / `PayeeLockEvidence`, `PaymentReceiptSchema` / `ReceiptDocument`, `ClosePackSchema` /
  `ClosePackDocument`, `SignedEntrySchema` / `SignedEntry`; the five examples parse and round-trip (its `it.each`).
- `tests/openapi.test.ts`: the inline snapshot of ids gains the five, last; `ROUTES` gains the five, each with a fixture
  of its own (UUID ids, a payable, a milestone, a confirmed simulated intent, a receipt row, signed entries), since the
  null-row fixture's ids are not UUIDs; the empty-workspace case skips the three record reads, which answer `404`; a new
  case: the five carry `mcp: false`, and no other operation does.
- `tests/api-key-scope.test.ts`: `ROUTES` gains the five route files, `ok` `404` for the three record reads in an empty
  workspace and `200` for the other two.
- `tests/access-gates.test.ts`:
  - `NO_MCP_TOOL_YET`, the five route files; the MCP walk's `keyed` leaves them out;
  - the list equals the route files of the operations with `mcp: false`;
  - each of the five handlers calls `takeApiEvidenceToken(guard.key.keyId)` after the guard and before
    `handleApiRequest(`;
  - the public `openapi.json` walk still reaches no module that loads tenant data (unchanged test, now with the new
    schemas in it).
- `tests/mcp-tools.test.ts`: "has one tool per operation that has one, in the same order"; the five have none; every
  other loop over `OPERATIONS` in the file (annotations, titles, input schemas, examples) runs over the operations that
  have a tool. The MCP docs' tool table and the `.md` view are built from `MCP_TOOLS`, so they leave the five out on
  their own.
- `tests/mcp-call.test.ts`: the GET loop runs the operations that have a tool; `callOperation("get-close-pack", ...)`
  answers "No such operation.".
- `tests/mcp-route.test.ts`: unchanged; still thirteen tools.
- `tests/postman.test.ts`: unchanged, green after `npm run postman:build`: an Evidence folder, every 429 with
  `Retry-After: 60`, every message found in the source.
- `tests/sdk-client.test.ts`: `CALLS` gains the five; the path check replaces any `{param}`; `payeeLock.evidence({ from:
  "2026-10-01", to: "2026-10-31" })` sends `?from=2026-10-01&to=2026-10-31`; `closePacks.get("2026-10")` sends
  `/api/v1/close-packs/2026-10`; `invoices.evidence("a/b")` sends `a%2Fb`.
- `tests/sdk-contract.test.ts`: `ROUTES` and `routeFetch` gain the five; the SDK reads a payable's evidence and an empty
  month's close pack through the routes; the eleventh read throws a `VestiarionError` `rate_limited` with `retryAfter`
  60 (`maxRetries: 0`).
- `tests/sdk-types.test.ts`, `tests/sdk-package.test.ts`, `tests/sdk-docs.test.ts`, `tests/readme-facts.test.ts`: green
  after the bump, the types and the pack.
- `tests/cli-package.test.ts`, `tests/cli.test.ts` and `npm run check:lock`: green with no change. This is the proof that
  the CLI stays on 0.3.2.

`tests/sdk-evidence.test.ts` (new; imports `../sdk/src/index`)
- every committed example of the five verifies `ok: true` with its own keys (`keys: "document"`, and the note first in
  `problems`), and with those keys given (`keys: "given"`, no problems);
- for the same entries, each `check` equals the server's `verifyEntry` with the same keys;
- a changed `summary` in one entry: `ok: false`, "Entry #N does not verify: The entry's content does not match its body
  hash.";
- a cited entry removed: `ok: false`, "Entry #N is cited but not in the document.";
- two consecutive entries whose link is broken: `ok: false`, "Entry #N does not follow entry #M ...";
- a close pack row whose `record.signature` differs, and a receipt whose `records.hash` differs: each its sentence;
- keys that did not sign: `ok: null`, each entry "could not be checked"; a key filed under a wrong id is not used;
- an empty month: `ok: true`, no entries;
- an unknown format, a non-object and a whole `{ data }` answer: each throws its `TypeError`;
- a session download (members by email) verifies the same as the API's answer.

## Docs and lists to update

- `CHANGELOG.md`, `[Unreleased]` > `### Added`:
  "- **Evidence, receipts and the close pack through the API.** A bookkeeping system, an auditor's tooling or the
  business's own code reads with a workspace API key what the workspace's pages download: one payment's evidence
  (`GET /api/v1/invoices/{id}/evidence`, `GET /api/v1/milestones/{id}/evidence`), a paid bill's receipt with its two
  checks (`GET /api/v1/invoices/{id}/receipt`), the payee lock's evidence for a period (`GET
  /api/v1/payee-lock/evidence`) and a month's close pack (`GET /api/v1/close-packs/{month}`), each the same signed file,
  with members named by user id rather than email. A key makes up to 10 of these reads at once, then one every 6
  seconds, and reading records nothing in the ledger. The TypeScript SDK 0.4.0 has a method for each, and
  `verifyEvidence`, which checks any of these files offline, a download from the workspace included, with Web Crypto
  alone. The payee lock's evidence file now names each member's user id beside their email. The MCP server does not
  offer these reads yet. No migration."
- `content/docs/changelog.mdx`, newest first, "## 2026-10-25: Evidence, receipts and the close pack":
  - "**`GET /api/v1/invoices/{id}/evidence`** and **`GET /api/v1/milestones/{id}/evidence`** answer `{ data }` with
    one payable's or milestone's evidence, `vestiarion-evidence/1`: `subject`, `labels`, `steps` with their `facts`
    (each citing `entries` by `seq`), `signedEntryProves`, `checkAnEntry`, `keys`, and every cited entry in full
    (`body_hash`, `signature`, `prev_hash`, `hash`, `signing_key_id`, `check`). A fact's `who` is a user id. A
    receivable, or an id the workspace does not hold, answers `404`."
  - "**`GET /api/v1/invoices/{id}/receipt`** answers `vestiarion-receipt/1`: `ready`; `notReady` (`code` `not_paid`,
    `simulated`, `not_minted`, `no_transaction` or `not_recorded`, and `reason`); `facts` as a shared receipt states
    them; `records` (`seq`, `hash`); `invoiceEntry`; `shared` (`at`, `entry`, `linkOpen`, `changes`); `checks`
    (`recorded`, `onChain`); `keys` and `entries`. It never carries a receipt's link or its hash."
  - "**`GET /api/v1/payee-lock/evidence`** takes `from` and `to` (`YYYY-MM-DD`, either left out for an open end) and
    answers `vestiarion-payee-lock-evidence/1`. A member is `{ kind: "member", userId, email: null }`; the file
    downloaded from the workspace now carries `userId` beside `email`."
  - "**`GET /api/v1/close-packs/{month}`** answers `vestiarion-close-pack/1` for `month` as `YYYY-MM`, with every
    member's `email` `null`."
  - "The five share a limit per key: 10 at once, then one every 6 seconds; over it they answer `429 rate_limited` with
    `Retry-After: 60`. A close pack or a payee lock period whose answer would be over 4 MB answers `400
    invalid_request`. Every other read stays unlimited. None of the five writes a ledger entry or sends a webhook, and
    none is an MCP tool yet."
  - "The TypeScript SDK 0.4.0 adds `invoices.evidence`, `milestones.evidence`, `invoices.receipt`,
    `payeeLock.evidence`, `closePacks.get` and `verifyEvidence`, with the types `PaymentEvidence`, `PaymentReceipt`,
    `PayeeLockEvidence` and `ClosePack`. Nothing else in `/api/v1` or the webhooks changes."
- `ARCHITECTURE.md`:
  - "## API": five lines in the route tree (`invoices/[id]/evidence/route.ts`, `invoices/[id]/receipt/route.ts`,
    `milestones/[id]/evidence/route.ts`, `payee-lock/evidence/route.ts`, `close-packs/[month]/route.ts`), and a
    paragraph: the evidence reads serve the session downloads' documents with `people: "id"`; `src/lib/api/evidence.ts`
    (`documentAnswer`, `no-store`, the 4 MB cap, `workspaceInScope`); `takeApiEvidenceToken`; they write nothing; their
    operations carry `mcp: false`, and `NO_MCP_TOOL_YET` in `tests/access-gates.test.ts` names their routes.
  - "## Developer docs": `verifyEvidence` (`sdk/src/evidence.ts`) and `tests/sdk-evidence.test.ts`; the five examples are
    built by `scripts/evidence-examples.ts` from a made-up workspace signed with a key made for the run, not recorded.
  - "## Why it was paid: the evidence chain", the payee lock's "Evidence pack" bullet, the shared receipt bullet and "##
    The monthly close pack": one sentence each naming its v1 route.
- `content/docs/get-started/sdk.mdx`, `content/docs/get-started/limits.mdx`, `content/docs/get-started/authentication.mdx`,
  `content/docs/ai-integration/mcp.mdx`, `src/lib/docs/nav.ts`: as "The docs" above.
- `sdk/README.md`: the tarball URL (0.4.0); in "## Read", the five methods; a short "## Check evidence offline" with the
  `verifyEvidence` example.
- `README.md`:
  - the npm badge `v0.4.0`;
  - the **REST API** row: "read everything, each payment's evidence and receipt and the monthly close pack included,
    and with write access add counterparties, invoices, milestones and payee links. A key never approves or pays";
  - the **TypeScript SDK** row: "a typed client for every `/api/v1` operation, plus webhook and ledger verification, and
    offline checks of evidence, receipts and close packs";
  - the **CLI** row: "the `vestiarion` command for every `/api/v1` operation but the evidence reads, ...";
  - the **MCP server** row: "`/api/mcp`, whose tools are the `/api/v1` operations but the evidence reads, ...".
- Guides (each keeps "Arc testnet" and gains no disclaimer; no new quoted UI string, so no new `tests/docs-guides.test.ts`
  rows):
  - `content/docs/guides/evidence.mdx`, "## Download evidence", a closing paragraph: "An integration reads the same file
    with a workspace API key, from `GET /api/v1/invoices/{id}/evidence` or `GET /api/v1/milestones/{id}/evidence`, with
    members named by user id rather than email. See [Get a payable's evidence](/docs/api/get-invoice-evidence)."
  - `content/docs/guides/evidence-and-receipts.mdx`: in "## 6. Check the signed JSON offline", step 3 adds: "Or run the
    whole file through the SDK's `verifyEvidence`, which takes it as it is."; in "## 7. Share a receipt", a closing
    sentence: "An integration reads a paid bill's receipt, shared or not, from `GET /api/v1/invoices/{id}/receipt`; it
    never gets the link."
  - `content/docs/guides/accountants.mdx`, "### The monthly close pack", the offline check: "the SDK's
    `verifyEvidence` takes the file as it is"; and: "A bookkeeping system reads the same pack with a workspace API key
    from `GET /api/v1/close-packs/{month}`, with members named by user id."
- Generated, run and commit: `sdk/src/types.ts` (`npm run sdk:types`), `public/postman/*` (`npm run postman:build`),
  `public/sdk/vestiarion-sdk-0.4.0.tgz` (`npm run sdk:pack`), `content/docs/examples/{get-invoice-evidence,
  get-milestone-evidence,get-invoice-receipt,get-payee-lock-evidence,get-close-pack}.json` (`npx tsx
  scripts/evidence-examples.ts`).
- Grep for stale text: "every API read", "every `/api/v1` operation", "Reads have no rate limit", "are not limited",
  "tools are the", "One tool per", "0.3.7" (only the changelogs and the version history keep it).
- MDX trap: no quote and then `#5619` on the same line (`tests/ui-consistency.test.ts` reads it as a colour); write
  "entry 5619" in prose.
- No change to the privacy or terms pages or their dates, `SUBPROCESSORS`, the CSP, `.env.example`,
  `server.json`, `MCP_SERVER_VERSION`, `cli/`, the root `package.json` or `package-lock.json`. No screenshot.

## Implementation order (one PR, TDD)

Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` first (AGENTS.md): `params` is a
Promise; keep `export const dynamic = "force-dynamic"`; do not turn on `cacheComponents`.

1. Commit this spec as `docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md`: "Add the
   design for evidence, receipts and the close pack in the API and SDK 0.4".
2. Types without behaviour: `SignedEntry` and `EvidenceDocument` (evidence-export), `PayeeLockEvidence` and the new
   `Who` (payee-lock-evidence, report words), `ClosePackEntry = SignedEntry` and `checkAnEntry: string[]` (close pack).
   Extend their tests; run `tests/evidence-*.test.ts`, `tests/payee-lock-evidence*.test.ts*`, `tests/close-pack-*.test.ts`.
3. `people: "id"` in `readEvidence` and `readPayeeLockEvidence`, test first.
4. `tests/receipt-document.test.ts`, then `RECEIPT_REFUSALS` / `receiptNotReady` (facts.ts) and `receiptDocument`;
   `tests/receipt-document-read.test.ts`, then `readReceiptDocument`.
5. The Zod schemas (EA10) and their `toEqualTypeOf` lines in `tests/api-schemas.test.ts`, before any operation uses
   them.
6. `scripts/evidence-examples.ts`; run it; commit the five examples. They must exist before `openapi.ts` imports them.
7. `takeApiEvidenceToken` and `src/lib/api/evidence.ts`, then the five route tests, then the five routes.
8. The five `OPERATIONS` entries (`tag: "Evidence"`, `mcp: false`), `MCP_TOOLS`' filter, `NO_MCP_TOOL_YET`, and the
   existing tests above (openapi, api-key-scope, access-gates, mcp-tools, mcp-call). `scripts/lib/postman.ts`'s messages,
   then `npm run postman:build`.
9. `sdk/src/evidence.ts` with `tests/sdk-evidence.test.ts`; the client's methods with `tests/sdk-client.test.ts` and
   `tests/sdk-contract.test.ts`; the `NAMED` rows; `npm run sdk:types`.
10. The bump: `sdk/package.json` and `sdk/src/version.ts` to 0.4.0, `sdk/README.md`, `content/docs/get-started/sdk.mdx`,
    the README badge; then `npm run sdk:pack` once, last, after every SDK source and README change; commit the tarball.
    Do not touch `cli/`, the root `package.json` or `package-lock.json`, and run no `npm install`.
11. The docs: CHANGELOG, changelog.mdx, ARCHITECTURE, limits, authentication, MCP page and nav, guides, README rows.
    Grep for stale text, and for local paths, before the PR.
12. `npm run verify`, then `npm run build` (new routes and reference pages). Rerun `tests/ui-consistency.test.ts`,
    `tests/security-page.test.tsx` and `tests/cli-package.test.ts` alone if one times out in the full run.
13. Commits: "Read evidence, receipts and the close pack with an API key", "Check evidence offline in SDK 0.4.0",
    "Document evidence, receipts and the close pack in the API". Then the PR, whose body names no local path.

## How to prove it on prod

On pinecrest-studio, live on Arc testnet, after the merge deploys. The partner makes the key and keeps it in their own
terminal; it is never pasted into a chat, a file in the repo or a PR.

1. Reload any open app tab (skew protection pins old tabs to the old deployment).
2. The partner creates a read-only key on pinecrest-studio, **Settings**, API keys, named "Evidence API check", and in
   their PowerShell terminal: `$env:VESTIARION_API_KEY = "<the key>"`.
3. `curl.exe -s https://www.vestiarion.xyz/api/v1/openapi.json -o openapi.json`: it lists the five operations under the
   tag "Evidence"; `/docs/api/get-close-pack` renders with its example.
4. The close pack: `curl.exe -s -H "Authorization: Bearer $env:VESTIARION_API_KEY" -o close-pack.json
   https://www.vestiarion.xyz/api/v1/close-packs/2026-10`.
   - `data.format` is `vestiarion-close-pack/1`, `data.month.ended` is `false` until November 1;
   - `data.totals.onChain` matches **Payments settled** and **Paid** on `/o/pinecrest-studio/evidence/close-pack?month=2026-10`;
   - the partner's own sign-in email does not appear in the file (`Select-String -Path close-pack.json -Pattern
     "<your email>"` finds nothing), and approvers are user ids.
5. Offline check, in an empty folder outside the repo:
   `npm install --prefix vx-check https://www.vestiarion.xyz/sdk/vestiarion-sdk-0.4.0.tgz`, then a `check.mjs` that
   reads a file's `data`, and the PEM from the **Audit log** page's "Ledger signing public key" saved as
   `ledger-key.pem`, and prints `(await verifyEvidence(data, { keys })).ok`, `counts` and `problems`.
   - With no key passed: `ok` true, `keys` "document"; the ids in `data.keys` match the Audit log's.
   - With `ledger-key.pem`: `ok` true, or `null` only for entries signed before the key rotation (#67), each "could not
     be checked", never "does not verify".
6. A payable's evidence: the payment co-signed live on Oct 23 (`/api/v1/invoices/<its id>/evidence`). Its steps match
   its evidence page fact for fact, the co-sign and the approval name user ids, and `verifyEvidence` passes.
7. A milestone's evidence: a released milestone of pinecrest; the same checks.
8. A receipt: a paid bill whose receipt is shared. `ready` true; `shared.entry` is its `receipt_shared` entry on the
   Audit log; `checks.onChain.state` is "matches"; `facts.txHash` opens on explorer.testnet.arc.io with the same amount.
   A bill not paid yet answers `ready` false with `notReady.code` "not_paid".
9. The payee lock: `/api/v1/payee-lock/evidence?from=2026-10-01&to=2026-10-25`; `data.summary` matches the payee lock
   evidence page's summary for the same days.
10. The brake: twelve quick reads,
    `1..12 | ForEach-Object { curl.exe -s -o NUL -w "%{http_code} " -H "Authorization: Bearer $env:VESTIARION_API_KEY" https://www.vestiarion.xyz/api/v1/close-packs/2026-09 }`:
    `200`s, then `429` (another instance may let one or two more through).
11. Refusals: `/api/v1/close-packs/2026-13` answers `400`; an invoice id from another workspace the partner owns answers
    `404`.
12. Nothing was written: the Audit log shows no entry from these reads, and the key's **Last used** moved.
13. MCP still lists thirteen tools; the Postman reference collection, imported again, has an "Evidence" folder.
14. The partner revokes the key. After publishing 0.4.0 to npm, `npm view @vestiarion/sdk version` answers `0.4.0`.
