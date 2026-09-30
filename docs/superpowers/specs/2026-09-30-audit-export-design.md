# Audit export: take the signed ledger away and check it without us

The Audit page says every decision is hash-linked and signed, and a member can press Verify. That check still runs on Vestiarion's servers with Vestiarion's code, so "check it instead of trusting us" only goes as far as the button. An auditor, an accountant or a counterparty in a dispute needs the chain as a file, and a way to check it that does not involve us.

This design adds an **audit export**: one workspace's ledger as a download (JSON to verify, CSV for spreadsheets) and a standalone verifier that checks the JSON file with nothing but Node.js. It is the last item of Tier 3 (identity-and-tenancy spec §11).

It was decided on 2026-09-30 by the implementer under the partner's standing instruction.

## 1. What this builds

- **`GET /api/ledger/export?org=<slug>&format=json|csv`**, for any member of the workspace. It has the same session check as `/api/ledger/verify`: 401 when signed out, and 404 when not a member, so it never says whether a slug exists. It answers with an attachment named `vestiarion-<slug>-ledger-<headSeq>.<ext>`.
- **The JSON export** (`format: "vestiarion-ledger-export/1"`):
  - `exportedAt`, and `workspace` with `slug` and `name`;
  - `head` with `seq` and `hash`: the last entry in the file;
  - `keys`: every public key the workspace accepts, as `{ id, status: "active" | "retired", publicKeyPem }`;
  - `verification`: what the server's own `verifyChain` said about exactly these entries;
  - `entries`: every entry oldest first, with the fields the chain is built from (`seq, id, ts, actor, domain, action, summary, detail, body_hash, signature, prev_hash, hash, signing_key_id`), unchanged.
- **The CSV export**: one row per entry, oldest first, with the same columns. `detail` is written as canonical JSON. A cell that begins with a tab or a carriage return, or whose first character after any leading whitespace (including a BOM) is `=`, `+`, `-` or `@`, is prefixed with `'` — the prefix goes at the very start of the cell, the leading whitespace itself is kept — because summaries carry names people typed, a spreadsheet would run such a cell as a formula, and some spreadsheet imports trim leading whitespace before making that judgment. The CSV is for reading; the JSON is what verifies.
- **The standalone verifier `verify-ledger-export.mjs`**, served at `/tools/verify-ledger-export.mjs` and linked from the docs. It has no dependencies beyond `node:crypto` and `node:fs`. `node verify-ledger-export.mjs export.json` recomputes, for every entry, the body hash from canonical JSON, the Ed25519 signature against the named key, and the hash link. It prints one verdict line and exits 0 (valid), 1 (broken, naming the entry and why) or 2 (it could not check: an unknown key id, or a file it cannot read).
  - It prints the key ids it trusted and the head hash, and says to compare both with the Audit page.
  - It checks the file against itself, so anyone who can rewrite the file can also rewrite its keys. The comparison is what closes that gap. With `--public-key key.pem`, only the key(s) named this way are trusted; the flag may be repeated, and a file may hold more than one PEM block, so a chain spanning a key rotation can be checked with every key it was ever signed by.
- **The Audit page** gains a "Download" control with "Signed JSON" and "CSV". Next to the public key, the page now says where the key id and head hash are used: in a check of an export.
- **The export is recorded.** After the file is built, `system/ledger_exported` is appended with `{ by, format, entries, headSeq }`: who took the ledger away is itself part of the ledger. The recorded head is the head in the file; entries appended meanwhile, by a cycle or another export, come after it.
- **A guide, "Verify an audit export"** (`/docs/guides/audit-export`): what the file holds, how to run the verifier, what each result means, and what the comparison with the Audit page is for. Its quoted UI strings are pinned by the existing guides test.

## 2. Decisions

- **E1. One verifier implementation, twice.** The app's `verifyChain` stays the source of truth. The standalone script is a second implementation of the same rules, which is the point: a verifier we ship inside the app proves nothing to someone who does not trust the app. A test runs the script against exports built from the test suite's own ledgers, intact and tampered in each way `verifyChain` detects, and asserts that both give the same verdict. Drift between the two then fails CI instead of an audit.
- **E2. Trust anchors are the key id and the head hash.** A file cannot prove its own authenticity. The verifier makes the two facts to compare prominent. Both are already on the Audit page: the head hash has a copy button, and the key id is shown beside the public key. `GET /api/v1/ledger` also returns `signingKeyId`.
- **E3. Paged reads.** PostgREST returns at most the project's `max_rows` (1,000 on Supabase) per request. `verifyLedger()` reads the whole chain in one request today, so a chain past 1,000 entries would silently verify only its first page. A new `readLedgerRows()` reads by `seq` in pages of 1,000 until a page comes back short. Both `verifyLedger()` and the export use it.
- **E4. Built, then sent.** The rows are read and verified in memory. The response body is then streamed in chunks of entries, so a long chain is never serialized into one string. Memory is bounded by the rows themselves: tens of thousands of entries fit comfortably.
- **E5. Every member may export.** Viewers already see every entry on the Audit page, so the export shows nothing new to them, and an auditor is typically invited as a viewer. The `ledger_exported` entry is the control.
- **E6. The recording is best effort.** If the append fails, the download still succeeds and the failure is logged. A person who is entitled to the ledger should not be refused it because an audit note could not be written.
- **E7. No `/api/v1` change.** Integrators can already page `GET /api/v1/ledger`. This export is the person-facing, session-authenticated file, so there is no changelog entry.
- **E8. A brake on exports.** At most 5 exports per person per workspace in 10 minutes, counted from the ledger's own `ledger_exported` entries, so the limit holds across instances. Every export appends that entry, and every append fans out a `ledger.appended` webhook delivery to every endpoint (migration 0028); without a shared brake, a member looping on the download would grow the ledger without bound and flood integrators. `src/lib/rate-limit.ts` is in-memory per instance, so it is no brake on serverless — the count has to come from a store every instance shares, and the ledger already is one.

## 3. Components

```
src/lib/ledger.ts                         readLedgerRows(); verifyLedger() uses it
src/lib/ledger-export.ts                  buildLedgerExport(), ledgerExportCsv(), csvCell(), exportFileName()
src/app/api/ledger/export/route.ts        GET: session, membership, build, stream, record
public/tools/verify-ledger-export.mjs     the standalone verifier
src/components/AuditExportMenu.tsx        the Download control on the Audit page
content/docs/guides/audit-export.mdx      the guide (and its nav entry)
```

## 4. Testing

- **`readLedgerRows`:** it pages by `seq` until a short page, and `verifyLedger()` checks every page.
- **`buildLedgerExport`:**
  - the entries come oldest first with every chain field;
  - the keys include the active and retired ones with ids;
  - the head is the last entry;
  - the verification matches `verifyChain`.
- **CSV:** the header; canonical `detail`; quotes and commas and newlines escaped; the formula prefix on each dangerous first character.
- **The route:**
  - 401 when signed out, and 404 for a non-member;
  - a JSON or CSV attachment with the right filename;
  - an unknown format answers 400;
  - `ledger_exported` is recorded with counts only;
  - a failed recording still answers 200.
- **The standalone verifier (E1):** it runs as a child process on a real export built by `buildLedgerExport` over rows signed in the test. It must answer:
  - exit 0 when intact;
  - exit 1 for each tamper: detail changed, signature swapped, entry removed, entry reordered;
  - exit 2 for an unknown key id;
  - exit 1 when `--public-key` names a different key;
  - and in every case the same verdict as `verifyChain` on the same rows.
- **UI and docs:** the Download control renders for every role; the guide's quoted strings are pinned.

## 5. Rollout

No migration. Merge on green, then in production:

1. Download both formats from a workspace.
2. Run the downloaded verifier on the JSON and compare its key id and head hash with the Audit page.
3. Change one byte of `detail` in a copy of the file and check that the verifier answers 1 with that entry's seq.
4. Check that `ledger_exported` appears on the Audit page.

Then record the result in this spec.

## 6. Out of scope

- Exporting one domain or a date range: the chain is only verifiable whole, from genesis.
- Exporting other tables (invoices, payments). The ledger is the evidence, and the rows are what it describes.
- PDF reports.
- A verifier in other languages. The format is documented, so one can be written from the guide.
