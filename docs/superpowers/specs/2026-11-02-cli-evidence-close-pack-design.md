# CLI 0.2: export and verify evidence and close packs (2026-11-02)

Status: building on branch `feat/cli-evidence`. No migration, no change to `/api/v1`.

Plan item of Nov 2 (`docs/gtm/23-plan-den-30-11.md`): "CLI `vestiarion evidence export` and `vestiarion close-pack
verify`". The SDK spec's EA14 (`2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md`) left this for after SDK 0.4
was on npm: move the CLI's range to `^0.4`, then add the commands. SDK 0.4.1 is on npm, and its tarball is committed.

## Why

The five evidence reads (EA1) and `verifyEvidence` (EA13) exist, but only for code. The people who ask for these files are
an accountant closing a month, an auditor sampling payments and an insurer's broker. They often run one command, not a
program. Today they have to write one, or download each file from the workspace by hand.

With the CLI they can:
- save a payment's evidence, its receipt, the payee lock's evidence or a month's close pack, with one command and a key;
- check any of those files offline, as `vestiarion ledger verify` checks an audit export;
- script a month-end: export the close pack, verify it, file it.

## Rules

Code comments and test names cite the ids, for example "(CLI evidence CE3)".

**CE1. Four commands.**

| Command | Calls | Writes |
|---|---|---|
| `vestiarion evidence export --bill <id>` | `GET /api/v1/invoices/{id}/evidence` | `vestiarion-evidence/1` |
| `vestiarion evidence export --milestone <id>` | `GET /api/v1/milestones/{id}/evidence` | `vestiarion-evidence/1` |
| `vestiarion evidence export --receipt <bill-id>` | `GET /api/v1/invoices/{id}/receipt` | `vestiarion-receipt/1` |
| `vestiarion evidence export --payee-lock [--from <day>] [--to <day>]` | `GET /api/v1/payee-lock/evidence` | `vestiarion-payee-lock-evidence/1` |
| `vestiarion evidence verify <file>` | nothing: offline | nothing |
| `vestiarion close-pack export <YYYY-MM>` | `GET /api/v1/close-packs/{month}` | `vestiarion-close-pack/1` |
| `vestiarion close-pack verify <file>` | nothing: offline | nothing |

- `evidence export` takes exactly one of `--bill`, `--milestone`, `--receipt` and `--payee-lock`. `--from` and `--to`
  go with `--payee-lock` alone.
- Each export is one SDK call (`invoices.evidence`, `milestones.evidence`, `invoices.receipt`, `payeeLock.evidence`,
  `closePacks.get`). The evidence reads' limit per key (EA6) applies: the SDK waits out a `429` as it waits out any.
- `evidence verify` takes any of the four formats. `close-pack verify` takes a close pack only, and says more about it
  (CE7).

**CE2. The file is the download's text.**
- An export writes the answer's `data` as `JSON.stringify(data, null, 2)`, with no newline after it. That is the text the
  workspace's **Download evidence** and **Download signed JSON** serve, built by the same builders. A file from the CLI
  and one from the workspace differ in what changed between the two reads (`exportedAt`, at least), and in how members
  are named: by user id through the API (EA3), by email in the workspace's download.
- Nothing in the document is changed, added or left out.

**CE3. Where the file goes.**
- By default it goes in the current directory, under the name the workspace's download gives it:
  - `vestiarion-evidence-<slug>-invoice-<id's first 8>.json`, or `-milestone-`;
  - `vestiarion-payee-lock-evidence-<slug>-<from, or all>-<to, or now>.json`;
  - `vestiarion-close-pack-<slug>-<YYYY-MM>.json`, with `-so-far` before `.json` for a month not ended;
  - a receipt has no download, so: `vestiarion-receipt-<slug>-<id's first 8>.json`.
- The slug comes from the document, and is cut to `a-z`, `0-9` and `-`, 40 characters at most, as the server's name
  functions cut it. Nothing else from the document reaches a path, so a slug like `../x` cannot leave the directory.
- `--out <file>` names the file instead. `--out -` writes the document to stdout and nothing else, every character
  outside ASCII as a JSON escape: it parses to the same document, so it verifies, and a shell that re-encodes what it
  captures, as Windows PowerShell 5.1's `>` does through the console's code page, cannot change a signed name (review,
  2026-11-02). A file saved with `--out` keeps the download's UTF-8 text.
- Before anything is sent, `--out` is refused (exit 1) when it ends in a slash, names a folder, or names a file in a
  folder that is not there, so no evidence read is spent on a file that cannot be written.
- A file that exists is never overwritten, unless `--force` is passed. When `--out` names one that exists, the CLI says
  so before it sends anything. A default name is known only from the answer, so that file is checked after the read.
- The file is written whole or not at all: to a new file beside the target, then renamed onto it. Without `--force` the
  target's name is claimed first with `wx`, so a file made meanwhile is not replaced either. A failed write leaves
  neither a short file nor, with `--force`, a truncated one.

**CE4. Arguments are checked before anything is sent.**
- `<YYYY-MM>` and `--from`, `--to` must have the shape `YYYY-MM` and `YYYY-MM-DD`, else a usage error (exit 1). The API
  judges the rest (a month to come, a `from` after `to`), answering `400`, which ends in exit 2 with its message.
- An id is passed as it is. The API answers one that is not a UUID `404` without spending a read (EA5); an unknown UUID
  spends one read, then answers `404`.
- A string option given twice, such as `--bill a --bill b`, is refused for every command: `node:util` would keep the
  last one unseen (review, 2026-11-02).

**CE5. What an export prints.**
- Text: the file's path and size, then one line on what it holds, then how to check it:
  - evidence: the subject's kind, title, payee and status;
  - receipt: ready, or not ready with its code and reason;
  - payee lock: the period and the number of address changes;
  - close pack: the month (and "so far"), the payments per token, and the pack's own warnings: `cut` (more than 2,000
    payments) and `unread`;
  - every one: the network, the number of signed entries carried, and the key ids.
- `--json`: `{ file, bytes, format, workspace, network, entries, keyIds }`, plus `subject`, `ready` and `notReady`,
  `period` and `changes`, or `month`, `cut`, `unread` and `totals`, by format. With `--out -`, the document itself.
- An export that saved its file exits 0, a receipt not ready included: the file is still a signed document. A script
  reads `ready` with `--json`.

**CE6. How a file is read for checking.**
- UTF-8, with or without a byte-order mark, or UTF-16 with its byte-order mark, as Windows PowerShell 5.1's `>` writes
  what `--out -` prints (CE3). A file over 256 MB, far more than any evidence file, is **NOT CHECKED** before it is read.
- A whole API answer, an object whose only field is `data`, is read as its `data`, and the answer says so. The SDK
  refuses one (it cannot tell a caller's mistake from intent); a file saved with `curl` is unambiguous.
- Keys: each `--public-key` file's PEM blocks, repeatable, each filed under its key id (the first 16 hex characters of
  SHA-256 over its SPKI DER, as the ledger names keys). A private key is refused: Node derives a public key from it,
  which would make a pasted private key look as if it worked. A key that is not Ed25519 is refused: it cannot have
  signed an entry. Without `--public-key`, the document's own keys check it, and the answer says so.
- The check is the SDK's `verifyEvidence(document, { keys, format })`. The CLI adds one check of its own: each key the
  file carries must be filed under its true id. The SDK never uses a key filed under another id, but a file the
  workspace made never holds one, so such a key is a problem and the answer is **BROKEN** (review, 2026-11-02).
- A big-endian UTF-16 file with an odd byte is **NOT CHECKED**, with its reason, never an unhandled error.

**CE7. What a check prints, and its exit code.**
- `ok: true` is **VALID**, exit 0. `ok: false` is **BROKEN**, exit 2. `ok: null` is **NOT CHECKED**, exit 2. A file that
  cannot be read, is not JSON, is not one of the four formats, or (for `close-pack verify`) is not a close pack, is
  **NOT CHECKED**, exit 2, with the reason. This is `vestiarion ledger verify`'s scheme.
- The first line names what was checked: the format, the workspace's slug, and the subject (a bill or milestone's
  title, a receipt's invoice id, a payee lock period, a close pack's month).
- Then the counts (`carried`, `verified`, `failed`, `unchecked`, `cited`), and `problems`. Entries with the same reason
  share one line, naming the first ten, so a month signed by a key not given reads as one line, not hundreds. When
  entries could not be checked, a line names the key they ask for beside the keys given.
- A line says that only the entries are signed: the file's own words around them, its name for the subject included,
  are not. The first line's subject is what the file calls itself.
- **Signed by.** The ids of the keys that signed the entries that verified, read from those entries. An entry verifies
  only under its key's true id, so these are the ids to compare with the Audit log. The ids the file lists are never
  printed as if they had signed: a file that carries the workspace's key beside another, with its entries signed by
  the other, names the other (review, 2026-11-02). Then whose keys checked it: `--public-key`'s, or the file's.
- A file that carries no signed entry says that nothing in it is signed.
- A close pack's totals and ledger head are the file's own words, which no signature covers: a check prints them
  as "The file states, outside the signatures", then how to tie the pack to the whole ledger: compare its entries with an
  audit export checked by `vestiarion ledger verify`.
- Then what an offline check cannot say: that the words follow from the entries, that the file carries every entry of
  its period, and anything on chain.
- `--json`: the SDK's `EvidenceVerification`, with the CLI's key check folded into `ok` and `problems`, plus `verdict`,
  `file`, `signedBy`, `keySource`, `unwrapped`. A file that could not be read answers the same shape, `ok: null`, every
  count 0 and its `reason` as the one problem, so a script reads `.counts` and `.problems` whatever the verdict.

**CE8. Text from outside is printed as text.** A vendor's name, a title or an invoice number came from outside. In text
output, control characters (C0, DEL and C1, which hold terminal escape sequences) are taken out of every such string
before it is printed, and so are the reasons a file could not be read: a JSON parse error quotes the file. `ledger
verify`'s lines get the same treatment. `--json` prints JSON, which escapes them.

**CE9. The SDK range, the lock and the version.**
- `cli/package.json` and the root `devDependencies` name `@vestiarion/sdk` `^0.4.1`, together
  (`tests/cli-package.test.ts` holds them equal). The lock's SDK entry moves to 0.4.1 by hand: its version, `resolved`
  and `integrity`, which equals the committed `public/sdk/vestiarion-sdk-0.4.1.tgz`. A plain `npm install` on this
  machine also rewrote unrelated optional entries, so it is not used.
- The CLI becomes 0.2.0 (`cli/package.json` and `cli/src/version.ts`), packed by `npm run cli:pack` into
  `public/cli/vestiarion-cli-0.2.0.tgz`, committed. 0.1.0's tarball stays. The partner publishes it after merge.

**CE10. Docs.** `content/docs/get-started/cli.mdx` (the commands table and a section on evidence and close packs, and the
install URL), `cli/README.md`, the evidence guide's offline check and the accountants guide's close pack, `CHANGELOG.md`
under [Unreleased], `docs/RELEASING.md`'s range sentence, and the SDK spec's EA14 (done). No API or webhook changes, so
no entry in `content/docs/changelog.mdx`.

## What it does not do

- No new endpoint, no write, no ledger entry. An export is a read; a verify sends nothing.
- No CSV: the CSV downloads carry no signatures and stay in the workspace.
- It does not check anything on chain: the receipt's and the evidence's own `onChain` checks are the server's.
