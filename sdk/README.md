# @vestiarion/sdk

A typed client for the [Vestiarion](https://www.vestiarion.xyz) API and its signed webhooks:

- every `/api/v1` endpoint, with its types;
- pagination that reads every page;
- retries that never add a record twice;
- checks for webhook signatures and ledger entries;
- offline checks of evidence, receipts and close packs.

It has no dependencies, and runs on Node 20 or later, Deno, Bun and edge runtimes such as Cloudflare Workers.

## Install

```bash
npm install @vestiarion/sdk
```

pnpm, Yarn and Bun install it the same way. The package is ESM only. Each version is also served as a tarball, such as
`https://www.vestiarion.xyz/sdk/vestiarion-sdk-0.4.0.tgz`, which `npm install` takes as it is.

## Read

```ts
import { Vestiarion } from "@vestiarion/sdk";

const vestiarion = new Vestiarion({ apiKey: process.env.VESTIARION_API_KEY! });

const status = await vestiarion.status.get();
const { data: held, page } = await vestiarion.invoices.list({ status: "held" });
const verification = await vestiarion.ledger.verify();

for await (const invoice of vestiarion.invoices.listAll({ direction: "payable" })) {
  console.log(invoice.id, invoice.status, invoice.agentReasoning);
}
```

An owner or admin creates a workspace API key on the workspace's Settings page. Keep it on a server: it reads the whole
workspace.

The workspace's signed files read the same way: one payment's evidence, a paid bill's receipt, the payee lock's
evidence for a period and a month's close pack. Each is the file the workspace's page downloads, with members named by
user id rather than email.

```ts
const evidence = await vestiarion.invoices.evidence("7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4e51");
const released = await vestiarion.milestones.evidence("7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4f61");
const receipt = await vestiarion.invoices.receipt("7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4e51");
const lock = await vestiarion.payeeLock.evidence({ from: "2026-10-01", to: "2026-10-31" });
const pack = await vestiarion.closePacks.get("2026-10");
```

A receipt that is not ready yet has `ready: false`, and `notReady.code` says why. These five reads share a limit per
key: 10 at once, then one every 6 seconds.

## Add records

A key with write access ("Can also add records") adds counterparties, invoices, milestones and payee links.
- The agent decides each invoice as it decides one typed into the console, with every guardrail.
- A milestone starts pending. GitHub verifies it once its pull request is merged, or a person does; then the agent decides.
- An address added this way, or entered by a payee through a link, waits for a person in the workspace to confirm it.

```ts
const counterparty = await vestiarion.counterparties.create(
  { name: "Quill Studio", role: "vendor", address: "0x5b2d8c1f0e7a4936b8d1c0e2f3a4b5c6d7e8f901", paymentLimit: "500" },
  { idempotencyKey: "crm-vendor-1042" }
);
const invoice = await vestiarion.invoices.create(
  { counterpartyId: counterparty.id, amount: "420.00", dueDate: "2026-10-31", poReference: "PO-4012", goodsReceived: true },
  { idempotencyKey: "billing-inv-2026-0042" }
);
```

Pass your own record's id as `idempotencyKey`, so that your own retries cannot add it twice either.

Pay a contributor when their pull request merges, and ask a new payee for their address:

```ts
const milestone = await vestiarion.milestones.create(
  { contractorId: contractor.id, title: "CSV export for EURC", amount: "150.00", verificationSource: "https://github.com/acme/app/pull/42" },
  { idempotencyKey: "pr-acme-app-42" }
);
const link = await vestiarion.payeeLinks.create({ counterpartyId: contractor.id });
// Send link.url to the payee: it is shown only in this answer.
```

A payee link takes no `idempotencyKey`: the API keeps only the link's hash, so a repeat makes a new link and the unused
one stops working.

## Errors and retries

Every failure is a `VestiarionError`. It carries:
- `status`;
- `code`: the API's error code, or `network_error`, `timeout` or `invalid_response`;
- `message`;
- `retryAfter`.

A request is retried twice by default after:
- a `429`, waiting as long as `Retry-After` says, up to 60 seconds;
- a `500`, `502`, `503` or `504`;
- a timeout or a network failure.

A write carries an `Idempotency-Key`, so retrying it never adds the record twice. A payee link is the exception: a retry
makes a new link, which replaces the first.

## Webhooks

```ts
import { verifyLedgerEntry, verifyWebhook } from "@vestiarion/sdk/webhooks";

export async function POST(request: Request) {
  const event = await verifyWebhook({
    secret: process.env.VESTIARION_WEBHOOK_SECRET!,
    payload: await request.text(),
    signature: request.headers.get("vestiarion-signature"),
  });
  if (event.entry) {
    const check = await verifyLedgerEntry(event.entry, process.env.VESTIARION_LEDGER_PUBLIC_KEY!);
    if (check.ok === false) return new Response(check.reason, { status: 400 });
  }
  return new Response(null, { status: 204 });
}
```

`verifyWebhook` throws a `WebhookVerificationError` unless the signature matches the raw body, signed less than 5
minutes ago. `verifyLedgerEntry` checks the entry's own Ed25519 signature and chain hash, with the public key from the
workspace's Audit page.

## Check evidence offline

```ts
import { verifyEvidence } from "@vestiarion/sdk";

const result = await verifyEvidence(pack, { keys: process.env.VESTIARION_LEDGER_PUBLIC_KEY! });
if (result.ok !== true) console.error(result.problems);
```

`verifyEvidence` takes any of these files, an API answer's `data` or a download from the workspace, and checks it with
Web Crypto alone: every entry's signature, that every entry a fact cites is in the file, that entries next to each other
in the ledger link, and that a row's copy of its entry matches it. `ok` is `true` when all of that holds, `false` when
something does not (`problems` says what), and `null` when nothing failed but some entry was signed by a key you did
not pass. Without `keys` it uses the keys the file carries, and says so: that proves the entries were not changed after
they were signed, not that the keys are the workspace's.

The full guide: https://www.vestiarion.xyz/docs/get-started/sdk

## Licence

MIT
