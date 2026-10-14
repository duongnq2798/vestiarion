# @vestiarion/cli

The [Vestiarion](https://www.vestiarion.xyz) API from a terminal:

- a workspace's status, bills, invoices, counterparties, milestones and treasury;
- the agent's decisions, with its reasoning;
- adding records, after showing what will be sent and asking first;
- offline checks of an audit export and of a webhook delivery's signature.

It runs on Node 20 or later and uses [`@vestiarion/sdk`](https://www.npmjs.com/package/@vestiarion/sdk), and nothing
else.

## Install

```bash
npm install --global @vestiarion/cli
vestiarion --help
```

Or run it without installing: `npx @vestiarion/cli --help`. Each version is also served as a tarball, such as
`https://www.vestiarion.xyz/cli/vestiarion-cli-0.1.0.tgz`, which `npm install --global` and `npx` take as they are.

## Log in

An owner or an admin creates a workspace API key on the workspace's Settings page, under **API keys**. Then:

```bash
vestiarion login            # asks for the key without showing it, checks it, saves it
vestiarion whoami           # the workspace, its network and where the key came from
```

`login` checks the key with one read, `GET /api/v1/status`, and saves it only if the API accepts it. It reads the key
from a hidden prompt, or from stdin with `--stdin`; it never takes it as an argument, so the key stays out of your shell
history.

The key for a command is the first of:

1. `--api-key <key>`;
2. the `VESTIARION_API_KEY` environment variable;
3. the profile saved by `vestiarion login`: `--profile <name>`, else `VESTIARION_PROFILE`, else `default`.

The API is `https://www.vestiarion.xyz` unless `--base-url` or `VESTIARION_BASE_URL` says otherwise. A profile keeps the
base URL its key was checked against: only its own key is sent there, and its key is sent nowhere else. With a
`--base-url` or `VESTIARION_BASE_URL` that names another API, a saved key is refused (exit 3); log in to that API under
another profile. Plain `http` is refused, except to localhost.

Profiles are saved in your user config file, readable by you alone:

- Windows: `%APPDATA%\vestiarion\config.json`, inside your user profile, whose permissions let only you,
  administrators and the system read it;
- macOS and Linux: `$XDG_CONFIG_HOME/vestiarion/config.json`, or `~/.config/vestiarion/config.json`, with mode 0600.

`vestiarion logout` removes a profile. The key itself keeps working until an owner or an admin revokes it in Settings.

The CLI never prints a key. It shows a key by its prefix, `vxk_<prefix>_…`, as Settings lists it.

## Commands

| Command | API |
| --- | --- |
| `vestiarion whoami` | `GET /api/v1/status` and `GET /api/v1/treasury` |
| `vestiarion status` | `GET /api/v1/status` |
| `vestiarion bills list` / `show <id>` / `add` | `GET` and `POST /api/v1/invoices`, payables |
| `vestiarion invoices list` / `show <id>` / `create` | `GET` and `POST /api/v1/invoices`, receivables |
| `vestiarion counterparties list` / `show <id>` / `add` | `GET /api/v1/counterparties`, `GET /api/v1/counterparties/{id}`, `POST /api/v1/counterparties` |
| `vestiarion milestones list` / `show <id>` / `add` | `GET` and `POST /api/v1/milestones` |
| `vestiarion payee-links create` | `POST /api/v1/payee-links` |
| `vestiarion decisions list` / `show <seq>` | `GET /api/v1/ledger?actor=agent` |
| `vestiarion ledger list` | `GET /api/v1/ledger` |
| `vestiarion ledger check` | `GET /api/v1/ledger/verify` |
| `vestiarion treasury` | `GET /api/v1/treasury` |
| `vestiarion insights` | `GET /api/v1/insights` |
| `vestiarion ledger verify <export.json>` | None: offline |
| `vestiarion webhooks verify` | None: offline |

`vestiarion <command> --help` lists a command's options. A few examples:

```bash
vestiarion bills list --status held
vestiarion bills show 9440f32c-000d-4a63-97f1-4eb6bf78439f
vestiarion decisions list --domain ap --all
vestiarion counterparties list --role vendor --json
```

Lists answer one page, as the API pages them. `--limit` sets its size, up to 200; `--cursor` continues from the cursor a
page printed; `--all` reads every page. The API has no single-record endpoint for invoices, milestones or ledger
entries, so `show` reads the list page by page until it finds the record. It stops looking after 10,000 records (the
most recent ones, or the agent's first 10,000 entries for `decisions show`); `list --all --json` reads further.

The API does not list webhook endpoints, and no key approves, rejects or pays anything, so neither does the CLI.

## Add records

A key with write access ("Can also add records") adds bills, invoices, counterparties, milestones and payee links:

```bash
vestiarion counterparties add --name "Quill Studio" --role vendor --address 0x5b2d8c1f0e7a4936b8d1c0e2f3a4b5c6d7e8f901 --payment-limit 500
vestiarion bills add --counterparty <id> --amount 420.00 --due 2026-10-31 --po PO-4012 --goods-received --idempotency-key billing-inv-42
vestiarion milestones add --contractor <id> --title "CSV export for EURC" --amount 150.00 --verification-source https://github.com/acme/app/pull/42
```

- **What will be sent is shown first.** Each write prints its method, URL, key prefix and body, says what follows, and
  asks `Send it? [y/N]`.
- **`--yes` sends without asking.** Without a terminal to ask in, and without `--yes`, nothing is sent.
- **A bill is decided by the agent.** It decides a bill as one typed into the console, with every guardrail; within its
  limits it may pay it. That is the agent's decision under the workspace's rules, not the CLI's.
- **An address waits.** One added this way waits for a person in the workspace to confirm it before the agent pays to it.
- **Reruns are safe with your own id.** `--idempotency-key` sends it as the `Idempotency-Key`, so running the same
  command again cannot add the record twice. Without it, each run sends a new key.

## Output and exit codes

Text is for reading. `--json` prints the API's answer as it came, `{ "data": … }` and, for a list, `"page"`, for `jq` and
scripts. An error goes to stderr, as `{ "error": { "message", "exitCode" } }` with `--json`.

| Exit code | Meaning |
| --- | --- |
| `0` | Done. |
| `1` | A usage error: an unknown command or option, a missing argument or value. |
| `2` | The API answered with an error, a check did not pass, or a write was not confirmed. |
| `3` | No key, a key not shaped like one, or a key the API refused (`401` or `403`). |

The API's own error message is printed as it is, with its status and code.

## Offline checks

Neither needs a key or a network.

```bash
vestiarion ledger verify vestiarion-acme-ledger-1042.json --public-key ledger-key.pem
vestiarion webhooks verify --signature "t=1760000000,v1=…" --body delivery.json   # the secret from VESTIARION_WEBHOOK_SECRET
```

`ledger verify` checks an audit export, downloaded from the Audit page: every entry's body hash and Ed25519 signature,
with the SDK's `verifyLedgerEntry`, then the links from genesis and the head. It gives the same answer as the standalone
`verify-ledger-export.mjs`: `VALID`, `BROKEN at` an entry, or `NOT CHECKED`. It exits `0` only when `VALID`.

`webhooks verify` checks a delivery's `Vestiarion-Signature` against its raw body with the endpoint's signing secret
(`--secret`, or `VESTIARION_WEBHOOK_SECRET`). Pass the body byte for byte as it arrived. A signature more than 300
seconds from now is refused; `--tolerance <seconds>` allows a delivery saved earlier.

## What it sends

- Every request carries the key as `Authorization: Bearer`, never in a URL, and
  `User-Agent: vestiarion-cli/<version> vestiarion-sdk-js/<version>`.
- It sends nothing else anywhere: no telemetry, no update checks.

The full guide: https://www.vestiarion.xyz/docs/get-started/cli

## Licence

MIT
