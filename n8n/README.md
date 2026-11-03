# @vestiarion/n8n-nodes-vestiarion

[Vestiarion](https://www.vestiarion.xyz) in [n8n](https://n8n.io): add bills for its AI agent to decide, read the agent's
decisions, and start a workflow on each ledger entry it signs.

- **Vestiarion** node: Bill Create and Get Many, Counterparty Get and Get Many, Decision Get Many, Workspace Get Status.
  It can be an n8n AI agent's tool. It never approves or pays: no API key can.
- **Vestiarion Trigger**: starts a workflow on each signed webhook delivery, after checking its `Vestiarion-Signature`.
  It takes Agent Decisions or Every Ledger Entry, filtered by domain and action.

The full guide: https://www.vestiarion.xyz/docs/get-started/n8n

## Install

In a self-hosted n8n: **Settings** > **Community nodes** > **Install**, then enter `@vestiarion/n8n-nodes-vestiarion`.
n8n Cloud lists only nodes n8n has verified, and this one is not yet.

## Credentials

One **Vestiarion API** credential:

| Field | What to put |
| --- | --- |
| API Key | A workspace API key, from the workspace's Settings page, under **API keys**. Adding bills needs one that can also add records. |
| Base URL | `https://www.vestiarion.xyz`, unless you run your own deployment. It must be https; plain http works only for localhost. |
| Webhook Signing Secret | For the trigger only: the secret Settings shows once when you add the webhook endpoint, `whsec_` included. |

n8n tests the credential with `GET /api/v1/status`. The key is sent as `Authorization: Bearer`, and the signing secret is
never sent anywhere.

## Operations

| Resource | Operation | API |
| --- | --- | --- |
| Bill | Create | `POST /api/v1/invoices`, as a payable |
| Bill | Get Many | `GET /api/v1/invoices?direction=payable` |
| Counterparty | Get | `GET /api/v1/counterparties/{id}` |
| Counterparty | Get Many | `GET /api/v1/counterparties` |
| Decision | Get Many | `GET /api/v1/ledger?actor=agent` |
| Workspace | Get Status | `GET /api/v1/status` |

A bill is decided by the agent as one typed into Vestiarion's console, with every guardrail. Give an **Idempotency Key**,
such as the invoice's ID in the tool it comes from, so a rerun within 24 hours adds it once.

Each Get Many has **Simplify**, on by default: a bill, a counterparty or a decision without the fields a workflow rarely
maps, hashes and signatures included. Decision: Get Many reads oldest first; for a scheduled read, pass the highest `seq`
handled as **After Seq**, and the last `cursor` as **After Cursor**.

## The trigger

The API cannot add a webhook endpoint, so you add the trigger's URL in Vestiarion by hand, once.

1. Add a **Vestiarion Trigger** to a workflow, with the credential, and copy its **Production URL**.
2. In Vestiarion, an owner or an admin opens **Settings** > **Webhooks** and adds an endpoint with that URL. It must be
   HTTPS, on port 443, at a public address: a self-hosted n8n needs a public HTTPS `N8N_WEBHOOK_URL`.
3. Settings shows the endpoint's signing secret once. Copy it, `whsec_` included, into the credential's **Webhook
   Signing Secret**.
4. Publish the workflow, so the Production URL is live.

**To try it before you publish:**
1. Add the trigger's **Test URL** as the endpoint instead, and copy its signing secret into the credential.
2. Choose **Listen for test event** in n8n, then **Send test** beside the endpoint in Settings, within two minutes. A test
   delivery has no `entry`.
3. Settings cannot change an endpoint's URL: remove that endpoint and add the **Production URL** as a new one.
4. The new endpoint has a new signing secret: put it in the credential.

Do not leave the Test URL's endpoint in place: every delivery fails while n8n is not listening, and Vestiarion disables
an endpoint after 20 failures in a row.

**Events** chooses Agent Decisions (the default) or Every Ledger Entry. **Options** narrows it further:
- **Domains**, such as Bills;
- **Actions**, such as `ap_hold, ap_flag_fraud`;
- **Include Test Deliveries**, on unless you turn it off.

A delivery whose signature does not match, or is more than 300 seconds old, is answered `401` and starts nothing. One the
trigger's options leave out is answered `200`, so Vestiarion does not send it again, and starts nothing either. Neither
shows anything in the editor while it listens for a test event.

## Usage

**Tell the team when the agent holds a bill.**
1. Add a Vestiarion Trigger with Events **Agent Decisions**, then, under Options, Domains **Bills** and Actions
   `ap_hold, ap_flag_fraud`.
2. Connect a Slack, Telegram or email node, with a message such as
   `{{ $json.entry.summary }}: {{ $json.entry.detail.decision.reasoning }}`.

**Add bills from a spreadsheet.**
1. Add a Google Sheets Trigger on new rows.
2. Connect Vestiarion: **Bill** > **Create**, with the counterparty's ID, the amount and the due date from the row.
3. Set **Idempotency Key** to the row's invoice number, so a row read twice within a day adds one bill.

**Read the agent's decisions on a schedule.**
1. Add a Schedule Trigger.
2. Connect Vestiarion: **Decision** > **Get Many**, with **After Seq** set to the highest `seq` the last run handled.

## Resources

- [The guide](https://www.vestiarion.xyz/docs/get-started/n8n): install, credentials, every operation and the trigger.
- [The API reference](https://www.vestiarion.xyz/docs/api) and [webhook payloads](https://www.vestiarion.xyz/docs/webhooks/payload).
- [n8n's community nodes documentation](https://docs.n8n.io/integrations/community-nodes/).
- [Source and issues](https://github.com/duongnq2798/vestiarion/tree/main/n8n).

## Compatibility

Built and tested against n8n 2.45 (`n8n-workflow` 2.45.4). Node 24 or later, as n8n needs.

## Version history

- **0.1.3**: from n8n's review: the trigger's Domains, Actions and Include Test Deliveries move into an Options
  collection, Bill > Create's Currency into Additional Fields (USDC when not set), and the trigger's setup notice into
  this README. A workflow saved with 0.1.2 needs those fields set again.
- **0.1.2**: the package's author email is one that receives mail, which n8n's Creator Portal writes to.
- **0.1.1**: the first version published from GitHub Actions with npm provenance, for n8n's verified listing. This
  README gains Usage, Resources and this history. The nodes are unchanged.
- **0.1.0**: the Vestiarion node and the Vestiarion Trigger.

## Licence

MIT
