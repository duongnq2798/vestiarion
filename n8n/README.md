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

1. Add a **Vestiarion Trigger** and copy its **Production URL**.
2. In Vestiarion, an owner or an admin adds it under **Settings** > **Webhooks**. It must be HTTPS, on port 443, at a
   public address.
3. Copy the signing secret Settings shows into the credential, then publish the workflow.

A delivery whose signature does not match, or is more than 300 seconds old, is answered `401` and starts nothing. One the
trigger's filters leave out is answered `200`, so Vestiarion does not send it again.

## Compatibility

Built and tested against n8n 2.45 (`n8n-workflow` 2.45.4). Node 24 or later, as n8n needs.

## Licence

MIT
